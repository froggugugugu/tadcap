#!/usr/bin/env bash
# ==============================================================================
# subagent-audit.sh — SubagentStart / SubagentStop hook
#
# 並行チーム作業(TEAM_PJM --parallel 等)の可観測性のため、サブエージェントの
# 起動・完了イベントを JSONL に記録する。実行はブロックしない(観測専用)。
#
# さらに SubagentStart では additionalContext を返し、サブエージェントの
# 冒頭コンテキストにハーネスの最低限のガードレールを注入する。
# (公式仕様: SubagentStart は「Context only」— ブロックはできないが文脈注入は可能。
#  SubagentStop は Stop と同じ decision 形式だが、ここでは記録のみ行う)
#
# Input:  JSON via stdin
#         start: {"hook_event_name":"SubagentStart","agent_id":"...","agent_type":"..."}
#         stop : {"hook_event_name":"SubagentStop","agent_id":"...","agent_type":"...",
#                 "last_assistant_message":"..."}
# Output: testreport/agents/<session>.jsonl に 1 行追記
#         SubagentStart のときのみ stdout に additionalContext JSON
#
# Policy: fail-open(パース失敗時はそのまま通過させる)
# ==============================================================================

set -uo pipefail

PROFILE="${BLUEPRINT_HOOK_PROFILE:-standard}"

# --- Paths ---
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
LOG_DIR="$PROJECT_DIR/testreport/agents"
# Sanitize SESSION_ID to prevent path traversal (reject `/`, `..`, etc.)
SESSION_ID_RAW="${CLAUDE_SESSION_ID:-$(date +%Y%m%d)}"
SESSION_ID="$(printf '%s' "$SESSION_ID_RAW" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-64)"
[[ -z "$SESSION_ID" ]] && SESSION_ID="$(date +%Y%m%d)"
LOG_FILE="$LOG_DIR/$SESSION_ID.jsonl"

# --- Read stdin JSON ---
INPUT="$(cat)"

# Fail-open: empty input is allowed
if [[ -z "$INPUT" ]]; then
    exit 0
fi

# --- Extract event fields ---
# `hook_event_name` は公式仕様のフィールド名。`hook_event` / `hookEventName` は
# 旧ペイロード互換のために残している。
if command -v jq &>/dev/null; then
    EVENT="$(echo "$INPUT" | jq -r '.hook_event_name // .hook_event // .hookEventName // "unknown"' 2>/dev/null)"
    AGENT_NAME="$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // "unknown"' 2>/dev/null)"
    AGENT_ID="$(echo "$INPUT" | jq -r '.agent_id // .subagent_id // "unknown"' 2>/dev/null)"
else
    # Fallback: rough extraction without jq
    EVENT="$(echo "$INPUT" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    [[ -z "$EVENT" ]] && EVENT="$(echo "$INPUT" | sed -n 's/.*"hook_event"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    AGENT_NAME="$(echo "$INPUT" | sed -n 's/.*"agent_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    [[ -z "$AGENT_NAME" ]] && AGENT_NAME="unknown"
    AGENT_ID="unknown"
fi

# Fail-open: couldn't parse event
if [[ -z "${EVENT:-}" ]]; then
    exit 0
fi

# --- Ensure log directory exists ---
mkdir -p "$LOG_DIR" 2>/dev/null || exit 0

# --- Write JSONL line (properly escaped) ---
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if command -v jq &>/dev/null; then
    # jq handles escaping for all values (quotes, backslashes, control chars)
    jq -nc \
        --arg timestamp "$TIMESTAMP" \
        --arg event "$EVENT" \
        --arg agent_name "$AGENT_NAME" \
        --arg agent_id "$AGENT_ID" \
        --arg session "$SESSION_ID" \
        '{timestamp: $timestamp, event: $event, agent_name: $agent_name, agent_id: $agent_id, session_id: $session}' \
        >> "$LOG_FILE" 2>/dev/null || true
else
    # Fallback: best-effort manual escaping (backslashes, double quotes, control chars stripped)
    esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }
    printf '{"timestamp":"%s","event":"%s","agent_name":"%s","agent_id":"%s","session_id":"%s"}\n' \
        "$TIMESTAMP" "$(esc "$EVENT")" "$(esc "$AGENT_NAME")" "$(esc "$AGENT_ID")" "$(esc "$SESSION_ID")" \
        >> "$LOG_FILE" 2>/dev/null || true
fi

# --- SubagentStart: サブエージェントへガードレールを注入 ---
# minimal プロファイルでは注入もスキップし、記録だけ残す。
if [[ "$EVENT" == "SubagentStart" && "$PROFILE" != "minimal" ]]; then
    CTX="[harness guardrails] このリポジトリのハーネス規約:
  - 成果物は output/ 配下にのみ新規作成する。docs/ は最小差分でのみ更新する
  - project-config.md は §2 / §3 / §11 以外を書き換えない(人間の決定領域)
  - input/requirements/ と constitution.md は読み取り専用
  - シークレット(.env / 秘密鍵 / トークン)は読まない・出力しない
  - 結論は根拠(ファイルパス:行番号)とセットで返す"
    if command -v jq &>/dev/null; then
        jq -nc --arg t "$CTX" \
            '{hookSpecificOutput:{hookEventName:"SubagentStart", additionalContext:$t}}'
    else
        esc2="$(printf '%s' "$CTX" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')"
        printf '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"%s"}}\n' "$esc2"
    fi
fi

# Always exit 0 — this is observation only, never blocks
exit 0
