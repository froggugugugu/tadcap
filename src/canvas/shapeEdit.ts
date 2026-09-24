//! 編集中の図形(矢印・矩形・円)の幾何計算(T31【新設 2026-09-24】、PRD FR-006/007/011改訂、
//! ARCH §5.4)。
//!
//! 矢印・矩形・円は pointerup で即焼き込みせず、直前に描いた1つだけを「編集中の図形」として
//! 保持し、ハンドルでリサイズ・内側(矢印は胴体)ドラッグで移動できる。本モジュールはその
//! 図形パラメータ(`EditableShape`)に対する作成・ハンドル列挙・ヒットテスト・リサイズ・移動・
//! 取り消し用外接矩形・カーソル選択・pointerdown時の分岐判定を、DOM非依存の純粋関数として
//! 提供する(ユニットテスト対象)。描画とポインタ結線は `tools/shapeTools.ts`、編集中図形の
//! 保持・確定・破棄は `pendingShape.ts` が担う。
//!
//! 【改訂 2026-09-24 T32】「編集中の図形1つ」を「選択中のオブジェクト」に一般化した
//! (`pendingShape.ts`は廃止し、オブジェクトの保持は`documentState.ts`)。ハンドル・当たり判定・
//! リサイズ・移動の純粋関数はそのまま選択中のオブジェクトに使い、`decidePointerDown()`だけが
//! オブジェクト配列(最前面からの当たり判定、`objectModel.ts::pickObjectAt()`)を見るようにした。
//!
//! ツール固有の算出(線幅・正方形拘束・外接矩形)は各ツールファイルの既存純粋関数を再利用し、
//! 本モジュールで式を複製しない。

import type { ToolId } from "./canvasState";
import type { Point, Rect } from "./coords";
import { findObject, pickObjectAt, type AnnotationObject } from "./objectModel";
import {
  arrowLineWidth,
  computeArrowGeometry,
  computeTaperArrowBoundingRect,
  computeTaperArrowPolygon,
} from "./tools/arrowTool";
import {
  computeEllipseBoundingRect,
  computeEllipseGeometry,
  computeEllipseCenterAndRadii,
  ellipseLineWidth,
} from "./tools/ellipseTool";
import {
  computeRectangleBoundingRect,
  computeRectangleGeometry,
  rectangleLineWidth,
} from "./tools/rectangleTool";

/** 編集中にできる図形の種類(モザイクは即焼き込みのため対象外)。 */
export type ShapeKind = "arrow" | "rectangle" | "ellipse";

export interface ArrowShape {
  kind: "arrow";
  start: Point;
  end: Point;
  color: string;
}

/** 矩形・円(外接矩形で表す)。`rect`は正規化・Canvas範囲内クリップ済み。 */
export interface BoxShape {
  kind: "rectangle" | "ellipse";
  rect: Rect;
  color: string;
}

export type EditableShape = ArrowShape | BoxShape;

/** 矢印は始点・終点、矩形・円は四隅(北西・北東・南西・南東)。 */
export type HandleId = "start" | "end" | "nw" | "ne" | "sw" | "se";

export interface ShapeHandle {
  id: HandleId;
  point: Point;
}

export type ShapeHit = { type: "handle"; handle: HandleId } | { type: "body" } | null;

/** ドラッグ1回分の操作(新規作成・ハンドルでのリサイズ・本体の移動)。 */
export type EditSession =
  | { mode: "create"; kind: ShapeKind; origin: Point; color: string }
  | { mode: "resize"; handle: HandleId; initial: EditableShape }
  | { mode: "move"; origin: Point; initial: EditableShape };

export function isShapeTool(tool: ToolId | null): tool is ShapeKind {
  return tool === "arrow" || tool === "rectangle" || tool === "ellipse";
}

/**
 * ドラッグの始点・終点から図形を作る。誤クリック(各ツールの最小ドラッグ距離未満)は`null`
 * (既存の`compute*Geometry()`のガード条件をそのまま使う)。
 */
export function createShapeFromDrag(
  kind: ShapeKind,
  start: Point,
  end: Point,
  color: string,
  canvasWidth: number,
  canvasHeight: number,
  shiftKey: boolean,
): EditableShape | null {
  if (kind === "arrow") {
    if (!computeArrowGeometry(start, end, canvasWidth, canvasHeight)) {
      return null;
    }
    return { kind, start, end, color };
  }
  const geometry =
    kind === "rectangle"
      ? computeRectangleGeometry(start, end, canvasWidth, canvasHeight, shiftKey)
      : computeEllipseGeometry(start, end, canvasWidth, canvasHeight, shiftKey);
  return geometry ? { kind, rect: geometry.rect, color } : null;
}

export function getShapeHandles(shape: EditableShape): ShapeHandle[] {
  if (shape.kind === "arrow") {
    return [
      { id: "start", point: shape.start },
      { id: "end", point: shape.end },
    ];
  }
  const { x, y, width, height } = shape.rect;
  return [
    { id: "nw", point: { x, y } },
    { id: "ne", point: { x: x + width, y } },
    { id: "sw", point: { x, y: y + height } },
    { id: "se", point: { x: x + width, y: y + height } },
  ];
}

/**
 * `point`(Canvasピクセル座標)が図形のどこに当たるかを返す。ハンドル(`tolerance`以内)を
 * 本体より優先する。本体は矩形=枠の内側、円=楕円の内側、矢印=胴体(始点→終点の線分)から
 * 胴の半幅+`tolerance`以内。`tolerance`は画面上の一定サイズになるよう呼び出し側が
 * 表示倍率で換算して渡す。
 */
export function hitTestShape(
  shape: EditableShape,
  point: Point,
  tolerance: number,
  canvasWidth: number,
  canvasHeight: number,
): ShapeHit {
  for (const handle of getShapeHandles(shape)) {
    if (Math.hypot(point.x - handle.point.x, point.y - handle.point.y) <= tolerance) {
      return { type: "handle", handle: handle.id };
    }
  }
  if (shape.kind === "arrow") {
    const halfWidth = arrowLineWidth(canvasWidth, canvasHeight) / 2;
    return distanceToSegment(point, shape.start, shape.end) <= halfWidth + tolerance
      ? { type: "body" }
      : null;
  }
  const { rect } = shape;
  if (shape.kind === "rectangle") {
    const inside =
      point.x >= rect.x - tolerance &&
      point.x <= rect.x + rect.width + tolerance &&
      point.y >= rect.y - tolerance &&
      point.y <= rect.y + rect.height + tolerance;
    return inside ? { type: "body" } : null;
  }
  const { center, radiusX, radiusY } = computeEllipseCenterAndRadii(rect);
  const nx = (point.x - center.x) / (radiusX + tolerance);
  const ny = (point.y - center.y) / (radiusY + tolerance);
  return nx * nx + ny * ny <= 1 ? { type: "body" } : null;
}

/**
 * ハンドルのドラッグでリサイズした図形を返す。矩形・円は対角のハンドルを固定して
 * 既存の`compute*Geometry()`(Shiftで正方形/正円)を再計算する。矢印は該当端点のみ動かす。
 * 結果が小さすぎる(誤クリック相当)場合は元の図形をそのまま返す(図形が消えないように)。
 */
export function resizeShape(
  shape: EditableShape,
  handle: HandleId,
  pointer: Point,
  canvasWidth: number,
  canvasHeight: number,
  shiftKey: boolean,
): EditableShape {
  const p = clampPoint(pointer, canvasWidth, canvasHeight);
  if (shape.kind === "arrow") {
    const next: ArrowShape =
      handle === "start" ? { ...shape, start: p } : handle === "end" ? { ...shape, end: p } : shape;
    return computeArrowGeometry(next.start, next.end, canvasWidth, canvasHeight) ? next : shape;
  }
  const anchor = oppositeCorner(shape.rect, handle);
  if (!anchor) {
    return shape;
  }
  const next = createShapeFromDrag(shape.kind, anchor, p, shape.color, canvasWidth, canvasHeight, shiftKey);
  return next ?? shape;
}

/**
 * 図形を`delta`だけ平行移動する。Canvas外へはみ出さないよう移動量をクランプする
 * (形・大きさは変えない。はみ出した分をクリップすると図形が縮んでしまうため)。
 */
export function moveShape(
  shape: EditableShape,
  delta: Point,
  canvasWidth: number,
  canvasHeight: number,
): EditableShape {
  const bounds =
    shape.kind === "arrow"
      ? {
          minX: Math.min(shape.start.x, shape.end.x),
          maxX: Math.max(shape.start.x, shape.end.x),
          minY: Math.min(shape.start.y, shape.end.y),
          maxY: Math.max(shape.start.y, shape.end.y),
        }
      : {
          minX: shape.rect.x,
          maxX: shape.rect.x + shape.rect.width,
          minY: shape.rect.y,
          maxY: shape.rect.y + shape.rect.height,
        };
  const dx = clamp(delta.x, -bounds.minX, canvasWidth - bounds.maxX);
  const dy = clamp(delta.y, -bounds.minY, canvasHeight - bounds.maxY);
  if (shape.kind === "arrow") {
    return {
      ...shape,
      start: { x: shape.start.x + dx, y: shape.start.y + dy },
      end: { x: shape.end.x + dx, y: shape.end.y + dy },
    };
  }
  return { ...shape, rect: { ...shape.rect, x: shape.rect.x + dx, y: shape.rect.y + dy } };
}

/** ドラッグ中の現在点から、そのセッションが作る図形を返す(作成時の誤クリックは`null`)。 */
export function applyEditDrag(
  session: EditSession,
  pointer: Point,
  shiftKey: boolean,
  canvasWidth: number,
  canvasHeight: number,
): EditableShape | null {
  switch (session.mode) {
    case "create":
      return createShapeFromDrag(
        session.kind,
        session.origin,
        pointer,
        session.color,
        canvasWidth,
        canvasHeight,
        shiftKey,
      );
    case "resize":
      return resizeShape(session.initial, session.handle, pointer, canvasWidth, canvasHeight, shiftKey);
    case "move":
      return moveShape(
        session.initial,
        { x: pointer.x - session.origin.x, y: pointer.y - session.origin.y },
        canvasWidth,
        canvasHeight,
      );
  }
}

export interface PointerDownInput {
  /** 重ね順のオブジェクト配列(末尾が最前面、T32)。 */
  objects: readonly AnnotationObject[];
  selectedId: number | null;
  activeTool: ToolId | null;
  point: Point;
  tolerance: number;
  canvasWidth: number;
  canvasHeight: number;
  /** 新規作成時に使う現在の注釈色(`toolSettings`)。 */
  color: string;
}

export type PointerDownDecision =
  /** オブジェクト`id`を選択してリサイズ/移動を始める。 */
  | { type: "edit"; id: number; session: EditSession }
  /** 選択を外して新しい図形の作成を始める。 */
  | { type: "create"; session: EditSession }
  | { type: "deselect" }
  | { type: "ignore" };

/**
 * Canvas上のpointerdownをどう扱うかを決める(T32【改訂 2026-09-24】)。
 * ①選択中のオブジェクトのハンドル・内側 → リサイズ/移動 ②未選択のオブジェクトを最前面から
 * 当たり判定(線の付近のみ)→ 選択して移動 ③外れたら、図形ツール選択中なら新規作成、
 * それ以外は選択解除。モザイク・テキストツール中はオブジェクトを掴まない(各ツールが処理する)。
 */
export function decidePointerDown(input: PointerDownInput): PointerDownDecision {
  const { objects, activeTool, point, tolerance, canvasWidth, canvasHeight } = input;
  const selected = findObject(objects, input.selectedId);
  const blank: PointerDownDecision = selected ? { type: "deselect" } : { type: "ignore" };
  if (activeTool !== null && !isShapeTool(activeTool)) {
    return blank;
  }
  if (selected) {
    const hit = hitTestShape(selected.shape, point, tolerance, canvasWidth, canvasHeight);
    if (hit?.type === "handle") {
      return { type: "edit", id: selected.id, session: { mode: "resize", handle: hit.handle, initial: selected.shape } };
    }
    if (hit?.type === "body") {
      return { type: "edit", id: selected.id, session: { mode: "move", origin: point, initial: selected.shape } };
    }
  }
  const picked = pickObjectAt(objects, point, tolerance, canvasWidth, canvasHeight);
  if (picked) {
    return { type: "edit", id: picked.id, session: { mode: "move", origin: point, initial: picked.shape } };
  }
  if (isShapeTool(activeTool)) {
    return { type: "create", session: { mode: "create", kind: activeTool, origin: point, color: input.color } };
  }
  return blank;
}

/**
 * 確定時にUndoステップへ積む外接矩形(線の太さ・影の余白込み、整数、Canvas内クリップ済み)。
 * 各ツールの既存`compute*BoundingRect()`をそのまま使う(確定前の旧実装と同じ範囲)。
 */
export function shapeUndoRect(shape: EditableShape, canvasWidth: number, canvasHeight: number): Rect {
  if (shape.kind === "arrow") {
    const polygon = computeTaperArrowPolygon(shape.start, shape.end, canvasWidth, canvasHeight);
    if (!polygon) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    return computeTaperArrowBoundingRect(polygon, canvasWidth, canvasHeight);
  }
  if (shape.kind === "rectangle") {
    return computeRectangleBoundingRect(
      { rect: shape.rect, lineWidth: rectangleLineWidth(canvasWidth, canvasHeight) },
      canvasWidth,
      canvasHeight,
    );
  }
  return computeEllipseBoundingRect(
    {
      rect: shape.rect,
      ...computeEllipseCenterAndRadii(shape.rect),
      lineWidth: ellipseLineWidth(canvasWidth, canvasHeight),
    },
    canvasWidth,
    canvasHeight,
  );
}

/** ホバー中の当たり判定に応じたCSSカーソル。当たっていなければ`null`(既定カーソル)。 */
export function cursorForHit(hit: ShapeHit): string | null {
  if (!hit) {
    return null;
  }
  if (hit.type === "body") {
    return "move";
  }
  switch (hit.handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    default:
      return "crosshair";
  }
}

function oppositeCorner(rect: Rect, handle: HandleId): Point | null {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  switch (handle) {
    case "nw":
      return { x: right, y: bottom };
    case "ne":
      return { x: left, y: bottom };
    case "sw":
      return { x: right, y: top };
    case "se":
      return { x: left, y: top };
    default:
      return null;
  }
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function clampPoint(p: Point, canvasWidth: number, canvasHeight: number): Point {
  return { x: clamp(p.x, 0, canvasWidth), y: clamp(p.y, 0, canvasHeight) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
