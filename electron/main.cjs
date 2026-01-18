const { app, BrowserWindow, screen, ipcMain } = require('electron');

// GPU関連のクラッシュを避ける設定
// `disable-gpu` と `disable-software-rasterizer` を同時に立てると逃げ道が無くなり不安定化しやすい。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
// macOSでは `--no-sandbox` は不要かつ挙動が不安定になりやすいので付けない
if (process.platform !== 'darwin') {
  app.commandLine.appendSwitch('no-sandbox');
}
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const os = require('os');

// デバッグログをファイルに書き出す
const syncFs = require('fs');
const logFile = path.join(os.homedir(), 'zundamon-debug.log');
function debugLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    syncFs.appendFileSync(logFile, line);
  } catch (e) {
    console.error('Log write failed:', e.message);
  }
  console.log(msg);
}
try {
  syncFs.writeFileSync(logFile, '');
  console.log('Log file created at:', logFile);
} catch (e) {
  console.error('Could not create log file:', e.message);
}
debugLog('=== Zundamon starting ===');
debugLog(`__dirname: ${__dirname}`);
debugLog(`resourcesPath: ${process.resourcesPath}`);

// プロセスエラーハンドラ
process.on('uncaughtException', (err) => {
  debugLog(`Uncaught exception: ${err.message}`);
  debugLog(err.stack);
});

process.on('unhandledRejection', (reason) => {
  debugLog(`Unhandled rejection: ${reason}`);
});

process.on('exit', (code) => {
  debugLog(`Process exit with code: ${code}`);
});

process.on('SIGTERM', () => {
  debugLog('Received SIGTERM');
});

process.on('SIGINT', () => {
  debugLog('Received SIGINT');
});

// ------------------------------------------------------------
// Minimal boot mode (切り分け用)
// ------------------------------------------------------------
// パッケージ版だけV8でSIGTRAPする原因を切り分けるため、
// ほぼ何もしない起動パスを用意する。
// 使い方: ZUNDAMON_MINIMAL_BOOT=1 で起動
if (process.env.ZUNDAMON_MINIMAL_BOOT === '1') {
  debugLog('ZUNDAMON_MINIMAL_BOOT=1 (minimal boot enabled)');

  function createMinimalWindow() {
    const win = new BrowserWindow({
      width: 320,
      height: 240,
      show: true,
      webPreferences: {
        // まずは最小にして外部要因を減らす
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    win.loadURL('data:text/html,<html><body><h3>Minimal boot OK</h3></body></html>');
  }

  debugLog('Setting up app.whenReady (minimal)...');
  app.whenReady()
    .then(() => {
      debugLog('app.whenReady fired (minimal)');
      createMinimalWindow();
    })
    .catch((err) => {
      debugLog(`app.whenReady error (minimal): ${err.message}`);
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMinimalWindow();
  });
}

// 通常起動パス（minimal boot時は実行しない）
if (process.env.ZUNDAMON_MINIMAL_BOOT !== '1') {

// ========== 定数 ==========
const PORT = 3456;
const VOICEVOX_URL = process.env.VOICEVOX_URL || 'http://127.0.0.1:50021';
const SPEAKER_ID = process.env.VOICEVOX_SPEAKER_ID || '3';
const EXPRESSION_DURATION_MS = 3000;
const SHORT_MESSAGE_THRESHOLD = 300;
const MAX_TEXT_LENGTH = 200;
const VOICEVOX_SPEED_SCALE = 1.2;
const DEFAULT_AUDIO_DURATION_MS = 2000;
const LIPSYNC_INTERVAL_MS = 120;
const EXPRESSIONS = ['normal', 'smile', 'eye_sparkle', 'surprise', 'shock'];

// Session Watcher 定数
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SESSION_DEBOUNCE_MS = 100;

const MESSAGES = {
  SESSION_START: 'やあ、ぼくずんだもんなのだ！今日もよろしくなのだ！',
  SESSION_END: 'おつかれさまなのだ！またねなのだ！',
  LONG_MESSAGE_FALLBACK: '作業が完了したのだ、詳細はターミナルを確認するのだ',
  PERMISSION_REQUEST: 'これ実行していいのだ？',
  ERROR_BASH: 'あれ、エラーが出ちゃったのだ！',
  ERROR_BUILD: 'ビルドが失敗したのだ！',
  ERROR_TEST: 'テストが失敗したのだ！',
};

function getProjectPrefix(data) {
  if (data.project) {
    return `${data.project}で、`;
  }
  return '';
}

function getProjectMessage(data, eventName) {
  const project = data.project;
  if (project && config.projectMessages && config.projectMessages[project]) {
    const projectMsg = config.projectMessages[project][eventName];
    if (projectMsg) return projectMsg;
  }
  return null;
}

// ========== 設定読み込み ==========
function getConfigPath() {
  // ビルド後は resources/config に、開発時は ../config に
  const prodPath = path.join(process.resourcesPath || '', 'config', 'zundamon.json');
  const devPath = path.join(__dirname, '..', 'config', 'zundamon.json');

  if (require('fs').existsSync(prodPath)) return prodPath;
  return devPath;
}

function loadConfig() {
  const configPath = getConfigPath();
  debugLog(`Loading config from: ${configPath}`);
  try {
    const raw = require('fs').readFileSync(configPath, 'utf-8');
    debugLog('Config loaded successfully');
    return JSON.parse(raw);
  } catch (e) {
    debugLog(`Config error: ${e.message}`);
    return {
      speakEvents: { tools: [], events: ['SessionStart', 'SessionEnd', 'AssistantMessage'] },
      readings: {}
    };
  }
}

debugLog('About to load config...');
const config = loadConfig();
debugLog('Config load complete');

function shouldSpeakEvent(eventName) {
  return config.speakEvents.events.includes(eventName);
}

function convertReadings(text) {
  let result = text;
  for (const [key, reading] of Object.entries(config.readings || {})) {
    const regex = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(regex, reading);
  }
  return result;
}

// ========== WebSocketクライアント管理 ==========
const clients = new Set();

function broadcast(message) {
  // server初期化前は何もしない
  if (!WebSocket) return;
  const json = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

function notifyLipsyncStart(duration) {
  console.log(`[Lipsync] Starting, duration=${duration}ms, clients=${clients.size}`);
  broadcast({ type: 'lipsync-start', duration });
}

function notifyLipsyncStop() {
  broadcast({ type: 'lipsync-stop' });
}

function notifyExpression(name, duration) {
  broadcast({ type: 'expression', name, duration });
}



// ========== 音声合成 ==========
let currentPlayProcess = null;
let currentTempFile = null;
let speechQueue = Promise.resolve();

function enqueueSpeech(task) {
  // 直列化して AbortError を潰す（イベントが連続しても読み上げが飛ばない）
  speechQueue = speechQueue
    .then(task)
    .catch((err) => {
      debugLog(`Speech queue error: ${err?.message || err}`);
    });
  return speechQueue;
}

function stopCurrentPlayback() {
  if (currentPlayProcess) {
    console.log('Stopping previous playback...');
    currentPlayProcess.kill();
    currentPlayProcess = null;
    notifyLipsyncStop();
  }
  if (currentTempFile) {
    fs.unlink(currentTempFile).catch(() => {});
    currentTempFile = null;
  }
}

function getWavDuration(buffer) {
  try {
    const byteRate = buffer.readUInt32LE(28);
    let dataSize = 0;
    for (let i = 0; i < buffer.length - 8; i++) {
      if (buffer[i] === 0x64 && buffer[i + 1] === 0x61 && buffer[i + 2] === 0x74 && buffer[i + 3] === 0x61) {
        dataSize = buffer.readUInt32LE(i + 4);
        break;
      }
    }
    if (dataSize === 0 || byteRate === 0) return DEFAULT_AUDIO_DURATION_MS;
    return Math.floor((dataSize / byteRate) * 1000);
  } catch (e) {
    return DEFAULT_AUDIO_DURATION_MS;
  }
}

async function speakWithVoicevox(text) {
  return enqueueSpeech(async () => {
    debugLog(`speakWithVoicevox called: ${text}`);

    const truncatedText = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) + '...' : text;

    try {
      debugLog('Calling VOICEVOX audio_query...');
      const queryRes = await fetch(
        `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(truncatedText)}&speaker=${SPEAKER_ID}`,
        { method: 'POST' }
      );
      debugLog(`audio_query response status: ${queryRes.status}`);

      if (!queryRes.ok) throw new Error(`Audio query failed: ${queryRes.status}`);

      const query = await queryRes.json();
      query.speedScale = VOICEVOX_SPEED_SCALE;
      debugLog('Got query, calling synthesis...');

      const synthesisRes = await fetch(
        `${VOICEVOX_URL}/synthesis?speaker=${SPEAKER_ID}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(query),
        }
      );

      debugLog(`synthesis response status: ${synthesisRes.status}`);
      if (!synthesisRes.ok) throw new Error(`Synthesis failed: ${synthesisRes.status}`);

      debugLog('Getting audio buffer...');
      const audioBuffer = await synthesisRes.arrayBuffer();
      debugLog(`Audio buffer size: ${audioBuffer.byteLength}`);
      const tempFile = path.join(os.tmpdir(), `claude-voice-${Date.now()}.wav`);
      const audioData = Buffer.from(audioBuffer);
      await fs.writeFile(tempFile, audioData);
      currentTempFile = tempFile;

      const durationMs = getWavDuration(audioData);
      notifyLipsyncStart(durationMs);

      const playCommand = process.platform === 'darwin' ? 'afplay' : 'aplay';
      debugLog(`Playing audio: ${playCommand} ${tempFile}`);

      await new Promise((resolve, reject) => {
        const proc = spawn(playCommand, [tempFile]);
        currentPlayProcess = proc;

        proc.stderr?.on?.('data', (data) => {
          debugLog(`afplay stderr: ${data}`);
        });

        proc.on('close', (code) => {
          debugLog(`afplay exited with code: ${code}`);
          if (currentPlayProcess === proc) currentPlayProcess = null;
          notifyLipsyncStop();
          if (currentTempFile === tempFile) {
            fs.unlink(tempFile).catch(() => {});
            currentTempFile = null;
          }
          resolve();
        });

        proc.on('error', (err) => {
          if (currentPlayProcess === proc) currentPlayProcess = null;
          notifyLipsyncStop();
          reject(err);
        });
      });
    } catch (error) {
      debugLog(`speakWithVoicevox error: ${error?.name} - ${error?.message}`);
      if (error?.message && String(error.message).includes('ECONNREFUSED')) {
        console.error('VOICEVOX is not running! Please start VOICEVOX first.');
      } else {
        console.error('Speech error:', error);
      }
    }
  });
}

// ========== メッセージフォーマット ==========
const EXPRESSION_KEYWORDS = {
  shock: ['error', 'failed', 'exception', 'crash', 'fatal', 'エラー', '失敗', '問題', 'だめ', '無理', '壊れ'],
  smile: ['完了', '成功', 'done', 'success', 'passed', 'ok', 'できた', 'やった', 'よし', 'いいね', 'ばっちり'],
  eye_sparkle: ['見つけ', 'found', '発見', 'ある', 'いた', 'なるほど', 'わかった', '理解', 'ひらめ'],
  surprise: ['おお', 'すごい', 'wow', 'amazing', '！', 'えっ', 'まじ', '本当', 'びっくり'],
  normal: [],
};

const EXPRESSION_PRIORITY = ['shock', 'smile', 'eye_sparkle', 'surprise'];

function detectExpression(message) {
  const lowerMsg = message.toLowerCase();
  for (const expression of EXPRESSION_PRIORITY) {
    const keywords = EXPRESSION_KEYWORDS[expression];
    if (keywords.some(kw => lowerMsg.includes(kw.toLowerCase()))) {
      return expression;
    }
  }
  return 'normal';
}

function processMessage(message) {
  const expression = detectExpression(message);
  notifyExpression(expression, EXPRESSION_DURATION_MS);
  return convertReadings(message);
}

async function formatClaudeMessage(data) {
  if (data.hook_event_name === 'AssistantMessage' && data.message) {
    if (!shouldSpeakEvent('AssistantMessage')) return null;

    if (data.message.length < SHORT_MESSAGE_THRESHOLD) {
      return processMessage(data.message);
    }

    notifyExpression('smile', EXPRESSION_DURATION_MS);
    return convertReadings(getProjectPrefix(data) + MESSAGES.LONG_MESSAGE_FALLBACK);
  }

  if (data.hook_event_name === 'SessionStart') {
    notifyExpression('smile', EXPRESSION_DURATION_MS);
    const customMsg = getProjectMessage(data, 'SessionStart');
    return convertReadings(customMsg || (getProjectPrefix(data) + MESSAGES.SESSION_START));
  }

  if (data.hook_event_name === 'SessionEnd') {
    notifyExpression('smile', EXPRESSION_DURATION_MS);
    const customMsg = getProjectMessage(data, 'SessionEnd');
    return convertReadings(customMsg || (getProjectPrefix(data) + MESSAGES.SESSION_END));
  }

  if (data.hook_event_name === 'PermissionRequest') {
    notifyExpression('surprise', EXPRESSION_DURATION_MS);
    return convertReadings(getProjectPrefix(data) + MESSAGES.PERMISSION_REQUEST);
  }

  // PostToolUse: Bashコマンドのエラー検出
  if (data.tool_name === 'Bash' && data.tool_error) {
    const command = data.tool_input?.command || '';
    notifyExpression('shock', EXPRESSION_DURATION_MS);

    // ビルド系コマンドの検出
    if (/\b(build|compile|tsc|webpack|vite|esbuild)\b/i.test(command)) {
      return convertReadings(getProjectPrefix(data) + MESSAGES.ERROR_BUILD);
    }
    // テスト系コマンドの検出
    if (/\b(test|jest|vitest|mocha|pytest|rspec)\b/i.test(command)) {
      return convertReadings(getProjectPrefix(data) + MESSAGES.ERROR_TEST);
    }
    // その他のエラー
    return convertReadings(getProjectPrefix(data) + MESSAGES.ERROR_BASH);
  }

  return null;
}

// ========== Express サーバー ==========
// NOTE:
// Electronの初期化より前に大量の依存(require)やHTTPサーバー初期化を走らせると、
// 環境によってはパッケージ版だけ不安定になるケースがあるため、whenReady後に遅延初期化する。
let express;
let http;
let WebSocketServer;
let WebSocket;
let expressApp;
let server;
let wss;

function initServer() {
  debugLog('Initializing server dependencies...');
  express = require('express');
  http = require('http');
  ({ WebSocketServer, WebSocket } = require('ws'));

  debugLog('Creating Express app...');
  expressApp = express();
  debugLog('Creating HTTP server...');
  server = http.createServer(expressApp);
  debugLog('Creating WebSocketServer...');
  wss = new WebSocketServer({ server });
  debugLog('Server setup complete');

  wss.on('connection', (ws) => {
    console.log('Client connected');
    clients.add(ws);
    ws.on('close', () => {
      console.log('Client disconnected');
      clients.delete(ws);
    });
  });

  expressApp.use(express.json());

  expressApp.post('/speak', async (req, res) => {
    try {
      const hookData = req.body;
      console.log('Received hook data:', JSON.stringify(hookData, null, 2));

      const message = await formatClaudeMessage(hookData);

      if (message) {
        console.log(`Speaking: ${message}`);
        await speakWithVoicevox(message);
      }

      res.json({ success: true, message });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  expressApp.post('/speak/text', async (req, res) => {
    try {
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: 'text is required' });

      console.log(`Speaking: ${text}`);
      await speakWithVoicevox(text);
      res.json({ success: true });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  expressApp.post('/expression', (req, res) => {
    const { name, duration } = req.body;
    if (!name || !EXPRESSIONS.includes(name)) {
      return res.status(400).json({ error: `name must be one of: ${EXPRESSIONS.join(', ')}` });
    }
    const durationMs = duration || EXPRESSION_DURATION_MS;
    console.log(`Expression: ${name} (${durationMs}ms)`);
    notifyExpression(name, durationMs);
    res.json({ success: true, expression: name });
  });

  expressApp.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'ボクはずんだもんなのだ！元気に動いてるのだ！' });
  });
}

// ========== Session Watcher ==========
// Claude Codeのセッションファイルを監視してアシスタントメッセージを読み上げる
const sessionWatcher = {
  processedMessages: new Set(),
  filePositions: new Map(),
  debounceTimer: null,
  watchers: [],

  extractTextFromContent(content) {
    if (!Array.isArray(content)) return null;
    const textParts = content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text);
    return textParts.length > 0 ? textParts.join('\n') : null;
  },

  async processNewLines(filePath) {
    try {
      const stats = syncFs.statSync(filePath);
      const lastPosition = this.filePositions.get(filePath) || 0;

      if (stats.size <= lastPosition) return;

      this.filePositions.set(filePath, stats.size);

      const buffer = Buffer.alloc(stats.size - lastPosition);
      const fd = syncFs.openSync(filePath, 'r');
      syncFs.readSync(fd, buffer, 0, buffer.length, lastPosition);
      syncFs.closeSync(fd);

      const content = buffer.toString('utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const data = JSON.parse(line);

          if (
            data.type === 'assistant' &&
            data.message?.role === 'assistant' &&
            !this.processedMessages.has(data.uuid)
          ) {
            const text = this.extractTextFromContent(data.message.content);

            if (text) {
              debugLog(`[SessionWatcher] New message: ${text.substring(0, 50)}...`);

              // formatClaudeMessageを使ってメッセージを整形
              const formattedMessage = await formatClaudeMessage({
                hook_event_name: 'AssistantMessage',
                message: text,
              });

              if (formattedMessage) {
                await speakWithVoicevox(formattedMessage);
              }

              this.processedMessages.add(data.uuid);
            }
          }
        } catch (e) {
          // JSON parse error - skip incomplete lines
        }
      }
    } catch (err) {
      debugLog(`[SessionWatcher] Error processing file: ${err.message}`);
    }
  },

  findLatestSessionFile(projectDir) {
    try {
      const files = syncFs.readdirSync(projectDir);
      const jsonlFiles = files
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({
          name: f,
          path: path.join(projectDir, f),
          mtime: syncFs.statSync(path.join(projectDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      return jsonlFiles.length > 0 ? jsonlFiles[0].path : null;
    } catch {
      return null;
    }
  },

  startWatching() {
    debugLog('[SessionWatcher] Starting...');

    if (!syncFs.existsSync(CLAUDE_PROJECTS_DIR)) {
      debugLog(`[SessionWatcher] Projects dir not found: ${CLAUDE_PROJECTS_DIR}`);
      return;
    }

    // 全プロジェクトディレクトリを監視
    const projectDirs = syncFs.readdirSync(CLAUDE_PROJECTS_DIR)
      .map((name) => path.join(CLAUDE_PROJECTS_DIR, name))
      .filter((p) => syncFs.statSync(p).isDirectory());

    debugLog(`[SessionWatcher] Found ${projectDirs.length} project directories`);

    for (const projectDir of projectDirs) {
      this.watchProjectDir(projectDir);
    }

    // 新しいプロジェクトディレクトリの監視
    const mainWatcher = syncFs.watch(CLAUDE_PROJECTS_DIR, (eventType, filename) => {
      if (!filename) return;
      const newDir = path.join(CLAUDE_PROJECTS_DIR, filename);
      if (syncFs.existsSync(newDir) && syncFs.statSync(newDir).isDirectory()) {
        this.watchProjectDir(newDir);
      }
    });
    this.watchers.push(mainWatcher);
  },

  watchProjectDir(projectDir) {
    let currentSessionFile = this.findLatestSessionFile(projectDir);

    if (currentSessionFile) {
      // 既存内容をスキップ
      this.filePositions.set(currentSessionFile, syncFs.statSync(currentSessionFile).size);
      debugLog(`[SessionWatcher] Watching: ${path.basename(projectDir)}`);
    }

    try {
      const watcher = syncFs.watch(projectDir, (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;

        if (this.debounceTimer) clearTimeout(this.debounceTimer);

        this.debounceTimer = setTimeout(async () => {
          const latestFile = this.findLatestSessionFile(projectDir);

          if (latestFile && latestFile !== currentSessionFile) {
            debugLog(`[SessionWatcher] New session: ${path.basename(latestFile)}`);
            currentSessionFile = latestFile;
            this.filePositions.set(currentSessionFile, 0);
          }

          if (currentSessionFile && syncFs.existsSync(currentSessionFile)) {
            await this.processNewLines(currentSessionFile);
          }
        }, SESSION_DEBOUNCE_MS);
      });

      this.watchers.push(watcher);
    } catch (err) {
      debugLog(`[SessionWatcher] Error watching ${projectDir}: ${err.message}`);
    }
  },

  stop() {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    debugLog('[SessionWatcher] Stopped');
  },
};

// ========== Electron ==========
let mainWindow;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const windowWidth = 300;
  const windowHeight = 400;

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: screenWidth - windowWidth - 20,
    y: screenHeight - windowHeight - 20,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    roundedCorners: false,
    show: true, // 即座に表示
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // 準備完了時に表示
  mainWindow.once('ready-to-show', () => {
    debugLog('Window ready-to-show');
    mainWindow.show();
  });

  const htmlPath = path.join(__dirname, 'index.html');
  debugLog(`Loading HTML from: ${htmlPath}`);
  mainWindow.loadFile(htmlPath);
  mainWindow.setIgnoreMouseEvents(false);
  debugLog('Window created successfully');

  // 開発時はDevTools開く
  // mainWindow.webContents.openDevTools({ mode: 'detach' });
}

debugLog('Setting up app.whenReady...');

app.whenReady().then(() => {
  debugLog('app.whenReady fired');

  // ウィンドウ作成を最優先で実行
  debugLog('Creating window...');
  createWindow();

  // サーバー初期化・起動（ウィンドウ表示後に非同期で）
  setImmediate(() => {
    initServer();
    server.listen(PORT, () => {
      debugLog(`Server listening on port ${PORT}`);
      console.log(`
╔════════════════════════════════════════╗
║   ずんだもん VTuber Avatar             ║
║   Server: http://localhost:${PORT}        ║
╚════════════════════════════════════════╝

Make sure VOICEVOX is running on http://localhost:50021
      `);
    });

    // Session Watcher開始
    sessionWatcher.startWatching();
  });
}).catch(err => {
  debugLog(`app.whenReady error: ${err.message}`);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('quit', () => {
  try {
    sessionWatcher.stop();
    if (server) server.close();
  } catch (e) {
    // ignore
  }
});

} // end normal boot
