/**
 * Claude Code セッションファイルを監視して
 * アシスタントのメッセージを読み上げサーバーに送信する
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DEFAULT_SERVER_PORT, DEBOUNCE_MS } from "../src/constants.js";

const SPEAK_SERVER = process.env.SPEAK_SERVER || `http://localhost:${DEFAULT_SERVER_PORT}/speak`;
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// 処理済みのメッセージUUIDを記録
const processedMessages = new Set<string>();

// 最後に読んだファイルサイズを記録
const filePositions = new Map<string, number>();

// デバウンス用
let debounceTimer: NodeJS.Timeout | null = null;

interface MessageContent {
  type: string;
  text?: string;
  thinking?: string;
}

interface SessionMessage {
  uuid: string;
  type: string;
  message?: {
    role: string;
    content: MessageContent[];
    stop_reason?: string;
  };
  timestamp: string;
}

async function sendToSpeakServer(message: string): Promise<void> {
  try {
    const response = await fetch(SPEAK_SERVER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "AssistantMessage",
        message: message,
      }),
    });

    if (!response.ok) {
      console.error(`Failed to send message: ${response.status}`);
    }
  } catch (error) {
    console.error("Error sending to speak server:", error);
  }
}

function extractTextFromContent(content: MessageContent[]): string | null {
  const textParts = content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text as string);

  return textParts.length > 0 ? textParts.join("\n") : null;
}

async function processNewLines(filePath: string): Promise<void> {
  const stats = fs.statSync(filePath);
  const lastPosition = filePositions.get(filePath) || 0;

  if (stats.size <= lastPosition) {
    return;
  }

  // 先にファイル位置を更新して重複読み取りを防ぐ
  filePositions.set(filePath, stats.size);

  // バッファとして新しい部分だけ読み取る
  const buffer = Buffer.alloc(stats.size - lastPosition);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
  fs.closeSync(fd);

  const content = buffer.toString("utf-8");
  const lines = content.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const data: SessionMessage = JSON.parse(line);

      // アシスタントメッセージで、テキストがあり、まだ処理していないもの
      if (
        data.type === "assistant" &&
        data.message?.role === "assistant" &&
        !processedMessages.has(data.uuid)
      ) {
        const text = extractTextFromContent(data.message.content);

        if (text) {
          console.log(`[${new Date().toISOString()}] New message detected`);
          console.log(`  UUID: ${data.uuid}`);
          console.log(`  Preview: ${text.substring(0, 100)}...`);

          await sendToSpeakServer(text);
          processedMessages.add(data.uuid);
        }
      }
    } catch (e) {
      // JSON parse error - skip incomplete lines
    }
  }
}

function findLatestSessionFile(projectDir: string): string | null {
  try {
    const files = fs.readdirSync(projectDir);
    const jsonlFiles = files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        name: f,
        path: path.join(projectDir, f),
        mtime: fs.statSync(path.join(projectDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return jsonlFiles.length > 0 ? jsonlFiles[0].path : null;
  } catch {
    return null;
  }
}

function getProjectDirName(cwd: string): string {
  // /Users/foo/Projects/bar -> -Users-foo-Projects-bar
  return cwd.replace(/\//g, "-").replace(/^-/, "-");
}

async function watchProject(cwd: string): Promise<void> {
  const projectDirName = getProjectDirName(cwd);
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectDirName);

  console.log(`Watching project: ${cwd}`);
  console.log(`Project dir: ${projectDir}`);

  if (!fs.existsSync(projectDir)) {
    console.error(`Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  let currentSessionFile = findLatestSessionFile(projectDir);

  if (currentSessionFile) {
    console.log(`Current session file: ${path.basename(currentSessionFile)}`);
    // 既存の内容をスキップするため、現在のサイズを記録
    filePositions.set(currentSessionFile, fs.statSync(currentSessionFile).size);
  }

  // ディレクトリを監視（デバウンス付き）
  fs.watch(projectDir, (eventType, filename) => {
    if (!filename) return;
    if (!filename.endsWith(".jsonl")) return;

    // デバウンス: 連続したイベントをまとめる
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(async () => {
      const latestFile = findLatestSessionFile(projectDir);

      if (latestFile && latestFile !== currentSessionFile) {
        console.log(`New session detected: ${path.basename(latestFile)}`);
        currentSessionFile = latestFile;
        filePositions.set(currentSessionFile, 0);
      }

      if (currentSessionFile && fs.existsSync(currentSessionFile)) {
        await processNewLines(currentSessionFile);
      }
    }, DEBOUNCE_MS);
  });

  console.log("Session watcher started. Press Ctrl+C to stop.");
}

// メイン
const cwd = process.argv[2] || process.cwd();
watchProject(cwd);
