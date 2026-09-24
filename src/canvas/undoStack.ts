//! Undo/Redoスタック(ARCH §5.1 `src/canvas/undoStack.ts`、§6.1・§6.4、PRD FR-014、T23)。
//!
//! 【改訂 2026-09-24 T32】要素をT23の差分エントリ(`{rect, image}`)から`DocumentCommand`
//! (`commands.ts`)に変えた。オブジェクト化で矢印・矩形・円の追加・変更はピクセルを持たない
//! コマンドになり、モザイク・テキスト・上限超過の焼き込みだけがT23と同じ差分方式(変更矩形+
//! 反対側の状態のピクセル1枚)を持つ(メモリ方針はARCH §6.4)。
//!
//! 本モジュールは純粋なスタックのまま保つ(Canvas・ドキュメントに依存しない)。取り消し・
//! やり直しの適用は呼び出し側(`documentState.ts`)が`popUndo(apply)`/`popRedo(apply)`の
//! `apply`で行い、`apply`が返したコマンド(ピクセル系は持ち替え後)を反対側のスタックへ積む。
//!
//! 性質はT23から変えない: LIFO / 各スタック上限[`UNDO_STACK_LIMIT`]=30件(超過分は最も古い
//! ものから破棄) / 新しい操作で Redo をクリア / 新規キャプチャ・履歴切替で`clearUndoStack()`
//! (`documentState.ts::resetDocument()`経由)。

import type { DocumentCommand } from "./commands";

function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

export type { ImageDataLike } from "./commands";

/** Undo/Redo各スタックの保持件数上限(ARCH §6.4、PRD §11リスク)。 */
export const UNDO_STACK_LIMIT = 30;

/** Undo/Redoスタックの状態。配列の末尾が最新。 */
export interface UndoStackState {
  undo: DocumentCommand[];
  redo: DocumentCommand[];
}

export function createUndoStackState(): UndoStackState {
  return { undo: [], redo: [] };
}

function pushCapped(stack: DocumentCommand[], entry: DocumentCommand): DocumentCommand[] {
  const next = [...stack, entry];
  return next.length > UNDO_STACK_LIMIT ? next.slice(next.length - UNDO_STACK_LIMIT) : next;
}

/** 新しい操作を積み、Redoスタックをクリアした状態を返す(PRD FR-014)。 */
export function withPushedCommand(state: UndoStackState, command: DocumentCommand): UndoStackState {
  return { undo: pushCapped(state.undo, command), redo: [] };
}

export interface PopResult {
  state: UndoStackState;
  /** 取り出したコマンド。スタックが空なら`null`(状態は変化しない)。 */
  entry: DocumentCommand | null;
}

/** Undoスタックの最上位を取り出し、`apply(entry)`の戻り値をRedoスタックへ積む。 */
export function withPoppedUndo(
  state: UndoStackState,
  apply: (entry: DocumentCommand) => DocumentCommand,
): PopResult {
  const entry = last(state.undo);
  if (!entry) {
    return { state, entry: null };
  }
  const redo = pushCapped(state.redo, apply(entry));
  return { state: { undo: state.undo.slice(0, -1), redo }, entry };
}

/** `withPoppedUndo()`と対称のRedo版。 */
export function withPoppedRedo(
  state: UndoStackState,
  apply: (entry: DocumentCommand) => DocumentCommand,
): PopResult {
  const entry = last(state.redo);
  if (!entry) {
    return { state, entry: null };
  }
  const undo = pushCapped(state.undo, apply(entry));
  return { state: { undo, redo: state.redo.slice(0, -1) }, entry };
}

export function canUndoState(state: UndoStackState): boolean {
  return state.undo.length > 0;
}

export function canRedoState(state: UndoStackState): boolean {
  return state.redo.length > 0;
}

// --- モジュール単位の薄い状態オブジェクト(`canvasState.ts`と同じ作法、T23) ---

type Listener = (state: UndoStackState) => void;

let state: UndoStackState = createUndoStackState();
const listeners = new Set<Listener>();

export function getUndoStackState(): UndoStackState {
  return state;
}

/** 操作を1つ積む(Redoはクリア)。 */
export function pushCommand(command: DocumentCommand): void {
  state = withPushedCommand(state, command);
  notify();
}

/** 最新の操作を取り出して`apply`で取り消す。空なら`null`。 */
export function popUndo(apply: (entry: DocumentCommand) => DocumentCommand): DocumentCommand | null {
  const result = withPoppedUndo(state, apply);
  state = result.state;
  notify();
  return result.entry;
}

/** `popUndo()`と対称のRedo版。 */
export function popRedo(apply: (entry: DocumentCommand) => DocumentCommand): DocumentCommand | null {
  const result = withPoppedRedo(state, apply);
  state = result.state;
  notify();
  return result.entry;
}

export function canUndo(): boolean {
  return canUndoState(state);
}

export function canRedo(): boolean {
  return canRedoState(state);
}

/** Undo・Redo両スタックを空にする(新規キャプチャ・履歴切替時)。 */
export function clearUndoStack(): void {
  state = createUndoStackState();
  notify();
}

export function subscribeUndoStack(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) {
    listener(state);
  }
}
