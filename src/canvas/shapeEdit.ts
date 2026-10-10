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
import { shapeStyleDiagonal } from "./styleBasis";
import {
  arrowLineWidthForDiagonal,
  computeArrowGeometry,
  computeTaperArrowBoundingRect,
  computeTaperArrowPolygon,
} from "./tools/arrowTool";
import {
  computeEllipseBoundingRect,
  computeEllipseGeometry,
  computeEllipseCenterAndRadii,
  ellipseLineWidthForDiagonal,
} from "./tools/ellipseTool";
import {
  computeRectangleBoundingRect,
  computeRectangleGeometry,
  rectangleLineWidthForDiagonal,
} from "./tools/rectangleTool";
import { stampShapeDiameter, type StampShape } from "./tools/stampShape";
import { textShapeBoundingRect, textShapeBox } from "./tools/textLayout";
import type { FontSize } from "./toolSettings";

export type { StampShape } from "./tools/stampShape";

/**
 * ドラッグで作る図形の種類(モザイクは即焼き込みのため対象外)。QE-T15でスポットライトの穴を加えた
 * (矩形と同じ作り方)。
 */
export type ShapeKind = "arrow" | "rectangle" | "ellipse" | "spotlight";

export interface ArrowShape {
  kind: "arrow";
  start: Point;
  end: Point;
  color: string;
  /** 大きさの基準の対角線(px)。トリミングの確定で残ったときだけ付く(`styleBasis.ts`、QE-T17)。 */
  styleBasis?: number;
}

/** 矩形・円(外接矩形で表す)。`rect`は正規化・Canvas範囲内クリップ済み。 */
export interface BoxShape {
  kind: "rectangle" | "ellipse";
  rect: Rect;
  color: string;
  /** 大きさの基準の対角線(px)。トリミングの確定で残ったときだけ付く(`styleBasis.ts`、QE-T17)。 */
  styleBasis?: number;
}

/**
 * テキスト(T33【新設 2026-09-24】)。位置は行ボックスの左端(描画原点)・上端。フォント実寸は
 * `fontSize`と画像サイズから決まる(`textLayout.ts::textShapeFontPx()`)。`metrics`は作成・再編集時に
 * `ctx.measureText()`で測った値で、当たり判定・外接矩形を DOM 無しで計算するために持つ
 * (文字サイズを変える T34 では測り直す)。ハンドルは持たない(移動のみ)。
 */
export interface TextShape {
  kind: "text";
  text: string;
  x: number;
  top: number;
  fontSize: FontSize;
  color: string;
  metrics: TextMetricsSnapshot;
  /** 大きさの基準の対角線(px)。トリミングの確定で残ったときだけ付く(`styleBasis.ts`、QE-T17)。 */
  styleBasis?: number;
}

/** `ctx.measureText()`の必要な値(Canvasピクセル)。 */
export interface TextMetricsSnapshot {
  /** 送り幅(`width`)。 */
  width: number;
  /** `actualBoundingBoxLeft`/`Right`/`Ascent`/`Descent`(実際の字形の範囲)。 */
  left: number;
  right: number;
  ascent: number;
  descent: number;
  /** `fontBoundingBoxAscent`/`Descent`(行ボックス内のベースライン位置の算出用)。 */
  fontAscent: number;
  fontDescent: number;
}

/**
 * スポットライトの穴(QE-T15、ARCH_quick-edits §5.3)。矩形だけで、色・文字サイズを持たない。
 * 合成では何も描かず、穴の和の外側を暗くする(`documentSurface.ts::composeDocument()`)。
 * 50個の上限で焼き込まない(`objectModel.ts::pickBurnTarget()`)。`rect`は正規化・Canvas範囲内クリップ済み。
 */
export interface SpotlightShape {
  kind: "spotlight";
  rect: Rect;
  /** 大きさの基準の対角線(px)。トリミングの確定で残ったときだけ付く(`styleBasis.ts`、QE-T17)。 */
  styleBasis?: number;
}

/** 注釈オブジェクトの形。QE-T11でスタンプ(`tools/stampShape.ts`)、QE-T15で穴を加えた。 */
export type EditableShape = ArrowShape | BoxShape | TextShape | StampShape | SpotlightShape;

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
  return tool === "arrow" || tool === "rectangle" || tool === "ellipse" || tool === "spotlight";
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
  if (kind === "spotlight") {
    // 穴は矩形と同じ作り方(最小ドラッグ・Shiftで正方形・Canvas内クリップ)。色は持たない(QE-T15)。
    const geometry = computeRectangleGeometry(start, end, canvasWidth, canvasHeight, shiftKey);
    return geometry ? { kind, rect: geometry.rect } : null;
  }
  const geometry =
    kind === "rectangle"
      ? computeRectangleGeometry(start, end, canvasWidth, canvasHeight, shiftKey)
      : computeEllipseGeometry(start, end, canvasWidth, canvasHeight, shiftKey);
  return geometry ? { kind, rect: geometry.rect, color } : null;
}

export function getShapeHandles(shape: EditableShape): ShapeHandle[] {
  // テキスト・スタンプはハンドルを持たない(移動のみ。スタンプの大きさは文字サイズで変える、QE-T11)。
  if (shape.kind === "text" || shape.kind === "stamp") {
    return [];
  }
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
  if (shape.kind === "text") {
    const box = textShapeBox(shape, canvasWidth, canvasHeight);
    const inside =
      point.x >= box.x - tolerance &&
      point.x <= box.x + box.width + tolerance &&
      point.y >= box.y - tolerance &&
      point.y <= box.y + box.height + tolerance;
    return inside ? { type: "body" } : null;
  }
  if (shape.kind === "stamp") {
    // 円の内側(QE-T11)。選択中は他の形と同じく`tolerance`の分だけ広げて掴みやすくする。
    const radius = stampShapeDiameter(shape, canvasWidth, canvasHeight) / 2;
    return Math.hypot(point.x - shape.center.x, point.y - shape.center.y) <= radius + tolerance
      ? { type: "body" }
      : null;
  }
  if (shape.kind === "arrow") {
    const halfWidth = arrowLineWidthForDiagonal(shapeStyleDiagonal(shape, canvasWidth, canvasHeight)) / 2;
    return distanceToSegment(point, shape.start, shape.end) <= halfWidth + tolerance
      ? { type: "body" }
      : null;
  }
  const { rect } = shape;
  // 選択中の穴は矩形と同じく、枠の内側で移動できる(未選択時の掴める所は`objectModel.ts`)。
  if (shape.kind === "rectangle" || shape.kind === "spotlight") {
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
  if (shape.kind === "text" || shape.kind === "stamp") {
    return shape;
  }
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
  const color = shape.kind === "spotlight" ? "" : shape.color;
  const next = createShapeFromDrag(shape.kind, anchor, p, color, canvasWidth, canvasHeight, shiftKey);
  if (!next) {
    return shape;
  }
  // 大きさの基準はリサイズでも保つ(作り直した形には付かないため引き継ぐ、QE-T17)。
  return shape.styleBasis === undefined ? next : { ...next, styleBasis: shape.styleBasis };
}

/**
 * 図形を`delta`だけ平行移動する。Canvas外へはみ出さないよう移動量をクランプする
 * (形・大きさは変えない。はみ出した分をクリップすると図形が縮んでしまうため)。
 *
 * 移動の範囲は`[min(0, -左端), max(0, 幅 - 右端)]`(縦も同じ、QE-T19、ARCH_quick-edits §5.3)。
 * 画像の内側の注釈は今と同じ範囲になり、トリミングで一部がはみ出した注釈は「はみ出しを増やさない
 * 方向」には動かせる(範囲が逆転して勝手に跳ばない)。
 *
 * スタンプも円の外接矩形(中心 ± 半径)で同じ範囲を当てる(QE-T21)。画像の内側のスタンプは従来の
 * 「中心を半径の分だけ内側に収める」と同じ範囲になる。置く位置を内側へ収めるのは
 * `tools/shapeTools.ts::placedStamp()`の専用の収め方で、本関数は使わない。
 */
export function moveShape(
  shape: EditableShape,
  delta: Point,
  canvasWidth: number,
  canvasHeight: number,
): EditableShape {
  if (shape.kind === "text") {
    const box = textShapeBox(shape, canvasWidth, canvasHeight);
    const dx = clampMove(delta.x, box.x, box.x + box.width, canvasWidth);
    const dy = clampMove(delta.y, box.y, box.y + box.height, canvasHeight);
    return { ...shape, x: shape.x + dx, top: shape.top + dy };
  }
  if (shape.kind === "stamp") {
    // 円の外接矩形で測る(画像の内側なら円が画像の外へはみ出さない、QE-T11・QE-T21)。
    const radius = stampShapeDiameter(shape, canvasWidth, canvasHeight) / 2;
    const { center } = shape;
    const dx = clampMove(delta.x, center.x - radius, center.x + radius, canvasWidth);
    const dy = clampMove(delta.y, center.y - radius, center.y + radius, canvasHeight);
    return { ...shape, center: { x: center.x + dx, y: center.y + dy } };
  }
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
  const dx = clampMove(delta.x, bounds.minX, bounds.maxX, canvasWidth);
  const dy = clampMove(delta.y, bounds.minY, bounds.maxY, canvasHeight);
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
  /** スタンプツールで空白を押した: その位置にスタンプを置く(下書き・確定はUI側、QE-T12)。 */
  | { type: "place"; point: Point }
  | { type: "deselect" }
  | { type: "ignore" };

/**
 * Canvas上のpointerdownをどう扱うかを決める(T32【改訂 2026-09-24】)。
 * ①選択中のオブジェクトのハンドル・内側 → リサイズ/移動 ②未選択のオブジェクトを最前面から
 * 当たり判定(線の付近のみ)→ 選択して移動 ③外れたら、図形ツール選択中なら新規作成、
 * それ以外は選択解除。モザイクツール中はオブジェクトを掴まない(ツールが処理する)。
 * ツールごとに掴める注釈は`grabbableObjects()`(ARCH_quick-edits §5.3 の表)。スタンプツールで
 * 空白を押したら`place`(QE-T11)。
 */
export function decidePointerDown(input: PointerDownInput): PointerDownDecision {
  const { objects, activeTool, point, tolerance, canvasWidth, canvasHeight } = input;
  const selected = findObject(objects, input.selectedId);
  const blank: PointerDownDecision =
    activeTool === "stamp" ? { type: "place", point } : selected ? { type: "deselect" } : { type: "ignore" };
  // モザイク・トリミング(QE-T21)は注釈を掴まない(範囲の操作は各ツールが処理する)。
  if (activeTool === "mosaic" || activeTool === "crop") {
    return blank;
  }
  const grabbable = grabbableObjects(objects, activeTool);
  const selectedGrabbable = selected && grabbable.includes(selected) ? selected : undefined;
  if (selectedGrabbable) {
    const hit = hitTestShape(selectedGrabbable.shape, point, tolerance, canvasWidth, canvasHeight);
    if (hit?.type === "handle") {
      return {
        type: "edit",
        id: selectedGrabbable.id,
        session: { mode: "resize", handle: hit.handle, initial: selectedGrabbable.shape },
      };
    }
    if (hit?.type === "body") {
      return {
        type: "edit",
        id: selectedGrabbable.id,
        session: { mode: "move", origin: point, initial: selectedGrabbable.shape },
      };
    }
  }
  const picked = pickObjectAt(grabbable, point, tolerance, canvasWidth, canvasHeight);
  if (picked) {
    return { type: "edit", id: picked.id, session: { mode: "move", origin: point, initial: picked.shape } };
  }
  if (isShapeTool(activeTool)) {
    return { type: "create", session: { mode: "create", kind: activeTool, origin: point, color: input.color } };
  }
  return blank;
}

/**
 * 選択中のツールで掴める注釈(ARCH_quick-edits §5.3)。テキストツールはテキストだけ(T33: 図形の上にも
 * 文字を置けるように)、スタンプツールはスタンプだけ(QE-T11: テキストの上にも置けるように)、
 * スポットライトツールは穴だけ(QE-T15)。矢印・矩形・円は穴以外のすべて(穴の枠の上にも図形を
 * 描けるように)、ツール無しはすべて(穴は未選択なら枠の付近だけ、`objectModel.ts`)。
 */
function grabbableObjects(
  objects: readonly AnnotationObject[],
  activeTool: ToolId | null,
): readonly AnnotationObject[] {
  if (activeTool === "text" || activeTool === "stamp" || activeTool === "spotlight") {
    return objects.filter((o) => o.shape.kind === activeTool);
  }
  if (activeTool === "arrow" || activeTool === "rectangle" || activeTool === "ellipse") {
    return objects.filter((o) => o.shape.kind !== "spotlight");
  }
  return objects;
}

/**
 * 確定時にUndoステップへ積む外接矩形(線の太さ・影の余白込み、整数、Canvas内クリップ済み)。
 * 各ツールの既存`compute*BoundingRect()`をそのまま使う(確定前の旧実装と同じ範囲)。線の太さ・影は
 * 描画と同じく`shapeStyleDiagonal()`の対角線で見積もる(QE-T17、ADR-002)。
 */
export function shapeUndoRect(shape: EditableShape, canvasWidth: number, canvasHeight: number): Rect {
  if (shape.kind === "text") {
    return textShapeBoundingRect(shape, canvasWidth, canvasHeight);
  }
  if (shape.kind === "stamp") {
    return stampBoundingRect(shape, canvasWidth, canvasHeight);
  }
  if (shape.kind === "spotlight") {
    // 穴は何も描かない(焼き込みもしない)。範囲は穴の矩形を外側へ整数化したもの。
    return outwardIntegerRect(shape.rect, canvasWidth, canvasHeight);
  }
  if (shape.kind === "arrow") {
    const polygon = computeTaperArrowPolygon(
      shape.start,
      shape.end,
      canvasWidth,
      canvasHeight,
      shapeStyleDiagonal(shape, canvasWidth, canvasHeight),
    );
    if (!polygon) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    return computeTaperArrowBoundingRect(polygon, canvasWidth, canvasHeight);
  }
  if (shape.kind === "rectangle") {
    return computeRectangleBoundingRect(
      {
        rect: shape.rect,
        lineWidth: rectangleLineWidthForDiagonal(shapeStyleDiagonal(shape, canvasWidth, canvasHeight)),
      },
      canvasWidth,
      canvasHeight,
    );
  }
  return computeEllipseBoundingRect(
    {
      rect: shape.rect,
      ...computeEllipseCenterAndRadii(shape.rect),
      lineWidth: ellipseLineWidthForDiagonal(shapeStyleDiagonal(shape, canvasWidth, canvasHeight)),
    },
    canvasWidth,
    canvasHeight,
  );
}

/**
 * スタンプの影の比率(`tools/stampShape.ts::drawStamp()`の影と同じ値: ぼかし D × 0.08、下へ D × 0.04)。
 * 外接矩形の余白はテキストと同じ考え方で「ぼかし × 2 + 下へのずれ + アンチエイリアスの余白」。
 * 【設計判断】`stampShape.ts`は QE-T10 で確定済みのため値をここに持つ(描画側を変えたら合わせる)。
 */
const STAMP_SHADOW_BLUR_RATIO = 0.08;
const STAMP_SHADOW_OFFSET_Y_RATIO = 0.04;
const STAMP_ANTIALIAS_MARGIN = 2;

/** スタンプの影込みの外接矩形(整数、Canvas内クリップ済み。上限の焼き込みの退避範囲)。 */
function stampBoundingRect(shape: StampShape, canvasWidth: number, canvasHeight: number): Rect {
  const diameter = stampShapeDiameter(shape, canvasWidth, canvasHeight);
  const reach =
    diameter / 2 +
    diameter * STAMP_SHADOW_BLUR_RATIO * 2 +
    diameter * STAMP_SHADOW_OFFSET_Y_RATIO +
    STAMP_ANTIALIAS_MARGIN;
  const left = Math.max(0, Math.floor(shape.center.x - reach));
  const top = Math.max(0, Math.floor(shape.center.y - reach));
  const right = Math.min(canvasWidth, Math.ceil(shape.center.x + reach));
  const bottom = Math.min(canvasHeight, Math.ceil(shape.center.y + reach));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** 矩形を外側へ整数化し、Canvas内に切り詰める。 */
function outwardIntegerRect(rect: Rect, canvasWidth: number, canvasHeight: number): Rect {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(canvasWidth, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(canvasHeight, Math.ceil(rect.y + rect.height));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
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

/**
 * 1 軸の移動量を`[min(0, -start), max(0, size - end)]`に収める(範囲は常に 0 を含み、逆転しない)。
 * `start`・`end`は形の左端・右端(上端・下端)、`size`は画像の幅(高さ)。
 */
function clampMove(delta: number, start: number, end: number, size: number): number {
  return clamp(delta, Math.min(0, -start), Math.max(0, size - end));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
