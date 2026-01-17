/**
 * Electronクライアントへのリップシンク通知を管理
 */

import { WebSocket } from "ws";

// 接続中のElectronクライアント
const clients: Set<WebSocket> = new Set();

export function addClient(ws: WebSocket) {
  console.log("Electron client connected");
  clients.add(ws);
}

export function removeClient(ws: WebSocket) {
  console.log("Electron client disconnected");
  clients.delete(ws);
}

/**
 * 全クライアントにメッセージを送信
 */
function broadcast(message: object) {
  const json = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

export function notifyLipsyncStart(duration: number) {
  console.log(`[Lipsync] Starting, duration=${duration}ms, clients=${clients.size}`);
  broadcast({ type: "lipsync-start", duration });
}

export function notifyLipsyncStop() {
  broadcast({ type: "lipsync-stop" });
}

export function notifyExpression(name: string, duration?: number) {
  broadcast({ type: "expression", name, duration });
}
