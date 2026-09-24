//! 編集中の図形(T31)のキーボード操作: Enterで確定、Escで破棄(T31【新設 2026-09-24】)。
//!
//! 判定は純粋関数(`pendingShapeKeyAction`)、`window`への結線は`bindPendingShapeKeys`。
//! テキスト入力中・IME変換中・修飾キー付きの入力は奪わない(`shortcutGuards.ts`と同じ方針。
//! T27のテキストツールの入力欄でEnter/Escを横取りしないため)。

import {
  commitPendingShape,
  discardPendingShape,
  hasPendingShape,
} from "../canvas/pendingShape";
import { isEditableTarget, type EditableTargetLike } from "./shortcutGuards";

export interface PendingShapeKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}

export type PendingShapeKeyAction = "commit" | "discard" | null;

export function pendingShapeKeyAction(
  event: PendingShapeKeyEvent,
  hasPending: boolean,
  target: EditableTargetLike | null,
): PendingShapeKeyAction {
  if (!hasPending || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }
  if (isEditableTarget(target)) {
    return null;
  }
  if (event.key === "Enter") {
    return "commit";
  }
  if (event.key === "Escape") {
    return "discard";
  }
  return null;
}

/** `window`のkeydownでEnter/Escを結線する。戻り値は解除関数。 */
export function bindPendingShapeKeys(): () => void {
  const handleKeydown = (event: KeyboardEvent): void => {
    const action = pendingShapeKeyAction(
      event,
      hasPendingShape(),
      event.target as EditableTargetLike | null,
    );
    if (!action) {
      return;
    }
    event.preventDefault();
    if (action === "commit") {
      commitPendingShape();
    } else {
      discardPendingShape();
    }
  };
  window.addEventListener("keydown", handleKeydown);
  return () => window.removeEventListener("keydown", handleKeydown);
}
