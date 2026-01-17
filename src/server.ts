import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { speakWithVoicevox } from "./voicevox.js";
import { formatClaudeMessage } from "./formatter.js";
import { connectToVTS, isConnected } from "./vtube-studio.js";
import { addClient, removeClient, notifyExpression } from "./lipsync-notifier.js";
import { EXPRESSIONS, EXPRESSION_DURATION_MS, DEFAULT_SERVER_PORT } from "./constants.js";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || DEFAULT_SERVER_PORT;

wss.on("connection", (ws) => {
  addClient(ws);
  ws.on("close", () => removeClient(ws));
});

app.use(express.json());

// Claude Code hooks からのリクエストを受け取る
app.post("/speak", async (req, res) => {
  try {
    const hookData = req.body;
    console.log("Received hook data:", JSON.stringify(hookData, null, 2));

    // Claude の出力をスピーチ用に整形（LLM要約対応）
    const message = await formatClaudeMessage(hookData);

    if (message) {
      console.log(`Speaking: ${message}`);
      await speakWithVoicevox(message);
    }

    res.json({ success: true, message });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 手動でテキストを喋らせる
app.post("/speak/text", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "text is required" });
    }

    console.log(`Speaking: ${text}`);
    await speakWithVoicevox(text);

    res.json({ success: true });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 表情テスト（デバッグ用）
app.post("/expression", (req, res) => {
  const { name, duration } = req.body;

  if (!name || !EXPRESSIONS.includes(name)) {
    return res.status(400).json({
      error: `name must be one of: ${EXPRESSIONS.join(", ")}`,
    });
  }

  const durationMs = duration || EXPRESSION_DURATION_MS;
  console.log(`Expression: ${name} (${durationMs}ms)`);
  notifyExpression(name, durationMs);
  res.json({ success: true, expression: name });
});

// ヘルスチェック
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "ボクはずんだもんなのだ！元気に動いてるのだ！" });
});

server.listen(PORT, async () => {
  console.log(`
╔════════════════════════════════════════╗
║   Claude VTuber Avatar Server          ║
║   Running on http://localhost:${PORT}     ║
╚════════════════════════════════════════╝

Endpoints:
  POST /speak      - Receive Claude Code hooks
  POST /speak/text - Manual text input
  POST /expression - Test expressions (smile, shock, etc.)
  GET  /health     - Health check

Make sure VOICEVOX is running on http://localhost:50021
  `);

  // VTube Studioに接続を試みる
  console.log("Attempting to connect to VTube Studio...");
  const connected = await connectToVTS();
  if (connected) {
    console.log("VTube Studio lipsync enabled!");
  } else {
    console.log("VTube Studio not available - lipsync disabled");
    console.log("(Start VTube Studio and restart server to enable lipsync)");
  }
});
