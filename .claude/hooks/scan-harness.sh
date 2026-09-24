#!/usr/bin/env bash
# ==============================================================================
# scan-harness.sh — PreToolUse hook (Skill matcher) — Self-SAST + 高リスク skill 抑止
#
# 役割:
#   1. ハーネス自身(.claude/, .mcp.json*, settings.json) の secret/逸脱検出
#   2. constitution.md の hash 監視(改竄検出)
#   3. 高リスク skill(deploy 系)を tool_input.skill で実効ブロック
#      ↑ settings.json の Skill(skill:deploy*) 等の deny と二重化した層。
#        deny は絶対、本フックは profile で緩められる運用層として機能する。
#
# Profile 切替: $BLUEPRINT_HOOK_PROFILE
#   - minimal:  通過のみ
#   - standard: 警告のみ(non-blocking、既定)
#   - strict:   検出時/高リスク skill 起動時にブロック
#
# Input:  JSON via stdin {"tool_name":"Skill","tool_input":{"skill":"..."}}
# Output: exit 0 = allow / exit 2 = block (strict or 高リスク skill)
# Policy: fail-open(パース失敗時は通過)
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

INPUT="$(cat 2>/dev/null || true)"

# ── 1. tool_input.skill 抽出 ──────────────────────────────────────────
SKILL=""
if command -v jq &>/dev/null; then
    SKILL=$(printf '%s' "$INPUT" | jq -r '.tool_input.skill // .tool_input.name // empty' 2>/dev/null)
else
    # jq 未導入時: deploy ブロックが無効化されないよう sed でフォールバック抽出
    SKILL=$(printf '%s' "$INPUT" | sed -n 's/.*"skill"\s*:\s*"\([^"]*\)".*/\1/p' | head -1)
    [[ -z "$SKILL" ]] && SKILL=$(printf '%s' "$INPUT" | sed -n 's/.*"name"\s*:\s*"\([^"]*\)".*/\1/p' | head -1)
fi

# ── 2. 高リスク skill 判定(常に実施、profile 非依存) ─────────────────
case "$SKILL" in
    # 注: `prod-*` は false-positive(prod-test, prod-validate 等)が多いため除外、
    #     明示的な deploy / production プレフィックスのみブロック対象とする
    deploy|deploy-*|*-deploy|production-*|*-production)
        echo "🛡️  scan-harness: 高リスク skill '$SKILL' は実効ブロックされます" >&2
        echo "  理由: 本テンプレートは deploy/production 系 skill を deny 対象としています(settings.json の Skill(skill:...) deny と二重化)" >&2
        echo "  許可するには: settings.local.json で BLUEPRINT_HOOK_PROFILE=minimal を設定" >&2
        exit 2
        ;;
esac

# ── 3. 重い SAST は constitution チェックのみ毎回実施。secret スキャンは
#     一定の skill のみ(security-scan, legal-check, review-fix の前)に絞る ─
NEED_FULL_SCAN=0
case "$SKILL" in
    security-scan|legal-check|review-fix|architecture|prd|"")
        NEED_FULL_SCAN=1
        ;;
esac

PROJECT="${CLAUDE_PROJECT_DIR:-.}"
ISSUES=()

# クロスプラットフォーム sha256: GNU coreutils → shasum (macOS) の順でフォールバック
sha256_of() {
    if command -v sha256sum &>/dev/null; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        echo ""  # どちらも無い → 後段で fail-open
    fi
}

# 3a. constitution.md hash 監視(常に実施 — 軽量、決定論的)
CONST="$PROJECT/constitution.md"
HASH_FILE="$PROJECT/.claude/.constitution.sha256"
if [[ -f "$CONST" && -f "$HASH_FILE" ]]; then
    CURRENT=$(sha256_of "$CONST")
    EXPECTED=$(cat "$HASH_FILE")
    if [[ -n "$CURRENT" && "$CURRENT" != "$EXPECTED" ]]; then
        ISSUES+=("constitution.md が変更されています(ハッシュ不一致)。意図的な変更なら .claude/.constitution.sha256 を更新してください")
    fi
fi

# 3b. settings.local.json が deny を上書きしていないか(常に実施 — 軽量)
LOCAL="$PROJECT/.claude/settings.local.json"
if [[ -f "$LOCAL" ]] && command -v jq &>/dev/null; then
    # deny キーが存在する場合は警告(空配列 [] も deny ルールを上書きするため危険)
    if jq -e 'getpath(["permissions","deny"]) != null' "$LOCAL" >/dev/null 2>&1; then
        ISSUES+=("settings.local.json に permissions.deny が定義されています(空配列 [] は deny ルールを無効化します。共有 settings.json で管理すべき)")
    fi
fi

# 3c. Secret パターン検出(NEED_FULL_SCAN=1 のときのみ実施 — 重い)
# 注: \b 単語境界は BSD grep で挙動が異なるため使用しない(GNU/BSD 両対応のため)
if [[ "$NEED_FULL_SCAN" -eq 1 && -d "$PROJECT/.claude" ]]; then
    SCAN_TARGETS=(
        "$PROJECT/.claude"
        "$PROJECT/CLAUDE.md"
        "$PROJECT/AGENTS.md"
        "$PROJECT/.mcp.json"
        "$PROJECT/.mcp.json.template"
    )
    for target in "${SCAN_TARGETS[@]}"; do
        [[ -e "$target" ]] || continue
        if grep -rEq -- 'AKIA[0-9A-Z]{16}' "$target" 2>/dev/null; then
            ISSUES+=("AWS Access Key ID パターンが ${target} に含まれます")
        fi
        # GitHub PAT(legacy ghp_ + fine-grained github_pat_ 両形式)
        if grep -rEq -- 'ghp_[a-zA-Z0-9]{36}' "$target" 2>/dev/null; then
            ISSUES+=("GitHub PAT (legacy ghp_) パターンが ${target} に含まれます")
        fi
        if grep -rEq -- 'github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}' "$target" 2>/dev/null; then
            ISSUES+=("GitHub PAT (fine-grained github_pat_) パターンが ${target} に含まれます")
        fi
        if grep -rEq -- 'sk-[a-zA-Z0-9]{32,}' "$target" 2>/dev/null; then
            ISSUES+=("API key パターン (sk-...) が ${target} に含まれます")
        fi
    done
fi

# ── 4. 結果出力 ──────────────────────────────────────────────────────
if [[ ${#ISSUES[@]} -eq 0 ]]; then
    exit 0
fi

SUMMARY="scan-harness: 自己 SAST で ${#ISSUES[@]} 件の問題を検出"
for i in "${ISSUES[@]}"; do
    SUMMARY="$SUMMARY"$'\n'"  - $i"
done

case "$PROFILE" in
    strict)
        # exit 2 は stderr が Claude に渡る唯一の経路(公式仕様)
        printf '%s\n' "$SUMMARY" >&2
        echo "(BLUEPRINT_HOOK_PROFILE=strict のため skill 起動をブロックします)" >&2
        exit 2
        ;;
    standard|*)
        # non-blocking: stdout の additionalContext で Claude に伝える
        emit_context PreToolUse "$SUMMARY"
        exit 0
        ;;
esac
