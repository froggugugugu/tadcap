//! クリップボードコピー操作(ボタン + Cmd+C、ARCH §3.1 フロントエンド UI 層、
//! FR-005、T12)。
//!
//! 目立つ位置に配置する「クリップボードにコピー」ボタンと、アプリウィンドウが
//! フォーカスされている間のみ有効な `Cmd+C`(通常の `keydown` リスナー。
//! `@tauri-apps/plugin-global-shortcut` は使わない=グローバルショートカットでは
//! ない、T12仕様)からコピー操作を起動する(Container相当)。画像未読込時は
//! ボタンを無効化し、Cmd+Cも無視する。テキスト入力中(input/textarea/
//! contentEditable)は Cmd+C を奪わない(T12指示。現状アプリ内にテキスト入力欄は
//! 無いが、要件に明記されているため将来の入力欄追加に備えて実装する)。
//!
//! 有効/無効判定・ショートカット判定・入力欄判定・フィードバック文言は純粋関数
//! として切り出しユニットテストする。DOM生成・イベント結線は`captureButton.ts`/
//! `permissionBanner.ts`と同じ方針でVitestの自動テスト対象外とする
//! (project-config.md §11参照)。
//!
//! T14でコピー成功時のセッション内履歴更新フック(`onCopySuccess`)を追加した
//! (「編集後画像を保持・再読込」PJM決定 2026-09-23。選択中の履歴項目のimage/
//! thumbnailを現在のCanvas内容で上書きする)。本モジュール自体は`history/`を
//! importせず、`src/main.ts`が渡すコールバックを呼ぶだけに留める(ui→ipcの
//! 依存方向を崩さない、T12申し送り)。
//!
//! T22【改訂 2026-09-24】: 入力欄判定(`isEditableTarget()`)は `./shortcutGuards.ts` へ
//! 抽出した(T29の取り消し/やり直し・T27のテキストツールが同じ判定を再利用するため)。
//! 本ファイルは抽出後の関数を再importして使う(挙動不変)。

import {
  copyToClipboard,
  type ClipboardCopyMethod,
  type ClipboardImagePayload,
} from "../ipc/clipboard";
import {
  getCanvasState,
  subscribeCanvasState,
  type CanvasState,
} from "../canvas/canvasState";
import { isEditableTarget, type EditableTargetLike } from "./shortcutGuards";
import { clearToast, showToast } from "./toast";

export interface ClipboardButtonElements {
  button: HTMLButtonElement;
  status: HTMLElement;
}

/** 画像未読込(`image: null`)のときは無効化する(FR-005受け入れ基準)。純粋関数。 */
export function isClipboardCopyEnabled(state: CanvasState): boolean {
  return state.image !== null;
}

interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
}

/**
 * `Cmd+C` の判定(純粋関数)。`metaKey`(macOSの⌘)が押されており、かつキーが
 * `c`/`C` であることを見る。`Ctrl+C` 等 `metaKey` 無しの入力はグローバル対象外
 * (通常のブラウザ/OSのコピー操作と競合しないようにする、T12仕様)。
 */
export function isCopyShortcut(event: ShortcutKeyEvent): boolean {
  return event.metaKey && event.key.toLowerCase() === "c";
}

/** コピー操作の結果(成功2経路 + 失敗)を表す(フィードバック文言の出し分け用)。 */
export type ClipboardFeedback = ClipboardCopyMethod | "error";

/** コピー結果からの短いフィードバック文言(純粋関数、T12仕様「短く表示」)。 */
export function clipboardCopyFeedbackMessage(result: ClipboardFeedback): string {
  switch (result) {
    case "plugin":
      return "クリップボードにコピーしました。";
    case "fallback":
      return "クリップボードにコピーしました(フォールバック経路)。";
    case "error":
      return "クリップボードへのコピーに失敗しました。";
  }
}

/**
 * クリップボードコピーのボタン・`Cmd+C`ショートカットを結線する(Container相当)。
 *
 * `getPayload` は現在のCanvas最終画像をRGBAで取得するコールバック(`main.ts`が
 * `canvas/render.ts::getCanvasImageData()` 経由で渡す。DOM依存のためこのモジュール
 * 自体はCanvas要素を持たない)。画像未読込時は`null`を返す想定。
 *
 * `onCopySuccess`はコピー成功(主経路・フォールバックいずれも)のたびに呼ばれる
 * 任意コールバック(T14。`main.ts`がセッション内履歴の選択中項目を現在のCanvas
 * 内容で上書きするために使う)。
 *
 * 戻り値は購読解除・イベントリスナー解除用の関数。
 */
export function initClipboardButton(
  elements: ClipboardButtonElements,
  getPayload: () => ClipboardImagePayload | null,
  onCopySuccess?: () => void,
): () => void {
  const updateEnabled = (): void => {
    elements.button.disabled = !isClipboardCopyEnabled(getCanvasState());
  };
  updateEnabled();
  const unsubscribe = subscribeCanvasState(updateEnabled);

  const runCopy = async (): Promise<void> => {
    const payload = getPayload();
    if (!payload) {
      return;
    }
    clearToast(elements.status);
    elements.button.disabled = true;
    try {
      const method = await copyToClipboard(payload);
      showToast(elements.status, clipboardCopyFeedbackMessage(method), "info");
      onCopySuccess?.();
    } catch (error) {
      // SHOULD-4(レビュー2026-09-24): 原因調査のため実際のエラー(`ClipboardCopyError`、
      // プラグイン・フォールバック両方の失敗理由を保持)を握りつぶさずに出す。
      console.error("クリップボードへのコピーに失敗しました", error);
      showToast(elements.status, clipboardCopyFeedbackMessage("error"), "error");
    } finally {
      updateEnabled();
    }
  };

  elements.button.addEventListener("click", () => {
    void runCopy();
  });

  const handleKeydown = (event: KeyboardEvent): void => {
    if (!isCopyShortcut(event)) {
      return;
    }
    if (isEditableTarget(event.target as EditableTargetLike | null)) {
      return;
    }
    if (!isClipboardCopyEnabled(getCanvasState())) {
      return;
    }
    event.preventDefault();
    void runCopy();
  };
  window.addEventListener("keydown", handleKeydown);

  return () => {
    unsubscribe();
    window.removeEventListener("keydown", handleKeydown);
  };
}
