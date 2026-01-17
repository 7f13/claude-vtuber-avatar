/**
 * VTube Studio API連携モジュール
 * WebSocketでVTube Studioに接続してリップシンクを制御
 */

import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { VTS_WEBSOCKET_URL, VTS_REQUEST_TIMEOUT_MS, LIPSYNC_INTERVAL_MS } from "./constants.js";
const PLUGIN_NAME = "Claude VTuber Avatar";
const PLUGIN_DEVELOPER = "Claude Code";
const TOKEN_FILE = path.join(process.cwd(), ".vts-token");

let ws: WebSocket | null = null;
let authToken: string | null = null;
let isAuthenticated = false;
let lipsyncInterval: NodeJS.Timeout | null = null;
let mouthOpen = false;

// リクエストID生成
let requestId = 0;
function getRequestId(): string {
  return `req_${++requestId}`;
}

/**
 * 保存されたトークンを読み込む
 */
function loadToken(): string | null {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return fs.readFileSync(TOKEN_FILE, "utf-8").trim();
    }
  } catch (e) {
    console.log("No saved token found");
  }
  return null;
}

/**
 * トークンを保存
 */
function saveToken(token: string): void {
  fs.writeFileSync(TOKEN_FILE, token);
  console.log("Token saved");
}

/**
 * VTube Studioに接続
 */
export async function connectToVTS(): Promise<boolean> {
  return new Promise((resolve) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve(true);
      return;
    }

    console.log("Connecting to VTube Studio...");

    ws = new WebSocket(VTS_WEBSOCKET_URL);

    ws.on("open", async () => {
      console.log("Connected to VTube Studio");
      authToken = loadToken();

      if (authToken) {
        // 既存トークンで認証試行
        const success = await authenticate();
        resolve(success);
      } else {
        // 新規トークン取得
        const success = await requestNewToken();
        resolve(success);
      }
    });

    ws.on("error", (error) => {
      console.error("VTube Studio connection error:", error.message);
      resolve(false);
    });

    ws.on("close", () => {
      console.log("Disconnected from VTube Studio");
      isAuthenticated = false;
      ws = null;
    });
  });
}

/**
 * メッセージを送信してレスポンスを待つ
 */
function sendRequest(request: object): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("WebSocket not connected"));
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error("Request timeout"));
    }, VTS_REQUEST_TIMEOUT_MS);

    const handler = (data: WebSocket.Data) => {
      clearTimeout(timeout);
      ws?.off("message", handler);
      try {
        resolve(JSON.parse(data.toString()));
      } catch (e) {
        reject(e);
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify(request));
  });
}

/**
 * 新規トークンをリクエスト
 */
async function requestNewToken(): Promise<boolean> {
  try {
    console.log("Requesting new authentication token...");
    console.log("Please allow the plugin in VTube Studio!");

    const response = await sendRequest({
      apiName: "VTubeStudioPublicAPI",
      apiVersion: "1.0",
      requestID: getRequestId(),
      messageType: "AuthenticationTokenRequest",
      data: {
        pluginName: PLUGIN_NAME,
        pluginDeveloper: PLUGIN_DEVELOPER,
      },
    });

    if (response.data?.authenticationToken) {
      const token = response.data.authenticationToken;
      authToken = token;
      saveToken(token);
      return await authenticate();
    } else {
      console.error("Failed to get token:", response.data?.message);
      return false;
    }
  } catch (e) {
    console.error("Token request error:", e);
    return false;
  }
}

/**
 * トークンで認証
 */
async function authenticate(): Promise<boolean> {
  try {
    const response = await sendRequest({
      apiName: "VTubeStudioPublicAPI",
      apiVersion: "1.0",
      requestID: getRequestId(),
      messageType: "AuthenticationRequest",
      data: {
        pluginName: PLUGIN_NAME,
        pluginDeveloper: PLUGIN_DEVELOPER,
        authenticationToken: authToken,
      },
    });

    if (response.data?.authenticated) {
      console.log("Authenticated with VTube Studio!");
      isAuthenticated = true;
      return true;
    } else {
      console.log("Authentication failed, requesting new token...");
      authToken = null;
      return await requestNewToken();
    }
  } catch (e) {
    console.error("Authentication error:", e);
    return false;
  }
}

/**
 * パラメータ値を設定
 */
async function setParameter(parameterId: string, value: number): Promise<void> {
  if (!isAuthenticated || !ws) return;

  try {
    await sendRequest({
      apiName: "VTubeStudioPublicAPI",
      apiVersion: "1.0",
      requestID: getRequestId(),
      messageType: "InjectParameterDataRequest",
      data: {
        parameterValues: [
          {
            id: parameterId,
            value: value,
          },
        ],
      },
    });
  } catch (e) {
    // エラーは無視（リップシンク中の軽微なエラー）
  }
}

/**
 * リップシンク開始（簡易版：一定間隔で口をパクパク）
 */
export function startLipsync(durationMs: number): void {
  if (!isAuthenticated) {
    console.log("VTube Studio not authenticated, skipping lipsync");
    return;
  }

  stopLipsync(); // 既存のリップシンクを停止

  console.log("Starting lipsync...");

  lipsyncInterval = setInterval(() => {
    mouthOpen = !mouthOpen;
    setParameter("MouthOpen", mouthOpen ? 1 : 0);
  }, LIPSYNC_INTERVAL_MS);

  // 指定時間後に自動停止
  setTimeout(() => {
    stopLipsync();
  }, durationMs);
}

/**
 * リップシンク停止
 */
export function stopLipsync(): void {
  if (lipsyncInterval) {
    clearInterval(lipsyncInterval);
    lipsyncInterval = null;
  }
  mouthOpen = false;
  setParameter("MouthOpen", 0);
  console.log("Lipsync stopped");
}

/**
 * VTube Studioとの接続状態を確認
 */
export function isConnected(): boolean {
  return isAuthenticated && ws?.readyState === WebSocket.OPEN;
}
