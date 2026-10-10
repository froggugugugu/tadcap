//! トリミングの範囲の整数化と、注釈ごとの「ずらす / 消す」の計画(QE-T19、ARCH_quick-edits §5.1・§7.1 C-3、
//! ADR-002)。
//!
//! 状態・DOM には依存しない純粋関数。ベースの入れ替え・取り消しの手の組み立て・選択の整理は
//! ドキュメントの状態側の `applyCrop()`(QE-T20)が行い、本モジュールは状態のモジュールを import しない
//! (ARCH_quick-edits §3.2)。

import type { Rect } from "./coords";
import type { AnnotationObject } from "./objectModel";
import { shapeUndoRect, type EditableShape } from "./shapeEdit";
import { shapeStyleDiagonal } from "./styleBasis";

/** 残る注釈の形の変更(取り消しの `update` の `before` / `after` にそのまま使う)。 */
export interface CropUpdate {
  id: number;
  before: EditableShape;
  after: EditableShape;
}

/** 消す注釈(取り消しの `remove` にそのまま使う)。`index` は先頭から順に消したときの、消した時点の位置。 */
export interface CropRemoval {
  object: AnnotationObject;
  index: number;
}

export interface CropPlan {
  /** 切り詰めた後のオブジェクト配列(重ね順を保ち、残る注釈だけ。形はずらした後)。 */
  objects: AnnotationObject[];
  /** 形が変わる注釈(配列順)。ずらしても形が同じ注釈は含めない。 */
  updates: CropUpdate[];
  /** 範囲の外へ完全に出た注釈(配列の先頭から順)。 */
  removals: CropRemoval[];
}

/**
 * トリミング範囲を整数化する。左右上下の各辺を四捨五入して `[0, 幅] × [0, 高さ]` に収める
 * (負の幅・高さ = 逆向きのドラッグは向きをそろえる)。幅・高さが 0、または画像全体と同じなら
 * 何もしない(`null`。呼び出し側は取り消しの手も積まない)。
 */
export function normalizeCropRect(rect: Rect, canvasWidth: number, canvasHeight: number): Rect | null {
  const left = clampEdge(Math.min(rect.x, rect.x + rect.width), canvasWidth);
  const right = clampEdge(Math.max(rect.x, rect.x + rect.width), canvasWidth);
  const top = clampEdge(Math.min(rect.y, rect.y + rect.height), canvasHeight);
  const bottom = clampEdge(Math.max(rect.y, rect.y + rect.height), canvasHeight);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) {
    return null;
  }
  if (width === canvasWidth && height === canvasHeight) {
    return null;
  }
  return { x: left, y: top, width, height };
}

/**
 * 注釈ごとに「ずらす / 消す」を決める。描画範囲(`shapeUndoRect()`、線の太さ・影込み)が範囲と
 * 重ならなければ消す。重なれば範囲の左上の分だけずらし、`styleBasis` が無ければ切る前の対角線を付ける
 * (有れば変えない。ARCH_quick-edits §15 #1 B)。`rect` は `normalizeCropRect()` 済みの範囲。
 */
export function planCrop(
  objects: readonly AnnotationObject[],
  rect: Rect,
  canvasWidth: number,
  canvasHeight: number,
): CropPlan {
  const kept: AnnotationObject[] = [];
  const updates: CropUpdate[] = [];
  const removals: CropRemoval[] = [];
  objects.forEach((object, index) => {
    if (!overlaps(shapeUndoRect(object.shape, canvasWidth, canvasHeight), rect)) {
      // 先頭から順に消すので、消した時点の位置は「元の位置 - それまでに消した数」。
      removals.push({ object, index: index - removals.length });
      return;
    }
    const after = withStyleBasis(
      shiftShape(object.shape, -rect.x, -rect.y),
      shapeStyleDiagonal(object.shape, canvasWidth, canvasHeight),
    );
    kept.push({ id: object.id, shape: after });
    if (!sameShape(object.shape, after)) {
      updates.push({ id: object.id, before: object.shape, after });
    }
  });
  return { objects: kept, updates, removals };
}

function clampEdge(value: number, size: number): number {
  return Math.min(Math.max(Math.round(value), 0), size);
}

/** 重なりの面積が正か(辺で接するだけは重ならない)。 */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function shiftShape(shape: EditableShape, dx: number, dy: number): EditableShape {
  switch (shape.kind) {
    case "arrow":
      return {
        ...shape,
        start: { x: shape.start.x + dx, y: shape.start.y + dy },
        end: { x: shape.end.x + dx, y: shape.end.y + dy },
      };
    case "text":
      return { ...shape, x: shape.x + dx, top: shape.top + dy };
    case "stamp":
      return { ...shape, center: { x: shape.center.x + dx, y: shape.center.y + dy } };
    case "rectangle":
    case "ellipse":
    case "spotlight":
      return { ...shape, rect: { ...shape.rect, x: shape.rect.x + dx, y: shape.rect.y + dy } };
  }
}

/** `styleBasis` が無ければ `diagonal` を付ける(有れば変えない)。 */
function withStyleBasis(shape: EditableShape, diagonal: number): EditableShape {
  return shape.styleBasis === undefined ? { ...shape, styleBasis: diagonal } : shape;
}

/** ずらした形が元と同じか(座標の差 0 で `styleBasis` 済み)。形は平らな値と 1 段の点・矩形だけを持つ。 */
function sameShape(a: EditableShape, b: EditableShape): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
