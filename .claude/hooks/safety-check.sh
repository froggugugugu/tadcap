#!/usr/bin/env bash
# ==============================================================================
# safety-check.sh — PreToolUse hook for Bash commands
#
# Blocks dangerous shell commands that could cause irreversible damage.
# Works even with --dangerously-skip-permissions (hooks are NOT bypassed).
#
# Input:  JSON via stdin  {"tool_name":"Bash","tool_input":{"command":"..."}}
# Output: exit 0 = allow, exit 2 = block (stderr message fed back to Claude)
#
# Policy: fail-open (if parsing fails, the command is allowed)
# ==============================================================================

set -uo pipefail

# --- Extract the command string from stdin JSON ---
INPUT="$(cat)"

if command -v jq &>/dev/null; then
    CMD="$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"
else
    # jq 不在時: rm -rf / 等の最重要パターンのみ raw JSON で直接検査し、残りはスキップ(fail-open)
    # Note: jq は safety-check.sh の完全動作に必要。setup.sh で警告済み。
    echo "safety-check: jq が未インストールです。最重要パターンのみ検査します(完全保護には jq が必要)" >&2
    for _p in "rm -rf /" "rm -fr /" "rm -rf --no-preserve-root" "rm -fr --no-preserve-root"; do
        if echo "$INPUT" | grep -qF "$_p"; then
            echo "BLOCKED: Dangerous pattern detected in command: '$_p'" >&2
            echo "If you believe this is safe, ask the user for explicit approval." >&2
            exit 2
        fi
    done
    exit 0
fi

# Fail-open: if we couldn't extract a command, allow it
if [[ -z "$CMD" ]]; then
    exit 0
fi

# --- Dangerous pattern definitions ---

# Fixed-string patterns (matched with grep -F)
FIXED_PATTERNS=(
    "rm -rf /"
    "rm -fr /"
    "rm -rf --no-preserve-root"
    "rm -fr --no-preserve-root"
    "git reset --hard"
    "git checkout -- ."
    "git checkout ."
    "git restore ."
    "chmod 777"
)

# Regex patterns (matched with grep -E)
# Note: git push --force and git clean -f use regex to catch flag reordering
# (e.g. "git push origin main --force" or "git clean -x -f")
REGEX_PATTERNS=(
    '(curl|wget)\s+.*\|\s*(bash|sh|zsh)'
    '\bsudo\b'
    '\bmkfs\b'
    '\bdd\s+if='
    '--no-verify'
    'git\s+push\b[^|&;]*(--force|-f\b)'
    'git\s+clean\b[^|&;]*-[a-zA-Z]*f'
)

# --- Check fixed-string patterns ---
for pattern in "${FIXED_PATTERNS[@]}"; do
    if echo "$CMD" | grep -qF "$pattern"; then
        echo "BLOCKED: Command contains dangerous pattern: '$pattern'" >&2
        echo "If you believe this is safe, ask the user for explicit approval." >&2
        exit 2
    fi
done

# --- Check regex patterns ---
for pattern in "${REGEX_PATTERNS[@]}"; do
    if echo "$CMD" | grep -qE -- "$pattern"; then
        echo "BLOCKED: Command matches dangerous pattern: '$pattern'" >&2
        echo "If you believe this is safe, ask the user for explicit approval." >&2
        exit 2
    fi
done

# --- All checks passed ---
exit 0
