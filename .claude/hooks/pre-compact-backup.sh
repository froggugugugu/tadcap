#!/usr/bin/env bash
# ==============================================================================
# pre-compact-backup.sh — PreCompact hook
#
# Backs up the current session transcript before Claude Code compacts it.
# Useful for recovering accidentally lost context or auditing long sessions.
#
# Input:  JSON via stdin (compact event metadata)
# Output: writes transcript snapshot to testreport/transcripts/<session>-<ts>.md
#         (under testreport/, gitignored by the blueprint's .gitignore and the
#          .gitignore entry injected by setup.sh into the target project)
#
# Policy: fail-open (if backup fails, compact proceeds anyway)
# ==============================================================================

set -uo pipefail

# --- Paths ---
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
# Store under testreport/ (already gitignored by the blueprint's setup.sh)
# so that transcripts containing potentially sensitive context don't leak into git.
BACKUP_DIR="$PROJECT_DIR/testreport/transcripts"
# Sanitize SESSION_ID to prevent path traversal (reject `/`, `..`, etc.)
SESSION_ID_RAW="${CLAUDE_SESSION_ID:-$(date +%Y%m%d%H%M%S)}"
SESSION_ID="$(printf '%s' "$SESSION_ID_RAW" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-64)"
[[ -z "$SESSION_ID" ]] && SESSION_ID="$(date +%Y%m%d%H%M%S)"

# --- Read stdin JSON ---
INPUT="$(cat)"

# Fail-open: empty input
if [[ -z "$INPUT" ]]; then
    exit 0
fi

# --- Ensure backup directory exists ---
mkdir -p "$BACKUP_DIR" 2>/dev/null || exit 0

# --- Extract transcript ---
# The PreCompact hook typically receives the transcript content in the payload.
# If jq is available, extract; otherwise use raw input.
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="$BACKUP_DIR/${SESSION_ID}-${TIMESTAMP}.md"

if command -v jq &>/dev/null; then
    # Try structured extraction
    TRANSCRIPT="$(echo "$INPUT" | jq -r '.transcript // .messages // empty' 2>/dev/null)"
    if [[ -n "$TRANSCRIPT" && "$TRANSCRIPT" != "null" ]]; then
        # shellcheck disable=SC2016  # %s are printf format specifiers, not shell expansions
        printf '# Session transcript backup\n\nSession: %s\nTimestamp: %s\n\n---\n\n%s\n' \
            "$SESSION_ID" "$TIMESTAMP" "$TRANSCRIPT" > "$BACKUP_FILE" 2>/dev/null || true
    else
        # Fallback: save raw JSON (fenced code block for readability)
        # shellcheck disable=SC2016  # %s are printf format specifiers, not shell expansions
        printf '# Session transcript backup (raw)\n\nSession: %s\nTimestamp: %s\n\n---\n\n~~~json\n%s\n~~~\n' \
            "$SESSION_ID" "$TIMESTAMP" "$INPUT" > "$BACKUP_FILE" 2>/dev/null || true
    fi
else
    # No jq available — save raw input
    # shellcheck disable=SC2016  # %s are printf format specifiers, not shell expansions
    printf '# Session transcript backup (raw)\n\nSession: %s\nTimestamp: %s\n\n---\n\n%s\n' \
        "$SESSION_ID" "$TIMESTAMP" "$INPUT" > "$BACKUP_FILE" 2>/dev/null || true
fi

# --- Cleanup: keep only last 20 backups per session ---
if [[ -d "$BACKUP_DIR" ]]; then
    # shellcheck disable=SC2012
    ls -1t "$BACKUP_DIR/${SESSION_ID}"-*.md 2>/dev/null | tail -n +21 | xargs -r rm -f 2>/dev/null || true
fi

# Always exit 0 — observation only, never blocks compact
exit 0
