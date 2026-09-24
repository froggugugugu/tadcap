#!/usr/bin/env bash
# ==============================================================================
# verify-gate.sh — 検証ゲート(PostToolUse で記録 / Stop で判定)
#
# 公式ベストプラクティス「Claude に検証手段(テスト・ビルド・lint)を与え、
# Stop フックで決定論的にゲートする」の実装。
# 「動くはず」で終わる trust-then-verify gap(pitfalls #19)を機械的に塞ぐ。
#
# 使い方(settings.json):
#   PostToolUse (Bash|Edit|Write|NotebookEdit) → verify-gate.sh track
#   Stop                                       → verify-gate.sh gate
#   TaskCompleted                              → verify-gate.sh task
#
# track: ソースファイル編集 / 検証コマンド実行の時刻を testreport/.verify/ に記録
# gate : 最後の編集より後に検証コマンドが無ければ
#          standard: systemMessage で人間に警告(non-blocking)
#          strict  : {"decision":"block"} で 1 回だけ差し戻し
#          minimal : 何もしない
# task : TaskCompleted(タスクを完了にマークする直前)で同じ条件を判定
#          standard: systemMessage で警告 / strict: exit 2 で完了マークを差し止め
#          (品質ゲート③「検証なしに完了にしない」を機械的に強制する)
#
# 無限ループ防止(公式仕様準拠):
#   - stop_hook_active == true(自分の差し戻し後の再停止)は必ず通す
#   - background_tasks が空でない(完了ではなく待機中)ときは通す
#   - Claude Code 自身も 8 回連続ブロックで強制終了する
#
# Input:  JSON via stdin(track: tool_name/tool_input, gate: stop_hook_active 等)
# Output: gate のみ stdout JSON。exit は常に 0
# Policy: fail-open(jq 不在・パース失敗・書込失敗はすべて通過)
# ==============================================================================

set -uo pipefail

MODE="${1:-gate}"
PROFILE="${BLUEPRINT_HOOK_PROFILE:-standard}"
[[ "$PROFILE" == "minimal" ]] && exit 0
command -v jq &>/dev/null || exit 0

INPUT="$(cat 2>/dev/null || true)"
[[ -z "$INPUT" ]] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
SID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)"
SID="${SID:0:16}"
STATE_DIR="$PROJECT_DIR/testreport/.verify"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
EDIT_MARK="$STATE_DIR/$SID.edit"
VERIFY_MARK="$STATE_DIR/$SID.verify"

# 検証コマンドとみなすパターン(grep -E、大文字小文字無視)
VERIFY_PATTERNS=(
    '(npm|pnpm|yarn|bun) (run )?(test|lint|typecheck|type-check|check|build|e2e|verify|validate)'
    'npx (vitest|jest|playwright|tsc|eslint|biome|prettier|depcruise|mocha)'
    '(^|[;&| ])(vitest|jest|pytest|ruff|mypy|pyright|tsc|eslint|biome|rspec|phpunit|mocha)( |$)'
    'python3? -m (pytest|unittest|mypy|ruff)'
    'cargo (test|check|clippy)'
    'go (test|vet|build)'
    'make (test|lint|check|verify|build)'
    '(dotnet|swift|flutter|deno|mix|xcodebuild) test'
    '(gradle|gradlew|mvn) (test|check|verify)'
    'playwright test'
    'validate-harness'
)

# 検証対象外とみなすパス(ドキュメント・成果物・設定)
NON_SOURCE_RE='(^|/)(output|docs|input|testreport|\.claude|\.github|node_modules|dist|build|coverage)(/|$)|\.(md|txt|json|ya?ml|toml|lock|csv|svg|png|jpg)$'

case "$MODE" in
    track)
        TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
        case "$TOOL" in
            Bash)
                CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"
                [[ -z "$CMD" ]] && exit 0
                for pat in "${VERIFY_PATTERNS[@]}"; do
                    if printf '%s' "$CMD" | grep -qiE -- "$pat"; then
                        date +%s > "$VERIFY_MARK" 2>/dev/null
                        break
                    fi
                done
                ;;
            Edit|Write|NotebookEdit)
                FP="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)"
                [[ -z "$FP" ]] && exit 0
                REL="${FP#"$PROJECT_DIR"/}"
                if ! printf '%s' "$REL" | grep -qE -- "$NON_SOURCE_RE"; then
                    date +%s > "$EDIT_MARK" 2>/dev/null
                fi
                ;;
        esac
        exit 0
        ;;

    gate|task)
        [[ -f "$EDIT_MARK" ]] || exit 0

        if [[ "$MODE" == "gate" ]]; then
            ACTIVE="$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)"
            [[ "$ACTIVE" == "true" ]] && exit 0

            BG="$(printf '%s' "$INPUT" | jq -r '(.background_tasks // []) | length' 2>/dev/null)"
            [[ -n "$BG" && "$BG" != "0" ]] && exit 0
        fi

        EDIT_TS="$(cat "$EDIT_MARK" 2>/dev/null || echo 0)"
        VERIFY_TS=0
        [[ -f "$VERIFY_MARK" ]] && VERIFY_TS="$(cat "$VERIFY_MARK" 2>/dev/null || echo 0)"
        [[ "$EDIT_TS" =~ ^[0-9]+$ ]] || exit 0
        [[ "$VERIFY_TS" =~ ^[0-9]+$ ]] || VERIFY_TS=0
        (( VERIFY_TS >= EDIT_TS )) && exit 0

        if [[ "$MODE" == "task" ]]; then
            # TaskCompleted は exit 2(stderr が Claude へ返る)で完了マークを差し止める
            if [[ "$PROFILE" == "strict" ]]; then
                echo "verify-gate(strict): ソース編集後に検証コマンドが実行されていないため、このタスクを完了にできません。テスト / lint / 型チェックを実行し、結果を示してから完了にしてください。" >&2
                exit 2
            fi
            jq -nc --arg m "verify-gate: 検証コマンド未実行のままタスクが完了にマークされました。完了報告に検証結果(証拠)があるか確認してください。" '{systemMessage:$m}'
            exit 0
        fi

        if [[ "$PROFILE" == "strict" ]]; then
            REASON="verify-gate(strict): ソース編集後に検証コマンド(テスト / lint / 型チェック / ビルド)の実行が記録されていません。project-config.md §3 または docs/project.md の検証コマンドを実行し、結果(pass/fail 件数・エラー数)を証拠として提示してから完了してください。検証基盤が未導入なら「未実施(N/A)+ 理由 + 次アクション」を明記して終了してください。"
            jq -nc --arg r "$REASON" '{decision:"block", reason:$r}'
        else
            MSG="verify-gate: ソース編集後に検証コマンドの実行が記録されていません。完了報告に検証結果(証拠)が含まれているか確認してください(strict プロファイルでは差し戻します)。"
            jq -nc --arg m "$MSG" '{systemMessage:$m}'
        fi
        exit 0
        ;;

    *)
        exit 0
        ;;
esac
