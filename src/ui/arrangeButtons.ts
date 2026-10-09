//! 選択中のオブジェクトの重ね順: 「最前面へ」「最背面へ」ボタン + ショートカット
//! (T34【新設 2026-09-25】、PRD FR-006改訂)。
//!
//! 【判断】ショートカットはmacOS標準のKeynote・Pages・Numbers・フリーボードと同じ
//! ⇧⌘F(最前面へ)/ ⇧⌘B(最背面へ)にした(Figma等の⌘]/⌘[はアプリごとに割り当てが異なり、
//! 日本語配列では`[`/`]`の位置も異なるため)。操作は「1段ずつ」ではなく端まで動かす2種類に絞った
//! (オブジェクトは最大50個・通常は数個で、1段ずつの操作を足してもボタンが増えるだけのため)。
//!
//! ボタンは選択中のみ有効。ツールバーの`data-preserve-selection`(`index.html`)で、押しても
//! `shapeTools.ts`の「Canvas外クリックで選択解除」が働かないようにしている。テキスト入力欄に
//! フォーカスがあるとき・ドラッグ中はキーを奪わない/実行しない。
//!
//! AM-T13: 自動マスキングの確認中(`maskSession` が `review`)はボタンを無効にし、⇧⌘F・⇧⌘B でも
//! 何もしない(ARCH_auto-masking §15 #4 A 案)。有効/無効は純粋関数 `arrangeEnabled()` で判定する。

import { getCanvasState, subscribeCanvasState } from "../canvas/canvasState";
import { arrangeSelected, getDocumentState, subscribeDocument } from "../canvas/documentState";
import { getMaskSession, subscribeMaskSession } from "../canvas/maskSession";
import { isEditableTarget, type EditableTargetLike } from "./shortcutGuards";

export type ArrangeCommand = "front" | "back";

export interface ArrangeShortcutEvent {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** ⇧⌘F → 最前面、⇧⌘B → 最背面。それ以外・入力欄フォーカス中は`null`。 */
export function arrangeShortcutCommand(
  event: ArrangeShortcutEvent,
  target: EditableTargetLike | null,
): ArrangeCommand | null {
  if (!event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey || isEditableTarget(target)) {
    return null;
  }
  const key = event.key.toLowerCase();
  return key === "f" ? "front" : key === "b" ? "back" : null;
}

export interface ArrangeContext {
  hasSelection: boolean;
  isDrawing: boolean;
  /** 自動マスキングの確認中(`maskSession` が `review`、AM-T13)。 */
  isReviewing: boolean;
}

/** 重ね順を変えられるか: 選択中で、ドラッグ中でも自動マスキングの確認中でもないとき。 */
export function arrangeEnabled(context: ArrangeContext): boolean {
  return context.hasSelection && !context.isDrawing && !context.isReviewing;
}

export interface ArrangeButtonElements {
  front: HTMLButtonElement;
  back: HTMLButtonElement;
}

/** ボタンとショートカットを結線する。戻り値は解除関数。 */
export function initArrangeButtons(elements: ArrangeButtonElements): () => void {
  const enabled = (): boolean =>
    arrangeEnabled({
      hasSelection: getDocumentState().selectedId !== null,
      isDrawing: getCanvasState().isDrawing,
      isReviewing: getMaskSession().status === "review",
    });

  const run = (command: ArrangeCommand): void => {
    if (enabled()) {
      arrangeSelected(command);
    }
  };

  const render = (): void => {
    const on = enabled();
    elements.front.disabled = !on;
    elements.back.disabled = !on;
  };

  elements.front.addEventListener("click", () => run("front"));
  elements.back.addEventListener("click", () => run("back"));

  const handleKeydown = (event: KeyboardEvent): void => {
    const command = arrangeShortcutCommand(event, event.target as EditableTargetLike | null);
    if (!command || getDocumentState().selectedId === null) {
      return;
    }
    event.preventDefault();
    run(command);
  };
  window.addEventListener("keydown", handleKeydown);

  const unsubscribers = [
    subscribeDocument(render),
    subscribeCanvasState(render),
    subscribeMaskSession(render),
  ];
  render();

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    window.removeEventListener("keydown", handleKeydown);
  };
}
