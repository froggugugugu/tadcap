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
//! 判定は純粋関数(`selectionKeyAction`)、`window`への結線は`bindSelectionKeys`。
//! テキスト入力中・IME変換中・修飾キー付きの入力は奪わない(`shortcutGuards.ts`と同じ方針)。

import { getDocumentState, removeShapeObject, selectObject } from "../canvas/documentState";
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

export function selectionKeyAction(
  event: SelectionKeyEvent,
  hasSelection: boolean,
  target: EditableTargetLike | null,
): SelectionKeyAction {
  if (!hasSelection || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }
  if (isEditableTarget(target)) {
    return null;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    return "delete";
  }
  return event.key === "Enter" || event.key === "Escape" ? "deselect" : null;
}

/** `window`のkeydownでEnter/Escを結線する。戻り値は解除関数。 */
export function bindSelectionKeys(): () => void {
  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) {
      return;
    }
    const action = selectionKeyAction(
      event,
      getDocumentState().selectedId !== null,
      event.target as EditableTargetLike | null,
    );
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
