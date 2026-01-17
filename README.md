# ずんだもん VTuber Avatar for Claude Code

Claude Code の出力を VOICEVOX（ずんだもん）で喋らせる Electron アプリ。
表情変化・リップシンク対応のデスクトップマスコットとして動作する。

![概要](https://img.shields.io/badge/Platform-macOS-blue) ![Electron](https://img.shields.io/badge/Electron-28-green) ![VOICEVOX](https://img.shields.io/badge/VOICEVOX-Required-orange)

## 特徴

- Claude Code の hooks と連携してリアルタイムで喋る
- ずんだもん口調で応答（セッション開始/終了、アシスタントメッセージ）
- 表情変化（通常、笑顔、キラキラ目、驚き、ショック）
- リップシンク（口パク）
- 透過ウィンドウでデスクトップに常駐
- ドラッグで移動可能

## 必要なもの

- **macOS** (Apple Silicon / Intel)
- **Node.js 18+**
- **[VOICEVOX](https://voicevox.hiroshiba.jp/)** - 無料の音声合成ソフト

## クイックスタート

### 1. VOICEVOX をインストール・起動

https://voicevox.hiroshiba.jp/ からダウンロードして起動。
デフォルトで `http://localhost:50021` で API が立ち上がる。（内部的には `127.0.0.1` で接続）

### 2. アバターを起動

```bash
# リポジトリをクローン
git clone <repository-url>
cd claude-vtuber-avatar

# 依存関係をインストール
npm install

# 開発モードで起動
npm run electron
```

透過ウィンドウにずんだもんが表示されれば成功。

### 3. Claude Code の hooks を設定

`~/.claude/settings.json` に以下を追加:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3456/speak -H 'Content-Type: application/json' -d \"$(cat)\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

これで Claude Code のセッション開始/終了時やアシスタントメッセージで喋るようになる。

## スタンドアロンアプリとしてビルド

### Portable ビルド（推奨）

```bash
npm run dist:mac:portable
```

出力先: `release/portable/mac-arm64/ずんだもん.app`

```bash
# 起動
open -n "release/portable/mac-arm64/ずんだもん.app"
```

> **Note**: `electron-builder` 版（`npm run dist:dir`）は macOS 15 で V8 クラッシュの問題があるため、`dist:mac:portable` を推奨。

## 設定

### config/zundamon.json

```json
{
  "speakEvents": {
    "tools": [],
    "events": ["SessionStart", "SessionEnd", "AssistantMessage"]
  },
  "readings": {
    ".ts": "ティーエス",
    "API": "エーピーアイ",
    ...
  }
}
```

| 項目 | 説明 |
|------|------|
| `speakEvents.events` | 喋るイベントの種類 |
| `readings` | 読み替え辞書（技術用語をカタカナに） |

### 環境変数

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `VOICEVOX_URL` | `http://localhost:50021` | VOICEVOX の API URL |
| `VOICEVOX_SPEAKER_ID` | `3` | 話者ID（3=ずんだもん） |

#### 話者ID 例

```bash
VOICEVOX_SPEAKER_ID=2 npm run electron  # 四国めたん
VOICEVOX_SPEAKER_ID=3 npm run electron  # ずんだもん（デフォルト）
VOICEVOX_SPEAKER_ID=8 npm run electron  # 春日部つむぎ
```

## API エンドポイント

アバターは内蔵の Express サーバー（:3456）を持つ。

| エンドポイント | メソッド | 説明 |
|---------------|---------|------|
| `/speak` | POST | Claude Code hooks からのリクエストを処理 |
| `/speak/text` | POST | テキストを直接喋らせる |
| `/expression` | POST | 表情を変更 |
| `/health` | GET | ヘルスチェック |

### 使用例

```bash
# テキストを喋らせる
curl -X POST http://localhost:3456/speak/text \
  -H 'Content-Type: application/json' \
  -d '{"text": "こんにちは、ボクはずんだもんなのだ！"}'

# 表情を変更（smile, shock, suprise, eye_sparkle, normal）
curl -X POST http://localhost:3456/expression \
  -H 'Content-Type: application/json' \
  -d '{"name": "smile", "duration": 3000}'
```

## 表情一覧

| 名前 | ファイル | トリガーキーワード例 |
|------|---------|-------------------|
| `normal` | zundamon.png | （デフォルト） |
| `smile` | smile.png | 完了, 成功, done, success |
| `eye_sparkle` | eye_sparkle.png | 見つけ, found, なるほど |
| `suprise` | suprise.png | おお, すごい, wow |
| `shock` | shock.png | error, failed, エラー |

表情画像は `electron/assets/` に配置。

## 開発

### npm scripts

| コマンド | 説明 |
|---------|------|
| `npm run electron` | 開発モードで起動 |
| `npm run dist:mac:portable` | macOS 用スタンドアロンアプリをビルド |
| `npm run dist:dir` | electron-builder でビルド（非推奨） |

### プロジェクト構成

```
claude-vtuber-avatar/
├── electron/
│   ├── main.cjs        # Electron メインプロセス（Express サーバー統合）
│   ├── index.html      # レンダラー（アバター表示）
│   └── assets/         # 表情画像
├── config/
│   └── zundamon.json   # 設定ファイル
├── scripts/
│   └── dist-mac-portable.mjs  # Portable ビルドスクリプト
└── src/                # （未使用：旧サーバー実装）
```

## トラブルシューティング

### VOICEVOX に接続できない

```
VOICEVOX is not running! Please start VOICEVOX first.
```

→ VOICEVOX アプリを起動してください。

### ポート 3456 が使用中

```
Error: listen EADDRINUSE: address already in use :::3456
```

→ 既存のプロセスを終了してください:

```bash
lsof -i :3456
kill <PID>
```

### ビルドしたアプリがクラッシュする

macOS 15 + electron-builder の組み合わせで V8 クラッシュが発生することがある。
`npm run dist:mac:portable` を使用してください。

## ライセンス

MIT

## クレジット

- [VOICEVOX](https://voicevox.hiroshiba.jp/) - 音声合成エンジン
- ずんだもん - VOICEVOX キャラクター
