import { spawn, ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { startLipsync, stopLipsync, isConnected } from "./vtube-studio.js";
import { notifyLipsyncStart, notifyLipsyncStop } from "./lipsync-notifier.js";
import { MAX_TEXT_LENGTH, VOICEVOX_SPEED_SCALE, DEFAULT_AUDIO_DURATION_MS } from "./constants.js";

const VOICEVOX_URL = process.env.VOICEVOX_URL || "http://localhost:50021";
// VOICEVOX Speaker ID (デフォルト: ずんだもん ノーマル)
const SPEAKER_ID = process.env.VOICEVOX_SPEAKER_ID || "3";

// 現在再生中のプロセス
let currentPlayProcess: ChildProcess | null = null;
let currentTempFile: string | null = null;
// 現在の処理をキャンセルするためのAbortController
let currentAbortController: AbortController | null = null;

interface AudioQuery {
  accent_phrases: unknown[];
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  outputSamplingRate: number;
  outputStereo: boolean;
  kana: string;
}

/**
 * 現在の再生と処理を停止
 */
export function stopCurrentPlayback(): void {
  // 進行中のAPI呼び出しをキャンセル
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  if (currentPlayProcess) {
    console.log("Stopping previous playback...");
    currentPlayProcess.kill();
    currentPlayProcess = null;
    stopLipsync();
    notifyLipsyncStop();
  }
  // 古い一時ファイルを削除
  if (currentTempFile) {
    fs.unlink(currentTempFile).catch(() => {});
    currentTempFile = null;
  }
}

/**
 * VOICEVOX で音声合成して再生
 */
export async function speakWithVoicevox(text: string): Promise<void> {
  // 前の再生を停止
  stopCurrentPlayback();

  // 新しいAbortControllerを作成
  const abortController = new AbortController();
  currentAbortController = abortController;

  // 長すぎるテキストは省略
  const truncatedText = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) + "..." : text;

  try {
    // 1. 音声合成用のクエリを作成
    const queryRes = await fetch(
      `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(truncatedText)}&speaker=${SPEAKER_ID}`,
      { method: "POST", signal: abortController.signal }
    );

    if (!queryRes.ok) {
      throw new Error(`Audio query failed: ${queryRes.status}`);
    }

    const query: AudioQuery = await queryRes.json();

    // 速度調整
    query.speedScale = VOICEVOX_SPEED_SCALE;

    // キャンセルされたかチェック
    if (abortController.signal.aborted) return;

    // 2. 音声合成
    const synthesisRes = await fetch(
      `${VOICEVOX_URL}/synthesis?speaker=${SPEAKER_ID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
        signal: abortController.signal,
      }
    );

    if (!synthesisRes.ok) {
      throw new Error(`Synthesis failed: ${synthesisRes.status}`);
    }

    // キャンセルされたかチェック
    if (abortController.signal.aborted) return;

    // 3. 一時ファイルに保存して再生
    const audioBuffer = await synthesisRes.arrayBuffer();
    const tempFile = path.join(os.tmpdir(), `claude-voice-${Date.now()}.wav`);
    const audioData = Buffer.from(audioBuffer);
    await fs.writeFile(tempFile, audioData);
    currentTempFile = tempFile;

    // WAVファイルから音声の長さを取得
    const durationMs = getWavDuration(audioData);

    // VTube Studioが接続されていればリップシンク開始
    if (isConnected()) {
      startLipsync(durationMs);
    }
    // Electronクライアントにも通知
    notifyLipsyncStart(durationMs);

    // macOS の場合は afplay、Linux の場合は aplay
    const playCommand = process.platform === "darwin" ? "afplay" : "aplay";

    // spawnで再生（キャンセル可能）
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(playCommand, [tempFile]);
      currentPlayProcess = proc;

      proc.on("close", (code) => {
        if (currentPlayProcess === proc) {
          currentPlayProcess = null;
        }
        // リップシンク停止
        stopLipsync();
        notifyLipsyncStop();
        // 一時ファイル削除
        if (currentTempFile === tempFile) {
          fs.unlink(tempFile).catch(() => {});
          currentTempFile = null;
        }
        resolve();
      });

      proc.on("error", (err) => {
        if (currentPlayProcess === proc) {
          currentPlayProcess = null;
        }
        stopLipsync();
        reject(err);
      });
    });
  } catch (error) {
    // キャンセルされた場合は無視
    if (error instanceof Error && error.name === "AbortError") {
      console.log("Speech synthesis cancelled");
      return;
    }
    if (error instanceof Error && error.message.includes("ECONNREFUSED")) {
      console.error("VOICEVOX is not running! Please start VOICEVOX first.");
    } else {
      throw error;
    }
  }
}

/**
 * VOICEVOX の話者一覧を取得
 */
export async function getSpeakers(): Promise<unknown[]> {
  const res = await fetch(`${VOICEVOX_URL}/speakers`);
  if (!res.ok) {
    throw new Error(`Failed to get speakers: ${res.status}`);
  }
  return res.json();
}

/**
 * WAVファイルのバイナリから音声の長さ(ms)を取得
 */
function getWavDuration(buffer: Buffer): number {
  try {
    // WAVヘッダーからサンプルレートとデータサイズを取得
    // バイト24-27: サンプルレート (little-endian)
    // バイト28-31: バイトレート (little-endian)
    const sampleRate = buffer.readUInt32LE(24);
    const byteRate = buffer.readUInt32LE(28);

    // "data"チャンクを探す
    let dataSize = 0;
    for (let i = 0; i < buffer.length - 8; i++) {
      if (
        buffer[i] === 0x64 && // 'd'
        buffer[i + 1] === 0x61 && // 'a'
        buffer[i + 2] === 0x74 && // 't'
        buffer[i + 3] === 0x61 // 'a'
      ) {
        dataSize = buffer.readUInt32LE(i + 4);
        break;
      }
    }

    if (dataSize === 0 || byteRate === 0) {
      // フォールバック: テキスト長から推定（1文字約0.15秒）
      return DEFAULT_AUDIO_DURATION_MS;
    }

    return Math.floor((dataSize / byteRate) * 1000);
  } catch (e) {
    return DEFAULT_AUDIO_DURATION_MS; // エラー時のデフォルト
  }
}
