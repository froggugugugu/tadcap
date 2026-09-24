//! 矩形枠ツール(ARCH §4 `src/canvas/tools/rectangleTool.ts`、PRD FR-007、T25【新設
//! 2026-09-24】)。
//!
//! ドラッグした範囲へ塗りつぶしなしの矩形枠線を焼き込む。座標の正規化・クリップは
//! `coords.ts::normalizeRect()`/`clipRectToCanvas()`(T20で矢印・矩形・円ツール共通化済み)を
//! 再利用する。座標計算(`rectangleLineWidth()`/`constrainToSquare()`/
//! `computeRectangleGeometry()`/`computeRectangleBoundingRect()`)はDOM非依存の純粋関数として
//! ユニットテストする。ドラッグ操作の検知・Canvasへの実描画(T31以降は`shapeTools.ts::bindShapeTools()`)は
//! DOM/Canvas APIに直接依存するため、Vitestの既定環境(Node、DOM無し)では自動テスト対象外と
//! し、手動確認チェックリストへ回す(project-config.md §11。`arrowTool.ts`/`mosaicTool.ts`と
//! 同じ方針)。
//!
//! 太さの算出はCanvas対角線基準の決定論的クランプ(`arrowTool.ts::arrowLineWidth()`と同じ
//! 考え方)だが、比率・上下限は本ファイルにローカルな定数として持つ(ARCH §5.2「太さの比率は
//! 視覚調整のためツールごとに異なってよく、共通モジュールへ強制的に集約しない」。矢印の
//! 定数値自体は並行で人間と調整中のため参照・変更しない)。
//!
//! 色は`toolSettings.getToolSettings().color`(FR-013、モザイクを除く全注釈ツール共通)。
//!
//! 【仮定 2026-09-24】Shiftキー押下時に正方形へ拘束する挙動は、ARCH/PRDに明記が無いため
//! 一般的な図形描画UI(macOS標準ツール等)の慣習に倣い実装した(`constrainToSquare()`)。

import {
  clipRectToCanvas,
  normalizeRect,
  roundRect,
  type Point,
  type Rect,
} from "../coords";

export type { Point, Rect };

/** これ未満の幅・高さ(Canvasピクセル、正規化・クリップ後)は誤クリックとみなし確定しない
 * (`mosaicTool.ts::computeMosaicRect()`と同じ考え方)。 */
const MIN_DRAG_DISTANCE = 2;

const MIN_LINE_WIDTH = 2;
const MAX_LINE_WIDTH = 14;
/**
 * Canvas対角線(px、ピクセルバッファサイズ=画像の実ピクセル)に対する枠線幅の比率
 * (`arrowTool.ts::LINE_WIDTH_RATIO`と同じ考え方・同じ値を採用。矩形の枠線と矢印の胴は
 * どちらも「注釈の線の太さ」という同じ視覚的役割のため、まずは同じ基準に揃えた。
 * 矢印側の定数(`arrowLineWidth()`)は並行で人間と調整中のため、本ファイルは独立した
 * ローカル定数として持ち、値の同期・依存は行わない)。
 */
const LINE_WIDTH_RATIO = 0.0035;

export interface RectangleGeometry {
  /** 正規化・Canvas範囲内クリップ済みの選択矩形(枠線の外形)。 */
  rect: Rect;
  /** 枠線の太さ(px)。 */
  lineWidth: number;
}

/**
 * Canvasの対角線(ピクセルバッファサイズ、画像の実ピクセル)から枠線の太さを決定論的に
 * 算出する純粋関数(`arrowTool.ts::arrowLineWidth()`と同じ考え方)。選択矩形のサイズには
 * 依存しない([MIN_LINE_WIDTH, MAX_LINE_WIDTH]にクランプ)。
 */
export function rectangleLineWidth(canvasWidth: number, canvasHeight: number): number {
  const diagonal = Math.hypot(canvasWidth, canvasHeight);
  const raw = Math.round(diagonal * LINE_WIDTH_RATIO);
  return clamp(raw, MIN_LINE_WIDTH, MAX_LINE_WIDTH);
}

/**
 * Shiftキー押下時、始点を中心に正方形になるよう終点を補正する純粋関数(T25【新設
 * 2026-09-24】、【仮定】上記モジュールdoc参照)。長辺(dx/dyのうち絶対値が大きい方)を基準に、
 * 両軸それぞれの符号を保ったまま短辺を伸ばして正方形にする。`shiftKey`が`false`の場合は
 * `end`をそのまま返す。
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
 * 始点・終点(いずれもCanvasピクセル座標)から矩形ツールの描画パラメータを算出する純粋関数。
 * `shiftKey`が`true`の場合は`constrainToSquare()`で正方形に補正してから正規化・クリップする。
 * 正規化・クリップ後の幅・高さが`MIN_DRAG_DISTANCE`未満(誤クリック等)の場合は`null`を返す
 * (`mosaicTool.ts::computeMosaicRect()`と同じガード条件)。
 */
export function computeRectangleGeometry(
  start: Point,
  end: Point,
  canvasWidth: number,
  canvasHeight: number,
  shiftKey = false,
): RectangleGeometry | null {
  const adjustedEnd = constrainToSquare(start, end, shiftKey);
  const clipped = clipRectToCanvas(
    normalizeRect(start, adjustedEnd),
    canvasWidth,
    canvasHeight,
  );
  if (clipped.width < MIN_DRAG_DISTANCE || clipped.height < MIN_DRAG_DISTANCE) {
    return null;
  }
  return { rect: clipped, lineWidth: rectangleLineWidth(canvasWidth, canvasHeight) };
}

/**
 * 矩形枠の外接矩形を、線の太さ分の余白付き・Canvas範囲内クリップ済み・整数座標で算出する
 * 純粋関数(`arrowTool.ts::computeTaperArrowBoundingRect()`と同じ考え方、タスク指示
 * 「取り消しのbeforeはドラッグ開始時の全体スナップショットから外接矩形分を切り出す(線の
 * 太さ分の余白を含める)」)。`ctx.strokeRect()`は矩形の輪郭を中心にして内外へ`lineWidth/2`
 * ずつ描画するため、余白を`lineWidth`分(片側`lineWidth/2`以上)確保してアンチエイリアシング分
 * も含めて安全に復元できるようにする。
 */
export function computeRectangleBoundingRect(
  geometry: RectangleGeometry,
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
 * Canvas 2D contextへ矩形の枠線(塗りつぶしなし)を焼き込む(DOM/Canvas依存、自動テスト
 * 対象外)。
 */
export function drawRectangleOutline(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  lineWidth: number,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

// T31【改訂 2026-09-24】: ポインタ結線(旧`bind*Tool()`)は、編集中の図形(リサイズ・移動)に
// 対応するため矢印・矩形・円の3ツール共通の`tools/shapeTools.ts::bindShapeTools()`へ移した。
// 本ファイルはツール固有の純粋関数(形状パラメータ・外接矩形)と描画関数のみを持つ。
