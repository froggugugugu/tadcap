//! 円(楕円)枠ツール(ARCH §4 `src/canvas/tools/ellipseTool.ts`、PRD FR-011、T26【新設
//! 2026-09-24】)。
//!
//! ドラッグした範囲を外接矩形とする楕円(正円に限定しない)の枠線(塗りなし)を焼き込む。
//! 座標の正規化・クリップは`coords.ts::normalizeRect()`/`clipRectToCanvas()`(T20で矢印・
//! 矩形・円ツール共通化済み)を再利用する。座標計算(`ellipseLineWidth()`/
//! `constrainToSquare()`/`computeEllipseCenterAndRadii()`/`computeEllipseGeometry()`/
//! `computeEllipseBoundingRect()`)はDOM非依存の純粋関数としてユニットテストする。
//! ドラッグ操作の検知・Canvasへの実描画(T31以降は`shapeTools.ts::bindShapeTools()`)はDOM/Canvas APIに直接依存する
//! ため、Vitestの既定環境(Node、DOM無し)では自動テスト対象外とし、手動確認チェックリストへ
//! 回す(project-config.md §11。`rectangleTool.ts`/`arrowTool.ts`/`mosaicTool.ts`と同じ方針)。
//!
//! 太さの算出は矩形枠(`rectangleTool.ts::rectangleLineWidth()`)と同じ考え方・同じ式
//! (Canvas対角線基準の決定論的クランプ)だが、比率・上下限は本ファイルにローカルな定数として
//! 独立して持つ(ARCH §5.2「太さの比率は視覚調整のためツールごとに異なってよく、共通モジュール
//! へ強制的に集約しない」。T25と同じ理由で、値の同期・依存は行わない)。
//!
//! `constrainToSquare()`も同じ理由で`rectangleTool.ts`から再exportせず本ファイルに複製する
//! (T20/T25の「Rule of Three(3箇所以上の重複で共通化を検討)」方針に基づき、2ファイル目の
//! 時点ではまだ共通モジュールへ強制的に集約しない)。
//!
//! 色は`toolSettings.getToolSettings().color`(FR-013、モザイクを除く全注釈ツール共通)。
//!
//! 【仮定 2026-09-24】Shiftキー押下時に外接矩形を正方形へ拘束し正円にする挙動は、ARC/PRDに
//! 明記が無いため`rectangleTool.ts`の`constrainToSquare()`と同じ考え方(一般的な図形描画UIの
//! 慣習)で実装した。

import {
  clipRectToCanvas,
  normalizeRect,
  roundRect,
  type Point,
  type Rect,
} from "../coords";

export type { Point, Rect };

/** これ未満の幅・高さ(Canvasピクセル、正規化・クリップ後)は誤クリックとみなし確定しない
 * (`rectangleTool.ts::MIN_DRAG_DISTANCE`と同じ考え方)。 */
const MIN_DRAG_DISTANCE = 2;

const MIN_LINE_WIDTH = 2;
const MAX_LINE_WIDTH = 14;
/**
 * Canvas対角線(px、ピクセルバッファサイズ=画像の実ピクセル)に対する枠線幅の比率
 * (`rectangleTool.ts::LINE_WIDTH_RATIO`と同じ値を採用。矩形の枠線と円の枠線はどちらも
 * 「注釈の線の太さ」という同じ視覚的役割のため、まずは同じ基準に揃えた。矩形側の定数は
 * 独立したローカル定数として持ち、値の同期・依存は行わない)。
 */
const LINE_WIDTH_RATIO = 0.0035;

export interface EllipseGeometry {
  /** 正規化・Canvas範囲内クリップ済みの外接矩形。 */
  rect: Rect;
  /** 楕円の中心点(Canvasピクセル座標)。 */
  center: Point;
  /** X軸方向の半径(px)。 */
  radiusX: number;
  /** Y軸方向の半径(px)。 */
  radiusY: number;
  /** 枠線の太さ(px)。 */
  lineWidth: number;
}

/**
 * Canvasの対角線(ピクセルバッファサイズ、画像の実ピクセル)から枠線の太さを決定論的に
 * 算出する純粋関数(`rectangleTool.ts::rectangleLineWidth()`と同じ考え方・同じ式)。外接矩形の
 * サイズには依存しない([MIN_LINE_WIDTH, MAX_LINE_WIDTH]にクランプ)。
 */
export function ellipseLineWidth(canvasWidth: number, canvasHeight: number): number {
  const diagonal = Math.hypot(canvasWidth, canvasHeight);
  const raw = Math.round(diagonal * LINE_WIDTH_RATIO);
  return clamp(raw, MIN_LINE_WIDTH, MAX_LINE_WIDTH);
}

/**
 * Shiftキー押下時、始点を中心に外接矩形が正方形(=正円)になるよう終点を補正する純粋関数
 * (T26【新設 2026-09-24】、`rectangleTool.ts::constrainToSquare()`と同じ考え方・同じ実装、
 * 上記モジュールdoc【仮定】参照)。長辺(dx/dyのうち絶対値が大きい方)を基準に、両軸それぞれの
 * 符号を保ったまま短辺を伸ばして正方形にする。`shiftKey`が`false`の場合は`end`をそのまま返す。
 */
export function constrainToSquare(start: Point, end: Point, shiftKey: boolean): Point {
  if (!shiftKey) {
    return end;
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  const signX = dx < 0 ? -1 : 1;
  const signY = dy < 0 ? -1 : 1;
  return { x: start.x + signX * side, y: start.y + signY * side };
}

/**
 * 外接矩形(Canvasピクセル座標)から楕円の中心点・X半径・Y半径を算出する純粋関数
 * (T26受け入れ条件「外接矩形→中心・X半径・Y半径を算出する純粋関数のテスト」)。
 */
export function computeEllipseCenterAndRadii(
  rect: Rect,
): { center: Point; radiusX: number; radiusY: number } {
  return {
    center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    radiusX: rect.width / 2,
    radiusY: rect.height / 2,
  };
}

/**
 * 始点・終点(いずれもCanvasピクセル座標)から円ツールの描画パラメータを算出する純粋関数。
 * `shiftKey`が`true`の場合は`constrainToSquare()`で外接矩形を正方形に補正してから正規化・
 * クリップする。正規化・クリップ後の幅・高さが`MIN_DRAG_DISTANCE`未満(誤クリック等)の場合は
 * `null`を返す(`rectangleTool.ts::computeRectangleGeometry()`と同じガード条件)。
 */
export function computeEllipseGeometry(
  start: Point,
  end: Point,
  canvasWidth: number,
  canvasHeight: number,
  shiftKey = false,
): EllipseGeometry | null {
  const adjustedEnd = constrainToSquare(start, end, shiftKey);
  const clipped = clipRectToCanvas(
    normalizeRect(start, adjustedEnd),
    canvasWidth,
    canvasHeight,
  );
  if (clipped.width < MIN_DRAG_DISTANCE || clipped.height < MIN_DRAG_DISTANCE) {
    return null;
  }
  const { center, radiusX, radiusY } = computeEllipseCenterAndRadii(clipped);
  return {
    rect: clipped,
    center,
    radiusX,
    radiusY,
    lineWidth: ellipseLineWidth(canvasWidth, canvasHeight),
  };
}

/**
 * 円の枠の外接矩形を、線の太さ分の余白付き・Canvas範囲内クリップ済み・整数座標で算出する
 * 純粋関数(`rectangleTool.ts::computeRectangleBoundingRect()`と同じ考え方、タスク指示
 * 「取り消しのbeforeはドラッグ開始時の全体スナップショットから外接矩形分を切り出す(線の
 * 太さ分の余白を含める)」)。`ctx.stroke()`は楕円の輪郭を中心にして内外へ`lineWidth/2`ずつ
 * 描画するため、余白を`lineWidth`分(片側`lineWidth/2`以上)確保してアンチエイリアシング分も
 * 含めて安全に復元できるようにする。
 */
export function computeEllipseBoundingRect(
  geometry: EllipseGeometry,
  canvasWidth: number,
  canvasHeight: number,
): Rect {
  const margin = geometry.lineWidth;
  const expanded: Rect = {
    x: geometry.rect.x - margin,
    y: geometry.rect.y - margin,
    width: geometry.rect.width + margin * 2,
    height: geometry.rect.height + margin * 2,
  };
  const clipped = clipRectToCanvas(expanded, canvasWidth, canvasHeight);
  return roundRect(clipped);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Canvas 2D contextへ楕円の枠線(塗りつぶしなし)を焼き込む(DOM/Canvas依存、自動テスト
 * 対象外)。
 */
export function drawEllipseOutline(
  ctx: CanvasRenderingContext2D,
  geometry: EllipseGeometry,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = geometry.lineWidth;
  ctx.beginPath();
  ctx.ellipse(
    geometry.center.x,
    geometry.center.y,
    geometry.radiusX,
    geometry.radiusY,
    0,
    0,
    Math.PI * 2,
  );
  ctx.stroke();
  ctx.restore();
}

// T31【改訂 2026-09-24】: ポインタ結線(旧`bind*Tool()`)は、編集中の図形(リサイズ・移動)に
// 対応するため矢印・矩形・円の3ツール共通の`tools/shapeTools.ts::bindShapeTools()`へ移した。
// 本ファイルはツール固有の純粋関数(形状パラメータ・外接矩形)と描画関数のみを持つ。
