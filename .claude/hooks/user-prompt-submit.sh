#!/usr/bin/env bash
# ==============================================================================
# user-prompt-submit.sh — UserPromptSubmit hook
#
# 役割:
#   1. ユーザー入力を Claude が処理する前に検査し、機密語・誤投稿を検出する
#   2. PostCompact 直後の 1 プロンプトだけ、中核ルールを additionalContext で再注入する
#      (PostCompact 自体は decision control を持たず context 注入できないため、
#       post-compact-restore.sh が置いたマーカーをここで回収する)
#
# Profile 切替: $BLUEPRINT_HOOK_PROFILE で挙動切替
#   - minimal:  パススルー(検査スキップ)
#   - standard: 機密パターン検出のみ警告(non-blocking、既定)
#   - strict:   stdout に JSON {"decision":"block"} を出して差し戻し(公式仕様、exit 0)
#
# Input:  JSON via stdin {"prompt": "...", "session_id": "..."}
# Output:
#   exit 0 + stdout JSON hookSpecificOutput.additionalContext = Claude へ文脈注入
#   exit 0 + JSON {"decision":"block","reason":"..."} = プロンプトを差し戻し
#                                                       (公式仕様は exit 2 ではなく exit 0 + JSON)
#
# Policy: fail-open — jq 未導入環境やパース失敗時は素通り(壊さない)。
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

PROFILE="${BLUEPRINT_HOOK_PROFILE:-standard}"
[[ "$PROFILE" == "minimal" ]] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MARKER="$PROJECT_DIR/testreport/.post-compact-pending"

# ── (1) コンパクト直後の中核ルール再注入 ──────────────────────────────
NOTES=""
if [[ -f "$MARKER" ]]; then
    rm -f "$MARKER" 2>/dev/null || true
    NOTES="[post-compact recovery] 直前にコンテキストのコンパクトが行われました。作業を続ける前に次を再確認すること:
  - 不変原則: constitution.md(7 原則)— 特に人間↔AI 責務分離と 5 品質ゲート
  - 横断ルール: AGENTS.md / CLAUDE.md / .claude/rules/*.md
  - 進行中の成果物: output/ 配下の最新ファイルと未完了タスク
  - 直前の要約は testreport/transcripts/ に保全済み。必要なら参照する
  未完了の作業がある場合は、勝手に再設計せず現状の成果物の続きから再開すること。"
fi

# jq が無ければ機密検出は諦める(fail-open)が、再注入メモがあれば先に届ける。
# 脆弱な sed フォールバックは誤検出/見逃しのリスクが高いため使わない。
if ! command -v jq &>/dev/null; then
    [[ -n "$NOTES" ]] && emit_context UserPromptSubmit "$NOTES"
    exit 0
fi

INPUT="$(cat 2>/dev/null || true)"
PROMPT="$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null || true)"
if [[ -z "$PROMPT" ]]; then
    [[ -n "$NOTES" ]] && emit_context UserPromptSubmit "$NOTES"
    exit 0
fi

# ── (2) 機密パターン検出(誤投稿リスク高い) ───────────────────────────
SECRET_PATTERNS=(
    'AKIA[0-9A-Z]{16}'                                     # AWS Access Key ID
    'sk-[a-zA-Z0-9]{32,}'                                  # OpenAI / Anthropic 形式
    'ghp_[a-zA-Z0-9]{36}'                                  # GitHub PAT (legacy)
    'github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}'           # GitHub PAT (fine-grained)
    'gho_[a-zA-Z0-9]{36}'                                  # GitHub OAuth Token
    'xox[baprs]-[a-zA-Z0-9-]+'                             # Slack Token
    '-----BEGIN [A-Z ]+PRIVATE KEY-----'                   # PEM private key
)

DETECTED=""
for pat in "${SECRET_PATTERNS[@]}"; do
    if printf '%s' "$PROMPT" | grep -qE -- "$pat"; then
        DETECTED="$pat"
        break
    fi
done

if [[ -n "$DETECTED" ]]; then
    case "$PROFILE" in
        strict)
            # 公式仕様: stdout に block JSON を出して exit 0(プロンプト差し戻し)
            printf '{"decision":"block","reason":"プロンプトに機密値の可能性のあるパターン (%s) が含まれます。値を [REDACTED] に置換して再送してください。"}\n' "$DETECTED"
            exit 0
            ;;
        standard|*)
            # non-blocking 警告は stdout の additionalContext で Claude に渡す。
            # exit 0 の stderr は debug log 止まりで誰にも届かない(公式仕様)。
            WARN="user-prompt-submit hook: 機密パターン ($DETECTED) を検出しました。プロンプト内のシークレットを伏字化するようユーザーに促してください。値そのものは復唱しないこと。"
            [[ -n "$NOTES" ]] && WARN="$NOTES"$'\n\n'"$WARN"
            emit_context UserPromptSubmit "$WARN"
            exit 0
            ;;
    esac
fi

[[ -n "$NOTES" ]] && emit_context UserPromptSubmit "$NOTES"
exit 0
