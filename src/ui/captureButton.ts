//! キャプチャ開始ボタン(ARCH §3.1 フロントエンド UI 層、§4
//! `src/ui/captureButton.ts`)。
//!
//! T07時点ではボタンクリックで `startCapture()` を呼ぶところまでを担う。
//! Cmd+C バインド(クリップボードコピー用)はT12で追加する。
//! Canvasへの反映は `capture://completed` イベント購読(`main.ts`)が担うため、
//! このモジュールはコマンドの成功/エラー確認のみ行う(T07仕様)。

import { startCapture } from "../ipc/capture";
import { isPermissionDeniedError } from "../ipc/permissions";
import { clearToast, showToast } from "./toast";

export interface CaptureButtonElements {
  button: HTMLButtonElement;
  /** 最小限のエラー表示領域。権限未許可時の専用案内UI(バナー)はT08で追加。 */
  status: HTMLElement;
}

/**
 * キャプチャ開始ボタンにクリックイベントをバインドする(Container相当)。
 *
 * `onPermissionDenied` は画面収録権限未許可(`invoke()` のreject値が
 * `"permission_denied"`)を検知した際に呼ばれる任意のコールバック(T08で追加。
 * `src/main.ts` が `ui/permissionBanner.ts` の表示と結線する、フロントの3入口の
 * 1つ)。`status` 欄への最小限のエラー表示(`captureErrorMessage()`、T07から
 * 存置)とは置き換えず共存させる(T08指示)。
 */
export function initCaptureButton(
  elements: CaptureButtonElements,
  onPermissionDenied?: () => void,
): void {
  elements.button.addEventListener("click", () => {
    void handleCaptureClick(elements, onPermissionDenied);
  });
}

async function handleCaptureClick(
  elements: CaptureButtonElements,
  onPermissionDenied?: () => void,
): Promise<void> {
  clearToast(elements.status);
  elements.button.disabled = true;
  try {
    await startCapture();
    // 成功時(Completed/Cancelledいずれも)のCanvas反映は
    // `capture://completed` イベント購読(main.ts)が担う。Escキャンセル時は
    // イベントが送出されないため、ここでは何もしない(仕様どおり)。
  } catch (error) {
    // SHOULD-4(レビュー2026-09-24): 原因調査のため実際のエラーは握りつぶさずに出す
    // (ユーザー向け文言は`captureErrorMessage()`の短いままにする)。
    console.error("キャプチャの開始に失敗しました", error);
    showToast(elements.status, captureErrorMessage(error), "error");
    if (isPermissionDeniedError(error)) {
      onPermissionDenied?.();
    }
  } finally {
    elements.button.disabled = false;
  }
}

/**
 * `invoke()` のreject値から最小限のエラーメッセージを組み立てる純粋関数。
 *
 * `"permission_denied"` 専用の案内UI(バナー + システム設定を開く導線)は
 * T08で実装するため、T07ではここに最小限の文言を留める。
 */
export function captureErrorMessage(error: unknown): string {
  if (error === "permission_denied") {
    return "画面収録の権限が必要です。";
  }
  if (typeof error === "string") {
    return `キャプチャに失敗しました: ${error}`;
  }
  return "キャプチャに失敗しました。";
}
