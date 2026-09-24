#!/usr/bin/env bash
# ==============================================================================
# console-warn.sh — PostToolUse hook for Edit/Write tools
#
# Detects debug statements left in edited files:
#   console.log, console.debug, debugger, print() (Python), dd() (PHP/Laravel)
#
# Input:  JSON via stdin  {"tool_name":"Edit","tool_input":{"file_path":"..."}}
# Output: exit 0 + stdout JSON hookSpecificOutput.additionalContext
#         (stderr on exit 0 is invisible to Claude — official spec)
#
# Policy: warn-only (never blocks, provides feedback)
# ==============================================================================

set -uo pipefail

# ── Claude へ所見を届けるための共通エミッタ ────────────────────────────
# 公式仕様: exit 0 時の stderr は debug log にしか残らず、Claude にもユーザーにも
# 届かない。Claude に伝えるには stdout に hookSpecificOutput.additionalContext を出す。
emit_context() {
    local event="$1"; shift
    local text="$*"
    [[ -z "$text" ]] && return 0
    if command -v jq &>/dev/null; then
        jq -nc --arg e "$event" --arg t "$text" \
            '{hookSpecificOutput:{hookEventName:$e, additionalContext:$t}}'
    else
        local esc
        esc="$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')"
        printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$event" "$esc"
    fi
}

# --- Extract the file path from stdin JSON ---
INPUT="$(cat)"

if command -v jq &>/dev/null; then
    FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null)"
else
    FILE_PATH="$(echo "$INPUT" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    if [[ -z "$FILE_PATH" ]]; then
        FILE_PATH="$(echo "$INPUT" | sed -n 's/.*"filePath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    fi
fi

# Skip if no file path or file doesn't exist
if [[ -z "$FILE_PATH" ]] || [[ ! -f "$FILE_PATH" ]]; then
    exit 0
fi

# Skip non-source files (config, docs, etc.)
case "$FILE_PATH" in
    *.md|*.json|*.yaml|*.yml|*.toml|*.xml|*.csv|*.txt|*.lock|*.log)
        exit 0
        ;;
esac

# --- Debug statement patterns ---
# Each entry: "pattern|description"
DEBUG_PATTERNS=(
    'console\.log([[:space:]]|\()|console.log (JavaScript/TypeScript)'
    'console\.debug([[:space:]]|\()|console.debug (JavaScript/TypeScript)'
    '(^|[^[:alnum:]_])debugger([^[:alnum:]_]|$)|debugger statement (JavaScript/TypeScript)'
    '(^|[^[:alnum:]_])print[[:space:]]*\(|print() (Python)'
    '(^|[^[:alnum:]_])pp([[:space:]]|\()|pp (Ruby)'
    '(^|[^[:alnum:]_])dd[[:space:]]*\(|dd() (PHP/Laravel)'
    '(^|[^[:alnum:]_])var_dump[[:space:]]*\(|var_dump() (PHP)'
    '(^|[^[:alnum:]_])puts([[:space:]]|\()|puts (Ruby)'
    'NSLog[[:space:]]*\(|NSLog() (Swift/ObjC)'
    'System\.out\.print|System.out.print (Java)'
    'fmt\.Print|fmt.Print (Go)'
    'println![[:space:]]*\(|println!() (Rust)'
)

WARNINGS=()

for entry in "${DEBUG_PATTERNS[@]}"; do
    PATTERN="${entry%|*}"
    DESC="${entry##*|}"

    # Search the file for the pattern (limit to first 3 matches)
    MATCHES="$(grep -nE -- "$PATTERN" "$FILE_PATH" 2>/dev/null | head -3 || true)"
    if [[ -n "$MATCHES" ]]; then
        WARNINGS+=("$DESC を検出:")
        while IFS= read -r line; do
            WARNINGS+=("  $FILE_PATH:$line")
        done <<< "$MATCHES"
    fi
done

# --- Claude へ警告を通知 ---
if [[ ${#WARNINGS[@]} -gt 0 ]]; then
    MSG="デバッグステートメントを検出しました(コミット前に削除を検討してください):"
    for w in "${WARNINGS[@]}"; do
        MSG="$MSG"$'\n'"  $w"
    done
    emit_context PostToolUse "$MSG"
fi

exit 0
