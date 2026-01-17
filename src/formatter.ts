/**
 * Claude Code hooks から受け取ったデータを
 * 読み上げ用のメッセージに変換する
 */

import { getReadings, shouldSpeakTool, shouldSpeakEvent } from "./config.js";
import { notifyExpression } from "./lipsync-notifier.js";
import {
  Expression,
  EXPRESSION_DURATION_MS,
  SHORT_MESSAGE_THRESHOLD,
  TRUNCATE_PATTERN_LENGTH,
  TRUNCATE_QUERY_LENGTH,
  MESSAGES,
} from "./constants.js";

// 表情検出のキーワード設定
const EXPRESSION_KEYWORDS: Record<Expression, string[]> = {
  shock: [
    "error", "failed", "exception", "crash", "fatal",
    "エラー", "失敗", "問題", "だめ", "無理", "壊れ",
  ],
  smile: [
    "完了", "成功", "done", "success", "passed", "ok",
    "できた", "やった", "よし", "いいね", "ばっちり",
  ],
  eye_sparkle: [
    "見つけ", "found", "発見", "ある", "いた",
    "なるほど", "わかった", "理解", "ひらめ",
  ],
  surprise: [
    "おお", "すごい", "wow", "amazing", "！",
    "えっ", "まじ", "本当", "びっくり",
  ],
  normal: [],
};

// 表情検出の優先順位
const EXPRESSION_PRIORITY: Expression[] = ["shock", "smile", "eye_sparkle", "surprise"];

// セッション中の作業履歴
let workHistory: string[] = [];

// Hook データの型定義
interface HookData {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    command?: string;
    content?: string;
    pattern?: string;
    query?: string;
  };
  tool_output?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
}

/**
 * メッセージ内容から表情を判定
 */
function detectExpression(message: string, toolName?: string): Expression {
  const lowerMsg = message.toLowerCase();

  // 特定ツールの場合は eye_sparkle
  if (toolName === "Glob" || toolName === "Grep") {
    return "eye_sparkle";
  }

  // キーワードマッチング（優先順位順）
  for (const expression of EXPRESSION_PRIORITY) {
    const keywords = EXPRESSION_KEYWORDS[expression];
    if (keywords.some((kw) => lowerMsg.includes(kw.toLowerCase()))) {
      return expression;
    }
  }

  return "normal";
}

/**
 * メッセージを処理して表情通知 + 読み上げテキストを返す
 */
function processMessage(message: string, toolName?: string): string {
  const expression = detectExpression(message, toolName);
  notifyExpression(expression, EXPRESSION_DURATION_MS);
  return convertReadings(message);
}

/**
 * ファイルパスからファイル名を取得
 */
function getFileName(filePath?: string): string | null {
  if (!filePath) return null;
  const parts = filePath.split("/");
  return parts[parts.length - 1] || null;
}

/**
 * 文字列を指定長で切り詰め
 */
function truncate(str: string, maxLength: number): string {
  return str.length <= maxLength ? str : str.slice(0, maxLength) + "...";
}

/**
 * 拡張子や専門用語を読みやすい形に変換
 */
function convertReadings(text: string): string {
  const readings = getReadings();
  let result = text;
  for (const [key, reading] of Object.entries(readings)) {
    const regex = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    result = result.replace(regex, reading);
  }
  return result;
}

// Bashコマンドのパターンと対応するメッセージ
const BASH_PATTERNS: Array<{ patterns: string[]; speak: string; history: string | null }> = [
  { patterns: ["npm install", "yarn add", "pnpm add"], speak: "パッケージをインストールするのだ", history: "パッケージをインストール" },
  { patterns: ["npm run build", "yarn build", "pnpm build"], speak: "ビルドするのだ", history: "ビルドを実行" },
  { patterns: ["npm test", "yarn test", "pnpm test"], speak: "テストを実行するのだ", history: "テストを実行" },
  { patterns: ["npm run", "yarn ", "pnpm "], speak: "スクリプトを実行するのだ", history: null },
  { patterns: ["git commit"], speak: "コミットするのだ", history: "コミットを作成" },
  { patterns: ["git push"], speak: "プッシュするのだ", history: "プッシュを実行" },
  { patterns: ["git pull"], speak: "プルするのだ", history: "プルを実行" },
  { patterns: ["git "], speak: "Gitコマンドを実行するのだ", history: null },
  { patterns: ["mkdir"], speak: "フォルダを作成するのだ", history: null },
  { patterns: ["rm "], speak: "ファイルを削除するのだ", history: null },
  { patterns: ["cp ", "mv "], speak: "ファイルを移動するのだ", history: null },
];

/**
 * Bashコマンドからメッセージを取得
 */
function getBashMessage(cmd: string | undefined, forHistory: boolean): string | null {
  if (!cmd) return null;
  for (const { patterns, speak, history } of BASH_PATTERNS) {
    if (patterns.some((p) => cmd.includes(p))) {
      return forHistory ? history : speak;
    }
  }
  return null;
}

// ツールごとのメッセージテンプレート
const TOOL_MESSAGES: Record<string, (data: HookData) => string | null> = {
  Write: (data) => {
    const fileName = getFileName(data.tool_input?.file_path);
    return fileName ? `${fileName}を作成したのだ` : null;
  },
  Edit: (data) => {
    const fileName = getFileName(data.tool_input?.file_path);
    return fileName ? `${fileName}を編集したのだ` : null;
  },
  Read: (data) => {
    const fileName = getFileName(data.tool_input?.file_path);
    return fileName ? `${fileName}を読むのだ` : null;
  },
  Bash: (data) => getBashMessage(data.tool_input?.command, false),
  Glob: () => "ファイルを探すのだ",
  Grep: (data) => {
    const pattern = data.tool_input?.pattern;
    return pattern ? `「${truncate(pattern, TRUNCATE_PATTERN_LENGTH)}」を検索するのだ` : "検索するのだ";
  },
  WebSearch: (data) => {
    const query = data.tool_input?.query;
    return query ? `「${truncate(query, TRUNCATE_QUERY_LENGTH)}」を検索するのだ` : "ウェブ検索するのだ";
  },
  WebFetch: () => "ウェブページを取得するのだ",
  Task: () => "サブタスクを実行するのだ",
};

/**
 * ツール実行の作業内容を記録用に生成
 */
function getWorkDescription(toolName: string, data: HookData): string | null {
  const fileName = getFileName(data.tool_input?.file_path);

  const descriptions: Record<string, () => string | null> = {
    Write: () => fileName ? `${fileName}を作成` : null,
    Edit: () => fileName ? `${fileName}を編集` : null,
    Read: () => fileName ? `${fileName}を読み込み` : null,
    Bash: () => getBashMessage(data.tool_input?.command, true),
    Glob: () => "ファイルを検索",
    Grep: () => "ファイルを検索",
    WebSearch: () => "ウェブを検索",
    WebFetch: () => "ウェブを検索",
    Task: () => "サブタスクを実行",
  };

  return descriptions[toolName]?.() ?? null;
}

/**
 * hooks データからメッセージを生成
 */
export async function formatClaudeMessage(data: HookData): Promise<string | null> {
  // AssistantMessage の処理
  if (data.hook_event_name === "AssistantMessage" && data.message) {
    if (!shouldSpeakEvent("AssistantMessage")) {
      console.log("Skipping AssistantMessage (filtered)");
      return null;
    }

    // 短いメッセージはそのまま読む
    if (data.message.length < SHORT_MESSAGE_THRESHOLD) {
      console.log(`Short message (${data.message.length} chars), reading as-is`);
      return processMessage(data.message);
    }

    // 長いメッセージは固定メッセージ（LLMは遅いので使わない）
    console.log(`Long message (${data.message.length} chars), using fixed message`);
    notifyExpression("smile", EXPRESSION_DURATION_MS);
    return convertReadings(MESSAGES.LONG_MESSAGE_FALLBACK);
  }

  // ツールベースのメッセージ
  const toolName = data.tool_name;
  if (toolName) {
    // 作業履歴に追加
    const workDesc = getWorkDescription(toolName, data);
    if (workDesc) workHistory.push(workDesc);

    // フィルタリング
    if (!shouldSpeakTool(toolName)) {
      console.log(`Skipping tool: ${toolName} (filtered)`);
      return null;
    }

    // 固定メッセージを使用
    const msg = TOOL_MESSAGES[toolName]?.(data);
    if (msg) return processMessage(msg, toolName);
  }

  // イベントベースのメッセージ（LLM呼び出しを避けて固定メッセージ）
  if (data.hook_event_name === "SessionStart") {
    workHistory = [];
    notifyExpression("smile", EXPRESSION_DURATION_MS);
    return convertReadings(MESSAGES.SESSION_START);
  }

  if (data.hook_event_name === "SessionEnd") {
    notifyExpression("smile", EXPRESSION_DURATION_MS);
    workHistory = [];
    return convertReadings(MESSAGES.SESSION_END);
  }

  return null;
}
