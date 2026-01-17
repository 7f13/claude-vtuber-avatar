#!/bin/bash
# Claude Code hook script - stdinからJSONを受け取ってサーバーに送信

INPUT=$(cat)
echo "Hook received: $INPUT" >> /tmp/claude-hook-debug.log
curl -s -X POST http://localhost:3456/speak \
  -H 'Content-Type: application/json' \
  -d "$INPUT"
