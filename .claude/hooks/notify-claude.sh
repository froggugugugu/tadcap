#!/usr/bin/env bash
# ntfy.sh経由でスマホにプッシュ通知・双方向通信するスクリプト
#
# 使い方:
#   notify-claude.sh stop                 — 完了通知
#   notify-claude.sh notify               — stdin の JSON からメッセージを送信（fire-and-forget）
#   notify-claude.sh notify --wait [秒]   — 通知送信 + 応答待ち（デフォルト120秒）
#
# --wait モードの応答フロー:
#   1. リクエストID(4文字hex)を生成し、メッセージ先頭に [ID] を付与
#   2. Yes/No/Reply の3アクションボタン付きで通知送信
#   3. 応答トピック({TOPIC}-res)をJSON streamで購読
#   4. リクエストIDで照合し、一致した応答をstdoutに出力
#   5. stdout: "yes" / "no" / 自由テキスト / タイムアウト時はフォールバック値
#
# タイムアウトフォールバック:
#   ntfy-timeout-fallback.txt の1行目を返す（デフォルト: "timeout"）
#   用途に応じて "yes" / "no" / "timeout" / 任意の文字列に設定可能
#   exit code: タイムアウト時は 2（正常応答時は 0）
#
# テスト方法:
#   echo '{"message":"テスト"}' | ./notify-claude.sh notify
#   echo '{"message":"デプロイOK？"}' | ./notify-claude.sh notify --wait 30
#   # 別ターミナル: curl -d "XXXX:yes" https://ntfy.sh/{TOPIC}-res

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOPIC_FILE="${SCRIPT_DIR}/ntfy-topic.txt"

if [ ! -f "$TOPIC_FILE" ]; then
  exit 0
fi

NTFY_TOPIC="$(head -1 "$TOPIC_FILE" | tr -d '[:space:]')"
NTFY_URL="https://ntfy.sh/${NTFY_TOPIC}"
RESPONSE_TOPIC="${NTFY_TOPIC}-res"
RESPONSE_URL="https://ntfy.sh/${RESPONSE_TOPIC}"

generate_request_id() {
  od -An -tx1 -N2 /dev/urandom | tr -d ' \n'
}

# タイムアウト時のフォールバック値を取得
# ntfy-timeout-fallback.txt があればその1行目、なければ "timeout"
get_timeout_fallback() {
  local fallback_file="${SCRIPT_DIR}/ntfy-timeout-fallback.txt"
  if [ -f "$fallback_file" ]; then
    head -1 "$fallback_file" | tr -d '[:space:]'
  else
    echo "timeout"
  fi
}

event_type="${1:-notify}"

case "$event_type" in
  stop)
    curl -s -d "Claude Code: タスクが完了しました" "$NTFY_URL" >/dev/null 2>&1 || true
    ;;

  notify)
    # stdinからNotificationイベントのJSONを読み取る
    input=$(cat)
    message=$(echo "$input" | jq -r '.message // empty' 2>/dev/null)
    if [ -z "$message" ]; then
      message="Claude Code: 入力を待っています"
    fi

    # --wait オプション判定
    shift
    wait_mode=false
    wait_timeout=120
    while [ $# -gt 0 ]; do
      case "$1" in
        --wait)
          wait_mode=true
          if [ -n "${2:-}" ] && [[ "${2:-}" =~ ^[0-9]+$ ]]; then
            wait_timeout="${2:-}"
            shift
          fi
          ;;
      esac
      shift
    done

    if [ "$wait_mode" = false ]; then
      # fire-and-forget: 通知のみ
      curl -s -d "$message" "$NTFY_URL" >/dev/null 2>&1 || true
    else
      # ブロッキング: リクエストID付き通知 + 応答待ち
      request_id=$(generate_request_id)
      tagged_message="[${request_id}] ${message}"

      # アクションボタン付き通知送信（JSON形式）
      payload=$(jq -n \
        --arg topic "$NTFY_TOPIC" \
        --arg msg "$tagged_message" \
        --arg res_url "$RESPONSE_URL" \
        --arg yes_body "${request_id}:yes" \
        --arg no_body "${request_id}:no" \
        --arg reply_url "https://ntfy.sh/${RESPONSE_TOPIC}" \
        '{
          topic: $topic,
          message: $msg,
          title: "Claude Code",
          priority: 4,
          actions: [
            { action: "http", label: "Yes", url: $res_url, body: $yes_body, clear: true },
            { action: "http", label: "No", url: $res_url, body: $no_body, clear: true },
            { action: "view", label: "Reply", url: $reply_url, clear: true }
          ]
        }')

      curl -s -d "$payload" "$NTFY_URL" >/dev/null 2>&1

      # JSON stream で応答待ち（リクエストID照合）
      matched=false
      while IFS= read -r line; do
        event=$(echo "$line" | jq -r '.event // empty' 2>/dev/null)
        [ "$event" = "message" ] || continue

        msg=$(echo "$line" | jq -r '.message // empty' 2>/dev/null)
        if [[ "$msg" == "${request_id}:"* ]]; then
          answer="${msg#"${request_id}":}"
          echo "$answer"
          matched=true
          break
        fi
      done < <(timeout "$wait_timeout" curl -s -N "${RESPONSE_URL}/json?since=now" 2>/dev/null)

      if [ "$matched" = false ]; then
        get_timeout_fallback
        exit 2
      fi
    fi
    ;;

  *)
    curl -s -d "Claude Code: ${event_type}" "$NTFY_URL" >/dev/null 2>&1 || true
    ;;
esac
