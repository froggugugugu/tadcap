//! Rustコマンド `capture_screen` の呼び出し・`capture://completed` イベント購読の
//! 薄いラッパー(ARCH §3.1 フロントエンド IPC 層、§4 `src/ipc/capture.ts`)。
//!
//! `src/ipc/` は Tauri API(`@tauri-apps/api` とそのプラグイン)以外に依存しない
//! (ARCH §3.2 依存方向ルール)。

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * `capture::run()` の成功を通知するTauriイベント名(Rust側
 * `commands::CAPTURE_COMPLETED_EVENT` と一致させる)。
 */
export const CAPTURE_COMPLETED_EVENT = "capture://completed";

/** PRD §5 `Capture.kind`。MVPでは常に `"range"`(ARCH §15 要確認#2 決定A案)。 */
export type CaptureKind = "range";

/** `capture_screen` コマンドの成功結果(Rust `CaptureResult` の camelCase JSON表現)。 */
export interface CaptureResult {
  id: string;
  sourcePath: string;
  kind: CaptureKind;
  /** ISO8601(UTC)文字列。例: `2024-01-01T00:00:00.000Z` */
  createdAt: string;
}

/**
 * `capture_screen` コマンドを呼び出す。
 *
 * 戻り値はコマンドの成功/エラー確認用であり、Canvas反映の主経路ではない
 * (T07仕様: 主経路は {@link onCaptureCompleted} のイベント購読。グローバル
 * ショートカット・トレイメニュー起点(T15・T16)と経路を共通化するため)。
 *
 * Escキャンセル時は画像が生成されないため `null` を返す(エラー扱いしない、
 * Rust側 `commands::capture_screen` の仕様)。失敗時は文字列のまま reject する
 * (`AppError` は文字列としてシリアライズされる。固定文字列
 * `"permission_denied"` は画面収録権限未許可)。
 */
export async function startCapture(): Promise<CaptureResult | null> {
  return invoke<CaptureResult | null>("capture_screen");
}

/** キャプチャ画像のバイト列を返すRustコマンド名(`commands::read_capture_image`)。 */
export const READ_CAPTURE_IMAGE_COMMAND = "read_capture_image";

/**
 * キャプチャ画像(`CaptureResult.sourcePath`)をバイト列としてIPCで受け取り、
 * `image/png` の `Blob` にする(実機不具合②〜⑤の修正)。
 *
 * `convertFileSrc()` のasset URLは webview と別オリジンのため、`<img>` で読んで
 * Canvasへ描画するとCanvasが汚染(tainted)され、`getImageData()`/`toBlob()` が
 * `SecurityError` になる(矢印・モザイク・コピー・履歴が全滅する)。呼び出し側は
 * この `Blob` を `URL.createObjectURL()` で同一オリジン扱いのURLにして読み込む。
 * Rust側は `tauri::ipc::Response` で生バイナリ(`ArrayBuffer`)を返す。パスは
 * キャプチャ専用ディレクトリ直下のPNGのみ許可され、それ以外は文字列でrejectされる。
 */
export async function readCaptureImage(sourcePath: string): Promise<Blob> {
  const buffer = await invoke<ArrayBuffer>(READ_CAPTURE_IMAGE_COMMAND, {
    path: sourcePath,
  });
  return new Blob([buffer], { type: "image/png" });
}

/**
 * `capture://completed` イベントを購読する(Canvas反映の主経路、T07仕様)。
 *
 * 戻り値は購読解除用の {@link UnlistenFn}。
 */
export async function onCaptureCompleted(
  handler: (result: CaptureResult) => void,
): Promise<UnlistenFn> {
  return listen<CaptureResult>(CAPTURE_COMPLETED_EVENT, (event) => {
    handler(event.payload);
  });
}

/**
 * トレイ・グローバルショートカット起点のキャプチャ失敗を通知するTauriイベント名
 * (Rust側 `tray::CAPTURE_ERROR_EVENT` と一致させる。T15で新設、T08で購読開始)。
 *
 * ペイロードは `AppError` の `Display` 文字列で、`capture_screen` のreject値
 * (`startCapture()` の失敗)と同じ形式。固定文字列 `"permission_denied"` は
 * 画面収録権限未許可を表す(`src/ipc/permissions.ts::isPermissionDeniedError()`
 * で判定する)。
 */
export const CAPTURE_ERROR_EVENT = "capture://error";

/**
 * `capture://error` イベントを購読する(アプリ内ボタン以外の起点、T08)。
 *
 * アプリ内ボタン起点の失敗は `startCapture()` のreject値で直接通知されるが、
 * トレイ・グローバルショートカット起点は呼び出し元に戻り値を返せないため、
 * Rust側がこのイベントでエラー種別を一方向通知する(ARCH §1.3 決定#4)。
 *
 * 戻り値は購読解除用の {@link UnlistenFn}。
 */
export async function onCaptureError(
  handler: (message: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(CAPTURE_ERROR_EVENT, (event) => {
    handler(event.payload);
  });
}
