#!/bin/bash
# Installs Tadcap on a Mac (Apple silicon) into /Applications.
#
#   curl -fsSL https://froggugugugu.github.io/tadcap/install.sh | bash
#
# curl does not mark what it downloads with com.apple.quarantine, so the ad-hoc signed, unnotarized app opens
# without the "is damaged" / "cannot verify the developer" alerts a browser download gets. Nothing runs until the
# last line calls main, so a download cut off halfway does nothing.
#
# Options (environment variables, e.g. `... | TADCAP_NO_OPEN=1 bash`):
#   TADCAP_VERSION=0.1.0  install this release instead of the latest
#   TADCAP_APP_DIR=DIR    install into DIR (default /Applications, or ~/Applications when that is not writable)
#   TADCAP_ZIP=FILE       install from a downloaded Tadcap-<version>-arm64.zip instead of GitHub
#   TADCAP_NO_OPEN=1      do not open the app at the end
set -euo pipefail

REPO="froggugugugu/tadcap"
WORK=""
# https only, TLS 1.2 or later, redirects included.
CURL=(curl --proto '=https' --tlsv1.2)

say() { printf '%s\n' "$*"; }
fail() { printf 'tadcap: %s\n' "$*" >&2; exit 1; }
cleanup() { if [ -n "$WORK" ]; then rm -rf "$WORK"; fi; }

# Apple silicon, also when the terminal runs under Rosetta (uname -m then says x86_64).
is_apple_silicon() { [ "$(uname -m)" = arm64 ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; }

# PIDs of the app at $1 (the executable is Contents/MacOS/tadcap; see CFBundleExecutable).
app_pids() {
  ps -axo pid=,command= | awk -v exe="$1/Contents/MacOS/tadcap" '{ pid = $1; sub(/^ *[0-9]+ /, ""); if (index($0, exe) == 1) print pid }'
}

# Tadcap lives in the menu bar, so it is usually running. Ask it to quit (SIGTERM) and wait for it.
stop_app() {
  local pids i
  pids="$(app_pids "$1")"
  [ -n "$pids" ] || return 0
  say "起動中の Tadcap を終了しています..."
  # shellcheck disable=SC2086  # one PID per word
  kill $pids 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [ -z "$(app_pids "$1")" ] && return 0
    sleep 0.5
  done
  fail "Tadcap を終了できませんでした。メニューバーのアイコンから「終了」を選んでから、もう一度実行してください。"
}

# releases/latest redirects to releases/tag/v<version>.
latest_version() {
  local url
  url="$("${CURL[@]}" -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" || return 1
  printf '%s\n' "${url##*/v}"
}

# The sha256 GitHub recorded for asset $2 of release v$1. A download that differs is not installed.
release_digest() {
  local json="$WORK/release.json" i=0 name
  "${CURL[@]}" -fsSL -H 'Accept: application/vnd.github+json' -o "$json" "https://api.github.com/repos/$REPO/releases/tags/v$1" || return 1
  while name="$(plutil -extract "assets.$i.name" raw -o - "$json" 2>/dev/null)"; do
    if [ "$name" = "$2" ]; then
      plutil -extract "assets.$i.digest" raw -o - "$json" 2>/dev/null
      return
    fi
    i=$((i + 1))
  done
  return 1
}

main() {
  [ "$(uname -s)" = Darwin ] || fail "Tadcap は macOS 専用です。"
  is_apple_silicon || fail "配布版は Apple silicon の Mac 向けです。Intel の Mac ではソースからビルドしてください: https://github.com/$REPO"

  local app_dir="${TADCAP_APP_DIR:-}"
  if [ -z "$app_dir" ]; then
    if [ -w /Applications ]; then app_dir=/Applications; else app_dir="$HOME/Applications"; fi
  fi
  local target="$app_dir/Tadcap.app"

  WORK="$(mktemp -d)"
  trap cleanup EXIT

  local zip="${TADCAP_ZIP:-}" version
  if [ -n "$zip" ]; then
    [ -f "$zip" ] || fail "$zip がありません。"
  else
    version="${TADCAP_VERSION:-}"
    if [ -z "$version" ]; then
      version="$(latest_version)" || fail "最新版を調べられませんでした。ネットワークを確かめてください。"
    fi
    version="${version#v}"
    case "$version" in
      "" | *[!0-9.]*) fail "版を読み取れませんでした: $version" ;;
    esac
    local asset="Tadcap-$version-arm64.zip"
    zip="$WORK/$asset"
    say "Tadcap $version をダウンロードしています..."
    "${CURL[@]}" -fL --progress-bar -o "$zip" "https://github.com/$REPO/releases/download/v$version/$asset" \
      || fail "Tadcap $version をダウンロードできませんでした。"
    local want sum
    want="$(release_digest "$version" "$asset")" \
      || fail "ダウンロードを照合する sha256 を GitHub から取れませんでした。入れませんでした。"
    sum="$(shasum -a 256 "$zip")"
    [ "$want" = "sha256:${sum%% *}" ] || fail "ダウンロードしたファイルが公開されたものと一致しません（sha256）。入れませんでした。"
  fi

  # --noqtn: a zip downloaded with a browser must not pass its quarantine mark on to the app.
  ditto -x -k --noqtn "$zip" "$WORK/unpacked" || fail "$zip を展開できませんでした。"
  local app="$WORK/unpacked/Tadcap.app" got
  [ -d "$app" ] || fail "$zip に Tadcap.app が入っていません。"
  codesign --verify --deep --strict "$app" >/dev/null 2>&1 \
    || fail "Tadcap.app の署名を確かめられませんでした。ダウンロードが壊れている可能性があるので、入れませんでした。"
  got="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || true)"

  mkdir -p "$app_dir" || fail "$app_dir を作れませんでした。"
  stop_app "$target"
  if [ -e "$target" ]; then
    mv "$target" "$WORK/previous.app" || fail "$target を置き換えられませんでした。"
  fi
  if ! mv "$app" "$target"; then
    if [ -e "$WORK/previous.app" ]; then mv "$WORK/previous.app" "$target"; fi
    fail "$target に入れられませんでした。"
  fi
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
  say "Tadcap ${got:-} を $target に入れました。"

  if [ "${TADCAP_NO_OPEN:-}" != 1 ]; then open "$target" || true; fi

  say ""
  say "Tadcap はメニューバーに常駐します（Dock には出ません）。⌘⇧2 でキャプチャを始めます。"
  say "初めてキャプチャするときは、画面収録の許可が要ります。案内の「システム設定を開く」から、"
  say "「プライバシーとセキュリティ」→「画面収録」で Tadcap をオンにし、Tadcap を起動し直してください。"
  say "更新した後に撮れなくなったときは、同じ画面で Tadcap を一度オフにしてオンにし直すか、一覧から削除して追加し直してください。"
}

main
