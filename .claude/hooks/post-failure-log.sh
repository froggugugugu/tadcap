#!/usr/bin/env bash
# ==============================================================================
# post-failure-log.sh — PostToolUseFailure hook
#
# Records tool failure events as structured JSONL for debugging and audit.
# Runs AFTER a tool has failed (not blocking — the failure already happened).
#
# Registered on the dedicated `PostToolUseFailure` event (official spec): it fires
# only when a tool that started executing threw an error or an MCP tool returned an
# error result. The payload carries `error` / `is_interrupt` / `duration_ms` at the
# top level. Legacy `tool_result.is_error` payloads are still accepted.
#
# Input:  JSON via stdin  {"tool_name":"...","tool_input":{...},"error":"...","duration_ms":123}
# Output: appends one JSONL line to testreport/failures/<session>.jsonl
#
# Policy: fail-open (if logging fails, we still exit 0)
# ==============================================================================

set -uo pipefail

# --- Paths ---
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
LOG_DIR="$PROJECT_DIR/testreport/failures"
# Sanitize SESSION_ID to prevent path traversal (reject `/`, `..`, etc.)
SESSION_ID_RAW="${CLAUDE_SESSION_ID:-$(date +%Y%m%d)}"
SESSION_ID="$(printf '%s' "$SESSION_ID_RAW" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-64)"
[[ -z "$SESSION_ID" ]] && SESSION_ID="$(date +%Y%m%d)"
LOG_FILE="$LOG_DIR/$SESSION_ID.jsonl"

# --- Read stdin JSON ---
INPUT="$(cat)"

# Fail-open: empty input
if [[ -z "$INPUT" ]]; then
    exit 0
fi

# --- Check if this is actually a failure (fail-secure for audit) ---
# On PostToolUseFailure every invocation is a failure by definition, so the event
# name short-circuits the check. The legacy `is_error` probe remains for payloads
# delivered by a PostToolUse registration.
# Default to "unknown" so that parse errors and malformed payloads are still
# recorded rather than silently dropped (prevents audit evasion).
IS_ERROR="unknown"
if command -v jq &>/dev/null; then
    if [[ "$(echo "$INPUT" | jq -r '.hook_event_name // ""' 2>/dev/null)" == "PostToolUseFailure" ]]; then
        IS_ERROR="true"
    else
        IS_ERROR="$(echo "$INPUT" | jq -r '.tool_result.is_error // .tool_response.is_error // (if .error then "true" else "unknown" end)' 2>/dev/null)"
    fi
    [[ -z "$IS_ERROR" ]] && IS_ERROR="unknown"
else
    # jq-absent fallback: coarse grep-based parse. Without jq we can't be fully
    # authoritative, so we positively identify true/false and otherwise keep
    # IS_ERROR="unknown" (which still gets logged, per fail-secure policy).
    if echo "$INPUT" | grep -qE '"is_error"[[:space:]]*:[[:space:]]*true\b'; then
        IS_ERROR="true"
    elif echo "$INPUT" | grep -qE '"is_error"[[:space:]]*:[[:space:]]*false\b'; then
        IS_ERROR="false"
    fi
fi

# Only skip when we are CERTAIN the tool call was NOT an error.
# Unknown / ambiguous / truthy values all fall through to recording.
case "$IS_ERROR" in
    false|False|0) exit 0 ;;
esac

# --- Extract fields ---
if command -v jq &>/dev/null; then
    TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)"
    # jq's .[0:500] is a character-based slice (multibyte-safe).
    ERROR_MSG="$(echo "$INPUT" | jq -r '(.error // .tool_result.error // .tool_result.content[0].text // "unknown") | tostring | .[0:500]' 2>/dev/null)"
    DURATION_MS="$(echo "$INPUT" | jq -r '(.duration_ms // "") | tostring' 2>/dev/null)"
    IS_INTERRUPT="$(echo "$INPUT" | jq -r '(.is_interrupt // false) | tostring' 2>/dev/null)"
    # Redact sensitive keys and truncate by character count (multibyte-safe).
    # Keys matching token/secret/password/credential/authorization/api[_-]key
    # are replaced with [REDACTED] to prevent leaking secrets into audit logs.
    TOOL_INPUT_SUMMARY="$(echo "$INPUT" | jq -r '
        (.tool_input // {}) | (
          if type == "object" then
            with_entries(
              if (.key | test("(?i)(token|secret|password|credential|authorization|api[_-]?key)"))
              then .value = "[REDACTED]"
              else .
              end
            ) | tojson
          else
            "[non-object tool_input omitted]"
          end
        ) | .[0:500]' 2>/dev/null)"
else
    # sed fallback: use POSIX `[[:space:]]` (BSD/macOS sed doesn't understand `\s`).
    TOOL_NAME="$(echo "$INPUT" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    ERROR_MSG="unknown"
    TOOL_INPUT_SUMMARY="unknown"
    DURATION_MS=""
    IS_INTERRUPT="unknown"
fi

# --- Ensure log directory exists ---
mkdir -p "$LOG_DIR" 2>/dev/null || exit 0

# --- Write JSONL line (escaped) ---
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Use jq to construct the JSON safely if available
if command -v jq &>/dev/null; then
    jq -nc \
        --arg timestamp "$TIMESTAMP" \
        --arg tool "$TOOL_NAME" \
        --arg error "$ERROR_MSG" \
        --arg input_summary "$TOOL_INPUT_SUMMARY" \
        --arg session "$SESSION_ID" \
        --arg duration_ms "${DURATION_MS:-}" \
        --arg is_interrupt "${IS_INTERRUPT:-unknown}" \
        '{timestamp: $timestamp, tool: $tool, error: $error, input_summary: $input_summary, session_id: $session, duration_ms: $duration_ms, is_interrupt: $is_interrupt}' \
        >> "$LOG_FILE" 2>/dev/null || true
else
    # Fallback: manual escaping (best-effort). Keep schema consistent with
    # the jq branch by including input_summary (set to "unknown" when no jq).
    ESCAPED_ERROR="$(echo "$ERROR_MSG" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n')"
    printf '{"timestamp":"%s","tool":"%s","error":"%s","input_summary":"unknown","session_id":"%s","duration_ms":"","is_interrupt":"unknown"}\n' \
        "$TIMESTAMP" "$TOOL_NAME" "$ESCAPED_ERROR" "$SESSION_ID" \
        >> "$LOG_FILE" 2>/dev/null || true
fi

# Always exit 0 — observation only, failure already happened
exit 0
