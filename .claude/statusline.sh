#!/usr/bin/env bash
# .claude/statusline.sh — Claude Code カスタムステータスライン
#
# 表示内容: モデル名 / git ブランチ / 推定フェーズ / output-style
# Claude Code は stdin に JSON を渡し、stdout の最初の行を表示する。
# 公式仕様: https://code.claude.com/docs/en/statusline
#
# 推定フェーズは output/ ディレクトリの直近更新から推定する:
#   prd      → 📝 PRD
#   design   → 🎨 Design
#   tasks    → ✅ Tasks
#   reports  → 🔍 Review
#
# fail-open ポリシー: いかなる失敗時も exit 0 + 空行で抜ける(ステータスラインを壊さない)。

set -uo pipefail
trap 'echo ""; exit 0' ERR

input=$(cat)

# JSON から値を抽出(jq に依存しない POSIX-ish 実装)
extract() {
  printf '%s' "$1" | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

model=$(extract "$input" "display_name")
project_dir=$(extract "$input" "project_dir")
output_style=$(extract "$input" "name")  # output_style.name
[ -z "$project_dir" ] && project_dir=$(extract "$input" "current_dir")

branch=""
if [ -n "$project_dir" ] && [ -d "$project_dir/.git" ]; then
  branch=$(git -C "$project_dir" symbolic-ref --short HEAD 2>/dev/null || echo "")
fi

phase=""
if [ -n "$project_dir" ] && [ -d "$project_dir/output" ]; then
  # ディレクトリのみを対象に最新を取得。`find -printf` は GNU 限定で macOS の
  # BSD find は非対応のため、stat による両環境フォールバックで実装。
  latest=$(
    for d in "$project_dir/output"/*/; do
      [ -d "$d" ] || continue
      mtime=$(stat -c '%Y' "$d" 2>/dev/null || stat -f '%m' "$d" 2>/dev/null || echo 0)
      printf '%s %s\n' "$mtime" "$(basename "$d")"
    done | sort -rn | head -1 | cut -d' ' -f2-
  )
  case "$latest" in
    brainstorm) phase="🌱 Brainstorm" ;;
    prd)        phase="📝 PRD" ;;
    design)     phase="🎨 Design" ;;
    tasks)      phase="✅ Tasks" ;;
    reports)    phase="🔍 Review" ;;
  esac
fi

# style 表示は phase-* の場合のみ(冗長を避ける)
style_disp=""
case "$output_style" in
  phase-*) style_disp="🎯 ${output_style#phase-}" ;;
esac

# 組み立て(中黒で区切り)
sep=" · "
out=""
[ -n "$model" ]      && out="${out:+$out$sep}[$model]"
[ -n "$branch" ]     && out="${out:+$out$sep}⎇ $branch"
[ -n "$phase" ]      && out="${out:+$out$sep}$phase"
[ -n "$style_disp" ] && out="${out:+$out$sep}$style_disp"

printf '%s\n' "${out:-Claude Code}"
