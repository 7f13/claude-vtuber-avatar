/**
 * 共通定数
 */

// 表情の種類
export const EXPRESSIONS = ["normal", "smile", "eye_sparkle", "surprise", "shock"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

// 表情の表示時間（ミリ秒）
export const EXPRESSION_DURATION_MS = 3000;

// メッセージ長の閾値
export const SHORT_MESSAGE_THRESHOLD = 100;
export const MAX_TEXT_LENGTH = 200;

// 文字列切り詰め長
export const TRUNCATE_PATTERN_LENGTH = 20;
export const TRUNCATE_QUERY_LENGTH = 30;

// 音声設定
export const VOICEVOX_SPEED_SCALE = 1.2;
export const DEFAULT_AUDIO_DURATION_MS = 2000;

// リップシンク設定
export const LIPSYNC_INTERVAL_MS = 120;

// WebSocket/API設定
export const DEFAULT_SERVER_PORT = 3456;
export const VTS_WEBSOCKET_URL = "ws://localhost:8001";
export const VTS_REQUEST_TIMEOUT_MS = 10000;

// デバウンス設定
export const DEBOUNCE_MS = 100;

// 固定メッセージ
export const MESSAGES = {
  SESSION_START: "やあ、ぼくずんだもんなのだ！今日もよろしくなのだ！",
  SESSION_END: "おつかれさまなのだ！またねなのだ！",
  LONG_MESSAGE_FALLBACK: "作業が完了したのだ、詳細はターミナルを確認するのだ",
} as const;
