#!/usr/bin/env bash
# ==============================================================================
# scope-guard.sh — 書込可能な subagent の書込範囲を強制する PreToolUse フック
#
# 登録先: subagent の frontmatter(settings.json ではない)。その agent の実行中だけ有効。
#   hooks:
#     PreToolUse:
#       - matcher: "Edit|Write|NotebookEdit"
#         hooks:
#           - type: command
#             command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/scope-guard.sh docs'
#
# なぜ必要か: doc-synchronizer / doc-writer は permissionMode: acceptEdits で
# 権限確認を省く。範囲制限が本文の散文だけだと、範囲外への書込も無確認で通る。
# 公式ガイド「必ず守らせる制約は指示ではなくフックにする」に従い決定論的に止める。
#
# スコープ(第 1 引数):
#   docs    docs/** と project-config.md       (doc-synchronizer)
#   output  output/**                           (doc-writer)
#   tests   テストファイルとテスト用ディレクトリ (test-writer)
#
# Input:  JSON via stdin {"tool_name":"Edit","tool_input":{"file_path":"..."}}
# Output: exit 0 = 許可 / exit 2 = ブロック(stderr が理由として agent に返る)
# Policy: 入力のパース失敗は fail-open。未知のスコープ指定は設定ミスとして fail-closed
# ==============================================================================

set -uo pipefail

SCOPE="${1:-}"

block() {
    echo "BLOCKED(scope-guard:${SCOPE}): $1" >&2
    echo "この agent の書込範囲は「${SCOPE_DESC:-未定義}」です。範囲外の変更が必要なら親セッションに報告してください。" >&2
    exit 2
}

case "$SCOPE" in
    docs)   SCOPE_DESC="docs/** と project-config.md" ;;
    output) SCOPE_DESC="output/**" ;;
    tests)  SCOPE_DESC="テストファイル(*.test.* / *.spec.* / tests/ / e2e/ / __tests__/ / fixtures/)" ;;
    *)      SCOPE_DESC=""; block "未知のスコープ '${SCOPE}' が指定されています(docs / output / tests のいずれか)" ;;
esac

command -v jq &>/dev/null || exit 0

INPUT="$(cat 2>/dev/null || true)"
FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)"
[[ -z "$FILE_PATH" ]] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
case "$FILE_PATH" in
    "$PROJECT_DIR"/*) REL="${FILE_PATH#"$PROJECT_DIR"/}" ;;
    /*)               block "プロジェクト外のパスには書き込めません: $FILE_PATH" ;;
    *)                REL="${FILE_PATH#./}" ;;
esac

# パストラバーサル(../)で範囲外に出る書込を拒否する
if [[ "/$REL/" == *"/../"* ]]; then
    block "パスに ../ が含まれます: $FILE_PATH"
fi

BASE="${REL##*/}"
allowed=0
case "$SCOPE" in
    docs)
        [[ "$REL" == docs/* || "$REL" == "project-config.md" ]] && allowed=1
        ;;
    output)
        [[ "$REL" == output/* ]] && allowed=1
        ;;
    tests)
        [[ "$REL" == tests/* || "$REL" == test/* || "$REL" == e2e/* || "$REL" == __tests__/* \
            || "$REL" == */__tests__/* || "$REL" == */__mocks__/* || "$REL" == */fixtures/* \
            || "$REL" == testreport/* ]] && allowed=1
        [[ "$BASE" == *.test.* || "$BASE" == *.spec.* || "$BASE" == test_*.py \
            || "$BASE" == *_test.py || "$BASE" == *_test.go ]] && allowed=1
        ;;
esac

(( allowed == 1 )) && exit 0
block "範囲外のファイルです: $REL"
