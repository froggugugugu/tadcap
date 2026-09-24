//! 取り消し(Undo)・やり直し(Redo)のツールバーボタン + `Cmd+Z`/`Cmd+Shift+Z`(PRD FR-014、
//! T29【新設 2026-09-24】)。
//!
//! 実行は `canvas/undoStack.ts` のAPI契約(T23)どおり、対象の矩形をpeek → その範囲の現在の
//! ピクセルを `getImageData()` → `popUndo(current)`/`popRedo(current)` → 取り出したピクセルを
//! `putImageData()` で書き戻す。
//!
//! 編集中の図形(T31)との関係(【設計判断】T31申し送り):
//! - 編集中の図形があるときの取り消しは `popUndo` ではなく `discardPendingShape()`(描く前へ戻す)。
//!   編集中の図形はまだUndoスタックに積まれていない(確定時に積む)ため。
//! - 編集中の図形がある間はやり直しを無効にする。やり直すと編集中図形の `base`(描く前の画像)と
//!   Canvasの内容が食い違うため。図形を確定すると新規描画としてRedoスタックはクリアされるので、
//!   「確定してからやり直す」も成立しない(無効にしても失う操作はない)。
//! - `shapeTools.ts` は「Canvas外のpointerdownで編集中の図形を確定する」が、取り消し・やり直し
//!   ボタンは `data-preserve-pending-shape` 属性で除外し、ボタンでもキーと同じく破棄になるようにする。
//!
//! テキスト入力欄にフォーカスがあるとき(`shortcutGuards.ts::isEditableTarget()`)はキーを奪わず
//! 入力欄自身の取り消しに任せる。ドラッグ中(`canvasState.isDrawing`)はボタン・キーとも無効。
//!
//! 判定は純粋関数としてユニットテストし、DOM/Canvas結線(`initUndoButtons`)はE2Eで検証する。

import { getCanvasState, subscribeCanvasState } from "../canvas/canvasState";
import {
  discardPendingShape,
  hasPendingShape,
  subscribePendingShape,
} from "../canvas/pendingShape";
import {
  canRedo,
  canUndo,
  getUndoStackState,
  popRedo,
  popUndo,
  subscribeUndoStack,
  type ImageDataLike,
} from "../canvas/undoStack";
import { isEditableTarget, type EditableTargetLike } from "./shortcutGuards";

export type UndoShortcutCommand = "undo" | "redo";

export interface UndoShortcutEvent {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * `Cmd+Z` → 取り消し、`Cmd+Shift+Z` → やり直し。テキスト入力欄にフォーカスがあるとき・
 * ⌘以外の修飾(Ctrl/Option)併用時は `null`(アプリの操作にしない)。
 */
export function undoShortcutCommand(
  event: UndoShortcutEvent,
  target: EditableTargetLike | null,
): UndoShortcutCommand | null {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== "z") {
    return null;
  }
  if (isEditableTarget(target)) {
    return null;
  }
  return event.shiftKey ? "redo" : "undo";
}

export interface UndoContext {
  canUndo: boolean;
  canRedo: boolean;
  hasPendingShape: boolean;
  isDrawing: boolean;
}

export type UndoAction = "discardPendingShape" | "popUndo" | "popRedo";

/** 取り消し・やり直しで実際に行う操作。できなければ `null`。 */
export function resolveUndoCommand(
  command: UndoShortcutCommand,
  context: UndoContext,
): UndoAction | null {
  if (context.isDrawing) {
    return null;
  }
  if (command === "undo") {
    if (context.hasPendingShape) {
      return "discardPendingShape";
    }
    return context.canUndo ? "popUndo" : null;
  }
  return context.canRedo && !context.hasPendingShape ? "popRedo" : null;
}

/** ボタンの有効/無効(`resolveUndoCommand` が操作を返すときだけ有効)。 */
export function undoAvailability(context: UndoContext): { undo: boolean; redo: boolean } {
  return {
    undo: resolveUndoCommand("undo", context) !== null,
    redo: resolveUndoCommand("redo", context) !== null,
  };
}

function currentContext(): UndoContext {
  return {
    canUndo: canUndo(),
    canRedo: canRedo(),
    hasPendingShape: hasPendingShape(),
    isDrawing: getCanvasState().isDrawing,
  };
}

function toImageData(image: ImageDataLike): ImageData {
  if (image instanceof ImageData) {
    return image;
  }
  return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
}

/** Undo/Redoスタックの最上位を取り出し、Canvasへ書き戻す(T23のAPI契約)。 */
function restoreFromStack(canvas: HTMLCanvasElement, action: "popUndo" | "popRedo"): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const { undo, redo } = getUndoStackState();
  const stack = action === "popUndo" ? undo : redo;
  const rect = stack[stack.length - 1]?.rect;
  if (!rect) {
    return;
  }
  const current: ImageDataLike =
    rect.width > 0 && rect.height > 0
      ? ctx.getImageData(rect.x, rect.y, rect.width, rect.height)
      : { data: new Uint8ClampedArray(0), width: 0, height: 0 };
  const entry = action === "popUndo" ? popUndo(current) : popRedo(current);
  if (entry && entry.image.width > 0 && entry.image.height > 0) {
    ctx.putImageData(toImageData(entry.image), entry.rect.x, entry.rect.y);
  }
}

function runCommand(canvas: HTMLCanvasElement, command: UndoShortcutCommand): void {
  const action = resolveUndoCommand(command, currentContext());
  if (action === "discardPendingShape") {
    discardPendingShape();
  } else if (action) {
    restoreFromStack(canvas, action);
  }
}

export interface UndoButtonElements {
  undo: HTMLButtonElement;
  redo: HTMLButtonElement;
}

/** 取り消し・やり直しボタンと `Cmd+Z`/`Cmd+Shift+Z` を結線する。戻り値は解除関数。 */
export function initUndoButtons(
  elements: UndoButtonElements,
  canvas: HTMLCanvasElement,
): () => void {
  const render = (): void => {
    const available = undoAvailability(currentContext());
    elements.undo.disabled = !available.undo;
    elements.redo.disabled = !available.redo;
  };

  elements.undo.addEventListener("click", () => runCommand(canvas, "undo"));
  elements.redo.addEventListener("click", () => runCommand(canvas, "redo"));

  const handleKeydown = (event: KeyboardEvent): void => {
    const command = undoShortcutCommand(event, event.target as EditableTargetLike | null);
    if (!command) {
      return;
    }
    // 取り消す対象が無いときもWebView既定の取り消しへは流さない。
    event.preventDefault();
    runCommand(canvas, command);
  };
  window.addEventListener("keydown", handleKeydown);

  const unsubscribers = [
    subscribeUndoStack(render),
    subscribePendingShape(render),
    subscribeCanvasState(render),
  ];
  render();

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    window.removeEventListener("keydown", handleKeydown);
  };
}
