//! 選択中のオブジェクトのキーボード操作: Enter/Escで選択解除(T31【新設 2026-09-24】の
//! `pendingShapeKeys.ts`を、T32【改訂 2026-09-24】のオブジェクト化に合わせて置き換えた)。
//!
//! T31では Enter=確定・Esc=破棄 だったが、オブジェクトは確定後も再調整できるため両方とも
//! 選択解除にする(消したいときは Cmd+Z、削除キーは T34)。ドラッグ中のEscはそのドラッグの
//! 取り消しで、`tools/shapeTools.ts`が`preventDefault()`して処理する(本モジュールは
//! `defaultPrevented`のイベントを無視する)。
//!
//! T34【改訂 2026-09-25】: Delete/Backspaceで選択中のオブジェクトを削除する。
//!
//! v1.2.0: 矢印キーで選択中のオブジェクトを画像のピクセル単位に 1px(⇧ で 10px)動かす(`selectionMoveDelta`)。
//! 移動は `documentState.ts::moveSelected()`(`moveShape()` で画像の内側に収め、`commitShapeEdit()` で取り消せる 1 手)。
//!
//! AM-T13・AM-T25-F1: 自動マスキングの処理中・確認中(`maskSession` が `idle` 以外)は Enter・Esc・Delete・Backspace を
//! すべて扱わない(ARCH_auto-masking §15 #4 A 案)。削除を止め、Esc は「やめる」(`ui/autoMask.ts`)に
//! 任せる(`preventDefault()` もしない)。
//!
//! リリース前レビュー 2026-10-26: 注釈をドラッグ(描画・移動)している間(`canvasState.isDrawing`)の矢印キーは
//! 扱わない(ドラッグの 1 手の間に移動の 1 手が挟まり、1 回の ⌘Z で戻らなくなるため)。押せる要素(ボタンなど、
//! `canvas/keyTarget.ts::isActivatableTarget()`)にフォーカスがあるときの Enter は選択解除で奪わず、その押下に任せる
//! (トリミングの Enter と同じ判定)。Esc・Delete の扱いは変えない。
//!
//! 判定は純粋関数(`selectionKeyAction`)、`window`への結線は`bindSelectionKeys`。
//! テキスト入力中・IME変換中・修飾キー付きの入力は奪わない(`shortcutGuards.ts`と同じ方針)。

import { getCanvasState } from "../canvas/canvasState";
import type { Point } from "../canvas/coords";
import { getDocumentState, moveSelected, removeShapeObject, selectObject } from "../canvas/documentState";
import { isActivatableTarget, type KeyTargetLike } from "../canvas/keyTarget";
import { isMaskSessionActive } from "../canvas/maskSession";
import { isEditableTarget, type EditableTargetLike } from "./shortcutGuards";

export interface SelectionKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}

export type SelectionKeyAction = "deselect" | "delete" | null;

/** keydown の `target`(入力欄の判定 `isEditableTarget()` と押せる要素の判定 `isActivatableTarget()` の両方が読む部分)。 */
export type SelectionKeyTarget = EditableTargetLike & KeyTargetLike;

/** 矢印キー 1 回の移動量(画像のピクセル)。`Shift` を押しながらなら `MOVE_STEP_SHIFT`(v1.2.0)。 */
export const MOVE_STEP = 1;
export const MOVE_STEP_SHIFT = 10;

/** 矢印キー(`KeyboardEvent.key`)と向き。 */
const ARROW_DIRECTIONS: Readonly<Record<string, Point>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * 選択中のオブジェクトへのキーを受け付けるか(`selectionKeyAction`・`selectionMoveDelta` 共通)。
 * 自動マスキングの処理中・確認中(AM-T13・AM-T25-F1)・選択なし・IME 変換中・⌘ / ⌃ / ⌥ 付き・入力欄は扱わない。
 */
function acceptsSelectionKey(
  event: SelectionKeyEvent,
  hasSelection: boolean,
  target: SelectionKeyTarget | null,
  isMasking: boolean,
): boolean {
  if (isMasking || !hasSelection || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  return !isEditableTarget(target);
}

/**
 * 選択中のオブジェクトに対するキー操作の判定。`isMasking`(自動マスキングの処理中・確認中、AM-T13・AM-T25-F1)が
 * `true` のときはどのキーも扱わない。矢印キーは `selectionMoveDelta()` の役目。押せる要素(ボタンなど)に
 * フォーカスがあるときの Enter は `null`(その要素の押下に任せる。Esc・Delete はフォーカス位置に関わらず扱う)。
 */
export function selectionKeyAction(
  event: SelectionKeyEvent,
  hasSelection: boolean,
  target: SelectionKeyTarget | null,
  isMasking = false,
): SelectionKeyAction {
  if (!acceptsSelectionKey(event, hasSelection, target, isMasking)) {
    return null;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    return "delete";
  }
  if (event.key === "Escape") {
    return "deselect";
  }
  if (event.key === "Enter") {
    return isActivatableTarget(target) ? null : "deselect";
  }
  return null;
}

/**
 * 矢印キーによる選択中のオブジェクトの移動量(画像のピクセル、v1.2.0)。扱わないときは `null`。
 * `Shift` だけは「10px」の修飾として許し、⌘・⌥・⌃ 付きは奪わない。押し続け(`repeat`)は連続移動として扱う
 * (1 押下 = 1 手。見ないので判定に `repeat` は無い)。扱わない条件は `selectionKeyAction()` と同じで、
 * テキストの入力欄では文字カーソルが動くので奪わない。`isDrawing`(注釈のドラッグ中)も扱わない(ドラッグの
 * 1 手の間に移動の 1 手を挟まない)。
 */
export function selectionMoveDelta(
  event: SelectionKeyEvent,
  hasSelection: boolean,
  target: SelectionKeyTarget | null,
  isMasking = false,
  isDrawing = false,
): Point | null {
  if (isDrawing || !acceptsSelectionKey(event, hasSelection, target, isMasking)) {
    return null;
  }
  const direction = ARROW_DIRECTIONS[event.key];
  if (!direction) {
    return null;
  }
  const step = event.shiftKey ? MOVE_STEP_SHIFT : MOVE_STEP;
  return { x: direction.x * step, y: direction.y * step };
}

/** `window`のkeydownでEnter/Esc・Delete/Backspace・矢印キーを結線する。戻り値は解除関数。 */
export function bindSelectionKeys(): () => void {
  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) {
      return;
    }
    const hasSelection = getDocumentState().selectedId !== null;
    const target = event.target as SelectionKeyTarget | null;
    const isMasking = isMaskSessionActive();
    const delta = selectionMoveDelta(event, hasSelection, target, isMasking, getCanvasState().isDrawing);
    if (delta) {
      // v1.2.0: 矢印キーで 1px(⇧ で 10px)動かす。画像の内側に収めて取り消せる 1 手にし(`moveSelected`)、
      // 端で動かなければ手は増えない。画面のスクロール(矢印キーの既定動作)は止める。
      event.preventDefault();
      moveSelected(delta);
      return;
    }
    const action = selectionKeyAction(event, hasSelection, target, isMasking);
    if (!action) {
      return;
    }
    event.preventDefault();
    const { selectedId } = getDocumentState();
    if (action === "delete" && selectedId !== null) {
      // T34: 選択中のオブジェクトを削除(`remove`コマンド、取り消しで元の重ね順へ戻る)。
      removeShapeObject(selectedId);
    } else {
      selectObject(null);
    }
  };
  window.addEventListener("keydown", handleKeydown);
  return () => window.removeEventListener("keydown", handleKeydown);
}
