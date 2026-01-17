const { app, BrowserWindow, screen } = require('electron');

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
const EXPRESSIONS = ['normal', 'smile', 'eye_sparkle', 'suprise', 'shock'];

const MESSAGES = {
  SESSION_START: 'やあ、ぼくずんだもんなのだ！今日もよろしくなのだ！',
  SESSION_END: 'おつかれさまなのだ！またねなのだ！',
  LONG_MESSAGE_FALLBACK: '作業が完了したのだ、詳細はターミナルを確認するのだ',
  PERMISSION_REQUEST: 'これ実行していいのだ？',
};

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
let currentAbortController = null;

function stopCurrentPlayback() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
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
  debugLog(`speakWithVoicevox called: ${text}`);
  stopCurrentPlayback();

  const abortController = new AbortController();
  currentAbortController = abortController;

  const truncatedText = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) + '...' : text;

  try {
    debugLog(`Calling VOICEVOX audio_query...`);
    const queryRes = await fetch(
      `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(truncatedText)}&speaker=${SPEAKER_ID}`,
      { method: 'POST', signal: abortController.signal }
    );
    debugLog(`audio_query response status: ${queryRes.status}`);

    if (!queryRes.ok) throw new Error(`Audio query failed: ${queryRes.status}`);

    const query = await queryRes.json();
    query.speedScale = VOICEVOX_SPEED_SCALE;
    debugLog(`Got query, calling synthesis...`);

    if (abortController.signal.aborted) return;

    const synthesisRes = await fetch(
      `${VOICEVOX_URL}/synthesis?speaker=${SPEAKER_ID}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
        signal: abortController.signal,
      }
    );

    debugLog(`synthesis response status: ${synthesisRes.status}`);
    if (!synthesisRes.ok) throw new Error(`Synthesis failed: ${synthesisRes.status}`);
    if (abortController.signal.aborted) return;

    debugLog(`Getting audio buffer...`);
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

      proc.stderr.on('data', (data) => {
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
    debugLog(`speakWithVoicevox error: ${error.name} - ${error.message}`);
    if (error.name === 'AbortError') {
      console.log('Speech synthesis cancelled');
      return;
    }
    if (error.message && error.message.includes('ECONNREFUSED')) {
      console.error('VOICEVOX is not running! Please start VOICEVOX first.');
    } else {
      console.error('Speech error:', error);
    }
  }
}

// ========== メッセージフォーマット ==========
const EXPRESSION_KEYWORDS = {
  shock: ['error', 'failed', 'exception', 'crash', 'fatal', 'エラー', '失敗', '問題', 'だめ', '無理', '壊れ'],
  smile: ['完了', '成功', 'done', 'success', 'passed', 'ok', 'できた', 'やった', 'よし', 'いいね', 'ばっちり'],
  eye_sparkle: ['見つけ', 'found', '発見', 'ある', 'いた', 'なるほど', 'わかった', '理解', 'ひらめ'],
  suprise: ['おお', 'すごい', 'wow', 'amazing', '！', 'えっ', 'まじ', '本当', 'びっくり'],
  normal: [],
};

const EXPRESSION_PRIORITY = ['shock', 'smile', 'eye_sparkle', 'suprise'];

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
    return convertReadings(MESSAGES.LONG_MESSAGE_FALLBACK);
  }

  if (data.hook_event_name === 'SessionStart') {
    notifyExpression('smile', EXPRESSION_DURATION_MS);
    return convertReadings(MESSAGES.SESSION_START);
  }

  if (data.hook_event_name === 'SessionEnd') {
    notifyExpression('smile', EXPRESSION_DURATION_MS);
    return convertReadings(MESSAGES.SESSION_END);
  }

  if (data.hook_event_name === 'PermissionRequest') {
    notifyExpression('suprise', EXPRESSION_DURATION_MS);
    return convertReadings(MESSAGES.PERMISSION_REQUEST);
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
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
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
  // サーバー初期化・起動
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

  // ウィンドウ作成
  debugLog('Creating window...');
  createWindow();
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
    if (server) server.close();
  } catch (e) {
    // ignore
  }
});

} // end normal boot
