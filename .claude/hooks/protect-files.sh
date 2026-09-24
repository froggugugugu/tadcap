#!/usr/bin/env bash
# ==============================================================================
# protect-files.sh — PreToolUse hook for Edit/Write tools
#
# Blocks writes to sensitive files (secrets, credentials, critical configs).
# Works even with --dangerously-skip-permissions (hooks are NOT bypassed).
#
# Input:  JSON via stdin  {"tool_name":"Edit","tool_input":{"file_path":"..."}}
# Output: exit 0 = allow, exit 2 = block (stderr message fed back to Claude)
#
# Policy: fail-open (if parsing fails, the write is allowed)
# ==============================================================================

set -uo pipefail

# --- Extract the file path from stdin JSON ---
INPUT="$(cat)"

if command -v jq &>/dev/null; then
    FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null)"
else
    # Fallback: rough extraction without jq
    FILE_PATH="$(echo "$INPUT" | sed -n 's/.*"file_path"\s*:\s*"\([^"]*\)".*/\1/p' | head -1)"
    if [[ -z "$FILE_PATH" ]]; then
        FILE_PATH="$(echo "$INPUT" | sed -n 's/.*"filePath"\s*:\s*"\([^"]*\)".*/\1/p' | head -1)"
    fi
fi

# Fail-open: if we couldn't extract a path, allow it
if [[ -z "$FILE_PATH" ]]; then
    exit 0
fi

# Get the basename for pattern matching
BASENAME="$(basename "$FILE_PATH")"

# --- Protected file patterns ---

# Exact basename matches
PROTECTED_BASENAMES=(
    ".env"
    ".env.local"
    ".env.production"
    ".env.staging"
    ".env.development"
    "id_rsa"
    "id_ed25519"
    "id_ecdsa"
    "id_dsa"
    "credentials.json"
    "service-account.json"
)

# Linter/formatter/toolchain config files (warn + block)
TOOLCHAIN_CONFIGS=(
    "biome.json"
    "biome.jsonc"
    ".eslintrc.js"
    ".eslintrc.cjs"
    ".eslintrc.json"
    ".eslintrc.yml"
    ".eslintrc.yaml"
    ".prettierrc"
    ".prettierrc.js"
    ".prettierrc.cjs"
    ".prettierrc.json"
    ".prettierrc.yml"
    ".prettierrc.yaml"
    ".editorconfig"
)

# Regex patterns on full path
PROTECTED_PATH_PATTERNS=(
    '\.env\.'
    '(^|/)\.git(/|$)'
    '(^|/)\.claude/settings\.json$'
    '(^|/)\.claude/settings\.local\.json$'
    '\.pem$'
    '\.key$'
    '\.p12$'
    '\.pfx$'
    '\.jks$'
    '\.keystore$'
)

# Toolchain config regex patterns on basename or full path
TOOLCHAIN_PATH_PATTERNS=(
    '^eslint\.config\.'
    '^prettier\.config\.'
    '^tsconfig(\..+)?\.json$'
)

# --- Check exact basename matches ---
for protected in "${PROTECTED_BASENAMES[@]}"; do
    if [[ "$BASENAME" == "$protected" ]]; then
        echo "BLOCKED: Writing to protected file: '$FILE_PATH'" >&2
        echo "This file may contain secrets or critical configuration." >&2
        echo "If you need to modify this file, ask the user to do it manually." >&2
        exit 2
    fi
done

# --- Check path pattern matches ---
for pattern in "${PROTECTED_PATH_PATTERNS[@]}"; do
    if echo "$FILE_PATH" | grep -qE "$pattern"; then
        echo "BLOCKED: Writing to protected path pattern: '$FILE_PATH'" >&2
        echo "This file may contain secrets or critical configuration." >&2
        echo "If you need to modify this file, ask the user to do it manually." >&2
        exit 2
    fi
done

# --- Check toolchain config basename matches ---
for protected in "${TOOLCHAIN_CONFIGS[@]}"; do
    if [[ "$BASENAME" == "$protected" ]]; then
        echo "BLOCKED: Writing to toolchain config file: '$FILE_PATH'" >&2
        echo "Linter/formatter settings should not be modified by AI." >&2
        echo "If this change is intentional, ask the user to modify it manually." >&2
        exit 2
    fi
done

# --- Check toolchain config path patterns ---
for pattern in "${TOOLCHAIN_PATH_PATTERNS[@]}"; do
    if echo "$BASENAME" | grep -qE "$pattern"; then
        echo "BLOCKED: Writing to toolchain config file: '$FILE_PATH'" >&2
        echo "Linter/formatter/TypeScript settings should not be modified by AI." >&2
        echo "If this change is intentional, ask the user to modify it manually." >&2
        exit 2
    fi
done

# --- All checks passed ---
exit 0
