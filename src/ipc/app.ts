//! Rustコマンド `activate_app` の呼び出し(v0.2.2、実機不具合「テキスト入力で全角文字が入らない」)。
//!
//! Dock非表示(Accessory)のため、撮影後のエディタは「アプリが非アクティブのまま前面化」されうる
//! (`src-tauri/src/window_front.rs`、B2)。macOSの入力メソッド(日本語IME)はアクティブなアプリの
//! 入力にだけ働くため、テキスト入力欄がフォーカスを得たときにアプリのアクティブ化を要求する
//! (既にアクティブならRust側で何もしない)。
//!
//! `src/ipc/` は Tauri API 以外に依存しない(ARCH §3.2 依存方向ルール)。

import { invoke } from "@tauri-apps/api/core";

/** アプリをアクティブにするRustコマンド名(`commands::activate_app`)。 */
export const ACTIVATE_APP_COMMAND = "activate_app";

/**
 * 1回目の要求のあとに1回だけ再試行するまでの遅延(ms)。
 *
 * 【根拠】macOS 14以降のアクティブ化は協調的で、要求が即座に反映される保証がない
 * (`NSApplication.activate`のドキュメント「does not guarantee that the app will be activated」)。
 * 入力欄を開くクリックの直後は、そのクリック自体によるアクティブ化の処理中と重なりうるため、
 * 少し後にもう一度だけ要求する。既にアクティブならRust側は何もしないので、重ねても害はない。
 * 入力の開始を待たせない短さにする。
 */
export const ACTIVATION_RETRY_DELAY_MS = 150;

type Schedule = (fn: () => void, ms: number) => void;

function send(): void {
  invoke(ACTIVATE_APP_COMMAND).catch((err: unknown) => {
    // 失敗しても入力は続けられるため、エラー表示はしない(英数入力は影響を受けない)。
    console.warn("[tadcap] activate_app failed:", err);
  });
}

/** アプリのアクティブ化を要求する(すぐに1回 + 短い遅延で1回だけ再試行)。 */
export function requestAppActivation(
  schedule: Schedule = (fn, ms) => {
    window.setTimeout(fn, ms);
  },
): void {
  send();
  schedule(send, ACTIVATION_RETRY_DELAY_MS);
}
