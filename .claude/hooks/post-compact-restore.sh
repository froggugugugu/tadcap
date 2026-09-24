#!/usr/bin/env bash
# ==============================================================================
# post-compact-restore.sh — PostCompact hook
#
# 役割: コンパクト完了後に (1) 生成されたサマリを保全し、(2) 次のプロンプトで
#       中核ルールを再注入させるためのマーカーを置く。
#
# 公式仕様上の制約:
#   PostCompact は decision control を一切持たない(additionalContext も不可)。
#   side effect(ログ・外部状態更新)専用のイベントである。
#   そのため「コンパクト後にルールが薄れる」問題は、ここでマーカーを置き、
#   additionalContext を出せる UserPromptSubmit フック側で回収して解決する。
#
# Input:  JSON via stdin
#         {"hook_event_name":"PostCompact","trigger":"manual|auto","compact_summary":"..."}
# Output: なし(stdout は debug log 止まり)。副作用のみ:
#         - testreport/transcripts/<session>-compact-<ts>.md  … サマリ保全
#         - testreport/.post-compact-pending                   … 再注入マーカー
#
# Policy: fail-open(何が失敗しても exit 0。セッションを止めない)
# ==============================================================================

set -uo pipefail

PROFILE="${BLUEPRINT_HOOK_PROFILE:-standard}"
[[ "$PROFILE" == "minimal" ]] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
OUT_DIR="$PROJECT_DIR/testreport/transcripts"
MARKER="$PROJECT_DIR/testreport/.post-compact-pending"

# セッション ID をサニタイズ(パストラバーサル防止)
SESSION_ID_RAW="${CLAUDE_SESSION_ID:-$(date +%Y%m%d)}"
SESSION_ID="$(printf '%s' "$SESSION_ID_RAW" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-64)"
[[ -z "$SESSION_ID" ]] && SESSION_ID="$(date +%Y%m%d)"

INPUT="$(cat 2>/dev/null || true)"
[[ -z "$INPUT" ]] && exit 0

TRIGGER="unknown"
SUMMARY=""
if command -v jq &>/dev/null; then
    TRIGGER="$(printf '%s' "$INPUT" | jq -r '.trigger // "unknown"' 2>/dev/null || echo unknown)"
    SUMMARY="$(printf '%s' "$INPUT" | jq -r '.compact_summary // empty' 2>/dev/null || true)"
fi

mkdir -p "$OUT_DIR" 2>/dev/null || exit 0

TS="$(date -u +%Y%m%dT%H%M%SZ)"
{
    echo "# Compact Summary — $SESSION_ID ($TRIGGER)"
    echo
    echo "- generated_at: $TS"
    echo "- trigger: $TRIGGER"
    echo
    if [[ -n "$SUMMARY" ]]; then
        echo "$SUMMARY"
    else
        echo "_(compact_summary を取得できませんでした。jq 未導入の可能性があります)_"
    fi
} > "$OUT_DIR/$SESSION_ID-compact-$TS.md" 2>/dev/null || true

# 再注入マーカー。user-prompt-submit.sh が次の 1 プロンプトだけ回収して削除する。
mkdir -p "$(dirname "$MARKER")" 2>/dev/null || true
printf '%s\n' "$TRIGGER" > "$MARKER" 2>/dev/null || true

exit 0
