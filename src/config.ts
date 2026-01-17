/**
 * 設定ファイルを読み込む
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "config", "zundamon.json");

interface SpeakEvents {
  tools: string[];
  events: string[];
}

interface ZundamonConfig {
  speakEvents: SpeakEvents;
  readings: Record<string, string>;
}

let config: ZundamonConfig | null = null;

// デフォルト設定
const DEFAULT_CONFIG: ZundamonConfig = {
  speakEvents: {
    tools: ["Write", "Edit", "Bash"],
    events: ["SessionStart", "SessionEnd", "AssistantMessage"],
  },
  readings: {},
};

export function loadConfig(): ZundamonConfig {
  if (config) return config;

  if (!existsSync(CONFIG_PATH)) {
    console.warn(`Config file not found: ${CONFIG_PATH}`);
    config = { ...DEFAULT_CONFIG };
    return config;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    config = JSON.parse(raw);
    console.log(`Loaded config from ${CONFIG_PATH}`);
    console.log(`  - ${Object.keys(config!.readings).length} reading rules`);
    return config!;
  } catch (error) {
    console.error("Failed to load config:", error);
    config = { ...DEFAULT_CONFIG };
    return config;
  }
}

export function getReadings(): Record<string, string> {
  return loadConfig().readings;
}

export function getSpeakEvents(): SpeakEvents {
  return loadConfig().speakEvents;
}

export function shouldSpeakTool(toolName: string): boolean {
  const events = getSpeakEvents();
  return events.tools.includes(toolName);
}

export function shouldSpeakEvent(eventName: string): boolean {
  const events = getSpeakEvents();
  return events.events.includes(eventName);
}
