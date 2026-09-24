//! 編集中の図形(直前に描いた矢印・矩形・円の1つ)の保持・確定・破棄(T31【新設 2026-09-24】、
//! ARCH §5.4)。
//!
//! 編集中の図形は「描く前のCanvas全体(`base`)」と「図形パラメータ(`shape`)」の組で持ち、
//! Canvasには常に `base` + 図形 を表示する(描画は `tools/shapeTools.ts`)。ハンドルは
//! Canvasではなく重ねたオーバーレイに描くため、Canvasのピクセル(コピー・履歴保存の対象)に
//! ハンドルは写らない。
//!
//! - 確定(`commitPendingShape`): `base` から確定時の外接矩形を切り出して `pushUndoStep()` し、
//!   編集中状態を解除する。Canvasは既に `base` + 図形を表示しているため追加の描画は不要
//!   (これが「焼き込み」)。取り消しは確定済みの操作単位になる。
//! - 破棄(`discardPendingShape`、Esc・編集中のCmd+Z(T29)): Undoへ積まず、登録された
//!   復元関数で `base` をCanvasへ書き戻す。
//! - 画像差し替え(`dropPendingShapeIfImageChanged`): 確定トリガーを経ずにCanvasが差し替わった
//!   場合、`base` は古い画像のため書き戻さず編集中状態だけを捨てる(MUST-1と同じ考え方)。
//!   通常の差し替え経路(新規キャプチャ・履歴切替)は `main.ts` が差し替え前に確定する。
//!
//! 状態管理ライブラリは導入せず、モジュール単位の薄い状態で持つ(`canvasState.ts`と同じ作法)。

import type { CanvasImage } from "./canvasState";
import { cropSnapshotRect, type Rect } from "./coords";
import { shapeUndoRect, type EditableShape } from "./shapeEdit";
import { pushUndoStep, type ImageDataLike } from "./undoStack";

export interface PendingShape {
  shape: EditableShape;
  /** 図形を描く前のCanvas全体(Canvasと同じサイズ)。 */
  base: ImageDataLike;
  /** 作成時に表示していた画像(差し替え検知用、参照比較)。 */
  image: CanvasImage | null;
}

export interface CommitStep {
  rect: Rect;
  before: ImageDataLike;
}

/** 確定時に `pushUndoStep()` へ渡す外接矩形と焼き込み前ピクセルを算出する純粋関数。 */
export function computeCommitStep(pending: PendingShape): CommitStep {
  const { base } = pending;
  const rect = shapeUndoRect(pending.shape, base.width, base.height);
  const before = cropSnapshotRect(base.data, base.width, base.height, rect);
  return { rect, before };
}

type Listener = (pending: PendingShape | null) => void;

let current: PendingShape | null = null;
let restoreCanvas: ((base: ImageDataLike) => void) | null = null;
const listeners = new Set<Listener>();

export function getPendingShape(): PendingShape | null {
  return current;
}

export function hasPendingShape(): boolean {
  return current !== null;
}

/** 新しい編集中の図形を持つ。既存の編集中図形があれば先に確定する(編集できるのは1つだけ)。 */
export function beginPendingShape(pending: PendingShape): void {
  commitPendingShape();
  current = pending;
  notify();
}

/** リサイズ・移動の結果で図形パラメータを置き換える。 */
export function updatePendingShape(shape: EditableShape): void {
  if (!current) {
    return;
  }
  current = { ...current, shape };
  notify();
}

/** 編集中の図形を確定する(Undoへ1ステップ積む)。編集中の図形が無ければ`false`。 */
export function commitPendingShape(): boolean {
  if (!current) {
    return false;
  }
  const step = computeCommitStep(current);
  current = null;
  pushUndoStep(step.rect, step.before);
  notify();
  return true;
}

/** 編集中の図形を破棄し、描く前のCanvasへ戻す。編集中の図形が無ければ`false`。 */
export function discardPendingShape(): boolean {
  if (!current) {
    return false;
  }
  const { base } = current;
  current = null;
  restoreCanvas?.(base);
  notify();
  return true;
}

/**
 * 表示中の画像が編集中図形の作成時と異なれば、書き戻さずに編集中状態を捨てる。
 * 捨てた場合`true`。
 */
export function dropPendingShapeIfImageChanged(image: CanvasImage | null): boolean {
  if (!current || current.image === image) {
    return false;
  }
  current = null;
  notify();
  return true;
}

/** 破棄時にCanvasへ `base` を書き戻す関数を登録する(`tools/shapeTools.ts`が登録)。 */
export function setPendingShapeRestorer(restorer: ((base: ImageDataLike) => void) | null): void {
  restoreCanvas = restorer;
}

export function subscribePendingShape(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) {
    listener(current);
  }
}
