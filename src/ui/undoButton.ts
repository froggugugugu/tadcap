//! 取り消し(Undo)・やり直し(Redo)のツールバーボタン + `Cmd+Z`/`Cmd+Shift+Z`(PRD FR-014、
//! T29【新設 2026-09-24】)。
//!
//! 実行は `canvas/documentState.ts` の `undoDocument()`/`redoDocument()`(【改訂 2026-09-24 T32】
//! コマンド方式。T29の「対象矩形をpeek → getImageData → popUndo(current) → putImageData」は
//! `commands.ts` の入れ替え方式に移った)。
//!
//! 【改訂 2026-09-24 T32】T31の「編集中の図形があれば取り消し=破棄・やり直し無効」は廃止した
//! (描いた直後の図形も通常の追加操作として取り消し・やり直しできる)。取り消し・やり直し
//! ボタンは `data-preserve-selection` 属性で `shapeTools.ts` の「Canvas外のクリックで選択解除」から
//! 除外する(変更の取り消し後も同じオブジェクトを続けて調整できるように)。
//!
//! テキスト入力欄にフォーカスがあるとき(`shortcutGuards.ts::isEditableTarget()`)はキーを奪わず
//! 入力欄自身の取り消しに任せる。ドラッグ中(`canvasState.isDrawing`)はボタン・キーとも無効。
//!
//! AM-T13・AM-T25-F1: 自動マスキングの処理中・確認中(`maskSession` が `idle` 以外)はボタンを無効にし、⌘Z・⇧⌘Z でも
//! 何もしない(ARCH_auto-masking §15 #4 A 案、FR-012)。キーの判定(`undoShortcutCommand`)は
//! 変えないため、確認中の ⌘Z も WebView 既定の取り消しへは流さない。
//!
//! QE-T22: トリミングの範囲の指定中(`cropSession` に範囲がある間)は、⌘Z・⇧⌘Z とボタンのどちらも
//! 範囲の指定をやめるだけ(`cancelCrop()`。画像・取り消しスタックは変えない。ARCH_quick-edits §15 #4 A 案)。
//!
//! 判定は純粋関数としてユニットテストし、DOM/Canvas結線(`initUndoButtons`)はE2Eで検証する。

import { getCanvasState, subscribeCanvasState } from "../canvas/canvasState";
import { cancelCrop, getCropSession, subscribeCropSession } from "../canvas/cropSession";
import { redoDocument, undoDocument } from "../canvas/documentState";
import { isMaskSessionActive, subscribeMaskSession } from "../canvas/maskSession";
import { canRedo, canUndo, subscribeUndoStack } from "../canvas/undoStack";
import { isEditableTarget, type EditableTargetLike } from "./shortcutGuards";

export type UndoShortcutCommand = "undo" | "redo";

/** 実際に行う操作。範囲の指定中は ⌘Z・⇧⌘Z とも`cancelCrop`(QE-T22)。 */
export type UndoAction = UndoShortcutCommand | "cancelCrop";

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
  isDrawing: boolean;
  /** 自動マスキングの処理中・確認中(`maskSession` が `idle` 以外、AM-T13・AM-T25-F1)。省略時は `false`。 */
  isMasking?: boolean;
  /** トリミングの範囲の指定中(`getCropSession() !== null`、QE-T22)。省略時は `false`。 */
  isCropping?: boolean;
}

/**
 * 取り消し・やり直しで実際に行う操作。できなければ `null`
 * (ドラッグ中・自動マスキングの処理中・確認中は両方できない)。範囲の指定中は両方とも`cancelCrop`。
 */
export function resolveUndoCommand(
  command: UndoShortcutCommand,
  context: UndoContext,
): UndoAction | null {
  if (context.isDrawing || context.isMasking === true) {
    return null;
  }
  if (context.isCropping === true) {
    return "cancelCrop";
  }
  const available = command === "undo" ? context.canUndo : context.canRedo;
  return available ? command : null;
}

/** ボタンの有効/無効(`resolveUndoCommand` が操作を返すときだけ有効)。 */
export function undoAvailability(context: UndoContext): { undo: boolean; redo: boolean } {
  return {
    undo: resolveUndoCommand("undo", context) !== null,
    redo: resolveUndoCommand("redo", context) !== null,
  };
}

/** 今のストア(取り消しスタック・`canvasState`・`maskSession`・`cropSession`)から文脈を組み立てる。 */
export function currentUndoContext(): UndoContext {
  return {
    canUndo: canUndo(),
    canRedo: canRedo(),
    isDrawing: getCanvasState().isDrawing,
    isMasking: isMaskSessionActive(),
    isCropping: getCropSession() !== null,
  };
}

function runCommand(command: UndoShortcutCommand): void {
  const action = resolveUndoCommand(command, currentUndoContext());
  if (action === "undo") {
    undoDocument();
  } else if (action === "redo") {
    redoDocument();
  } else if (action === "cancelCrop") {
    cancelCrop();
  }
}

export interface UndoButtonElements {
  undo: HTMLButtonElement;
  redo: HTMLButtonElement;
}

/** 取り消し・やり直しボタンと `Cmd+Z`/`Cmd+Shift+Z` を結線する。戻り値は解除関数。 */
export function initUndoButtons(elements: UndoButtonElements): () => void {
  const render = (): void => {
    const available = undoAvailability(currentUndoContext());
    elements.undo.disabled = !available.undo;
    elements.redo.disabled = !available.redo;
  };

  elements.undo.addEventListener("click", () => runCommand("undo"));
  elements.redo.addEventListener("click", () => runCommand("redo"));

  const handleKeydown = (event: KeyboardEvent): void => {
    const command = undoShortcutCommand(event, event.target as EditableTargetLike | null);
    if (!command) {
      return;
    }
    // 取り消す対象が無いときもWebView既定の取り消しへは流さない。
    event.preventDefault();
    runCommand(command);
  };
  window.addEventListener("keydown", handleKeydown);

  const unsubscribers = [
    subscribeUndoStack(render),
    subscribeCanvasState(render),
    subscribeMaskSession(render),
    subscribeCropSession(render),
  ];
  render();

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    window.removeEventListener("keydown", handleKeydown);
  };
}
