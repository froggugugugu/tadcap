//! モザイクツール(ARCH §4 `src/canvas/tools/mosaicTool.ts`、PRD FR-008、T10)。
//!
//! 矩形の正規化・クリップ・ブロックサイズ算出・ピクセル化アルゴリズムはDOM非依存の
//! 純粋関数としてユニットテストする。ドラッグ操作の検知・Canvasへの実焼き込み
//! (`bindMosaicTool()`)はDOM/Canvas APIに直接依存するため、Vitestの既定環境(Node、
//! DOM無し)では自動テスト対象外とし、手動確認チェックリストへ回す(project-config.md
//! §11。`arrowTool.ts`と同じ方針)。
//!
//! ぼかし(blur)は実装しない。加工方式はブロック平均によるピクセル化のみ(PRD FR-008
//! 決定ログ)。CSSフィルタ等の見た目のみの変更ではなく、必ずCanvasピクセルへ焼き込む
//! (FR-008受け入れ基準)。
//!
//! T20【改訂 2026-09-24】: `Rect`/`normalizeRect()`/`clipRectToCanvas()` は
//! `../coords.ts` へ移設した(矩形・円ツールとの共通化、ARCH §5.2)。本ファイルは
//! `coords.ts` から再import して使う(挙動不変)。
//!
//! T24【新設 2026-09-24】: 確定焼き込み(`applyMosaic()`)の直前に`undoStack.pushUndoStep()`を
//! 呼ぶ配線を追加した(`arrowTool.ts`と同じ作法、PJM指示)。既存のピクセル化ロジック
//! (`pixelateImageData()`/`applyMosaic()`)自体は挙動不変。
//!
//! T25【改訂 2026-09-24】: `roundRect()`/`cropSnapshotRect()`も`../coords.ts`へ移設した
//! (矩形ツールが3ファイル目の利用者になったためRule of Threeで集約、挙動不変。詳細は
//! `coords.ts`モジュールdoc参照)。

import {
  clientToCanvasPoint,
  clipRectToCanvas,
  cropSnapshotRect,
  normalizeRect,
  roundRect,
  type Point,
  type Rect,
} from "../coords";
import {
  getCanvasState,
  isSameCanvasImage,
  setDrawing,
  type CanvasImage,
} from "../canvasState";
import { commitPendingShape } from "../pendingShape";
import { pushUndoStep } from "../undoStack";

export type { Point, Rect };

/** これ未満のドラッグ距離(Canvasピクセル、正規化後の幅・高さ)は誤クリックとみなし確定しない。 */
const MIN_DRAG_DISTANCE = 2;

/**
 * Canvas対角線(px、ピクセルバッファサイズ=画像の実ピクセル)に対するブロックサイズの比率
 * (`arrowTool.ts::LINE_WIDTH_RATIO` と同じ考え方。矢印と同様、`window.devicePixelRatio` では
 * なくCanvasピクセルバッファサイズを基準にする)。
 */
const BLOCK_SIZE_RATIO = 0.008;
/**
 * ブロックサイズの下限(px)。選択矩形がどれだけ小さくても、モザイクは機微情報を隠す目的
 * (FR-008)のため、判読できない程度の粗さを常に保証する。矩形サイズではなくCanvas解像度
 * からブロックサイズを決めているため、この下限が無いと極小画像・極小矩形でブロックサイズが
 * 1pxに近づき「ほぼ元画像のまま」になりうる。
 */
const MIN_BLOCK_SIZE = 12;
/** ブロックサイズの上限(px)。非常に大きい画像で1ブロックが粗すぎて使い物にならないのを防ぐ。 */
const MAX_BLOCK_SIZE = 64;

/**
 * 始点・終点から、正規化・クリップ済みの選択矩形を算出する純粋関数
 * (`arrowTool.ts::computeArrowGeometry()` と同じ構成)。クリップ後の幅・高さが
 * `MIN_DRAG_DISTANCE` 未満(誤クリック等)の場合は `null` を返す。
 */
export function computeMosaicRect(
  start: Point,
  end: Point,
  canvasWidth: number,
  canvasHeight: number,
): Rect | null {
  const clipped = clipRectToCanvas(
    normalizeRect(start, end),
    canvasWidth,
    canvasHeight,
  );
  if (clipped.width < MIN_DRAG_DISTANCE || clipped.height < MIN_DRAG_DISTANCE) {
    return null;
  }
  return clipped;
}

/**
 * Canvasの対角線(ピクセルバッファサイズ、画像の実ピクセル)からモザイクのブロックサイズを
 * 決定論的に算出する純粋関数(`arrowTool.ts::arrowLineWidth()` と同じ考え方)。選択矩形の
 * サイズには依存しない(矩形が小さいからといってブロックを細かくすると判読可能になり得る
 * ため、FR-008の「機微情報を隠す」目的に反する)。
 */
export function mosaicBlockSize(canvasWidth: number, canvasHeight: number): number {
  const diagonal = Math.hypot(canvasWidth, canvasHeight);
  const raw = Math.round(diagonal * BLOCK_SIZE_RATIO);
  return clamp(raw, MIN_BLOCK_SIZE, MAX_BLOCK_SIZE);
}

/**
 * ImageData相当の配列(`Uint8ClampedArray`, `width`, `height`)を受け取り、`blockSize` 四方の
 * ブロックごとにRGBA各チャンネルを平均化(ブロック平均)した新しい配列を返す純粋関数。
 * 入力配列は変更しない。`width`/`height` が `blockSize` で割り切れない場合、右端・下端の
 * 端数ブロックは実際に残っているピクセル数だけで平均化する(欠けた分を0埋めしない)。
 */
export function pixelateImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  blockSize: number,
): Uint8ClampedArray<ArrayBuffer> {
  // `new Uint8ClampedArray(length)` は常に `ArrayBuffer` 裏付けの型になる(TypeScriptの
  // TypedArray型が汎用化されて以降、コピーコンストラクタ版だと入力側の型パラメータを
  // 引き継いでしまい `new ImageData()` の期待する `Uint8ClampedArray<ArrayBuffer>` と
  // 合わないことがあるため、`length` + `set()` で明示的に新規確保する)。
  const output = new Uint8ClampedArray(data.length);
  output.set(data);
  if (width <= 0 || height <= 0 || blockSize <= 0) {
    return output;
  }

  const channels = 4;

  for (let blockY = 0; blockY < height; blockY += blockSize) {
    const blockHeight = Math.min(blockSize, height - blockY);
    for (let blockX = 0; blockX < width; blockX += blockSize) {
      const blockWidth = Math.min(blockSize, width - blockX);
      const pixelCount = blockWidth * blockHeight;

      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;

      for (let y = 0; y < blockHeight; y++) {
        const rowOffset = ((blockY + y) * width + blockX) * channels;
        for (let x = 0; x < blockWidth; x++) {
          const idx = rowOffset + x * channels;
          rSum += data[idx];
          gSum += data[idx + 1];
          bSum += data[idx + 2];
          aSum += data[idx + 3];
        }
      }

      const rAvg = Math.round(rSum / pixelCount);
      const gAvg = Math.round(gSum / pixelCount);
      const bAvg = Math.round(bSum / pixelCount);
      const aAvg = Math.round(aSum / pixelCount);

      for (let y = 0; y < blockHeight; y++) {
        const rowOffset = ((blockY + y) * width + blockX) * channels;
        for (let x = 0; x < blockWidth; x++) {
          const idx = rowOffset + x * channels;
          output[idx] = rAvg;
          output[idx + 1] = gAvg;
          output[idx + 2] = bAvg;
          output[idx + 3] = aAvg;
        }
      }
    }
  }

  return output;
}

/** `--arrow-color` を読み取る(選択矩形プレビューの枠線色として流用。DOM依存、自動テスト対象外)。 */
const OUTLINE_COLOR_FALLBACK = "#FF5C8A";
const OUTLINE_COLOR_CSS_VAR = "--arrow-color";

function resolveOutlineColor(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(OUTLINE_COLOR_CSS_VAR)
    .trim();
  return value || OUTLINE_COLOR_FALLBACK;
}

/** 選択矩形のプレビュー枠(破線)を描く。焼き込みではなく見た目のみ(DOM依存、自動テスト対象外)。 */
function drawSelectionOutline(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

/**
 * 選択矩形のImageDataのみを取得しピクセル化して焼き込む(DOM依存、自動テスト対象外)。
 * 処理対象を矩形に限定することで、大きな画像(5K Retina全画面等)でもCanvas全体を
 * 処理せずに済む(パフォーマンス要件)。
 */
function applyMosaic(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width <= 0 || height <= 0) {
    return;
  }

  const imageData = ctx.getImageData(x, y, width, height);
  const blockSize = mosaicBlockSize(canvasWidth, canvasHeight);
  const pixelated = pixelateImageData(imageData.data, width, height, blockSize);
  ctx.putImageData(new ImageData(pixelated, width, height), x, y);
}

/**
 * Canvas上のポインタ操作からモザイクツールを結線する(Container相当、DOM依存、自動テスト
 * 対象外)。
 *
 * 選択中ツールが `"mosaic"` のときのみドラッグを受け付ける(`canvasState.activeTool`)。
 * ドラッグ中は `pointerdown` 時点のImageDataへ毎回復元してから選択矩形の枠線プレビューを
 * 描く(矢印ツールと同じスナップショット→pointerupで焼き込みパターン。プレビューは矩形枠
 * 表示のみで、ピクセル化はpointerup時に1回だけ行う)。`pointerup`/`pointercancel` で
 * スナップショットへ復元したうえで選択矩形のImageDataのみをピクセル化し焼き込む(復元しない。
 * 以降のコピー結果に反映される、ARCH §7)。戻り値は購読解除関数。
 *
 * MUST-1(レビュー2026-09-24): `arrowTool.ts::bindArrowTool()`と同じ判定
 * (`isSameCanvasImage()`)でドラッグ中の非同期Canvas差し替えを検知し、中断する。
 */
export function bindMosaicTool(canvas: HTMLCanvasElement): () => void {
  let start: Point | null = null;
  let snapshot: ImageData | null = null;
  let imageAtDragStart: CanvasImage | null = null;

  const toCanvasPoint = (event: PointerEvent): Point => {
    const rect = canvas.getBoundingClientRect();
    return clientToCanvasPoint({
      clientX: event.clientX,
      clientY: event.clientY,
      rectLeft: rect.left,
      rectTop: rect.top,
      rectWidth: rect.width,
      rectHeight: rect.height,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    });
  };

  /** ドラッグ状態を破棄する(通常終了・中断のいずれでも呼ぶ、MUST-1)。 */
  const resetDrag = (event: PointerEvent): void => {
    start = null;
    snapshot = null;
    imageAtDragStart = null;
    setDrawing(false);
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };

  const handlePointerDown = (event: PointerEvent): void => {
    const canvasState = getCanvasState();
    if (canvasState.activeTool !== "mosaic" || !canvasState.image) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    // T31: モザイクは即焼き込みのまま。開始前に編集中の図形(矢印・矩形・円)を確定し、
    // 確定済みのピクセルをスナップショットに含める(Undoの順序も「図形→モザイク」になる)。
    commitPendingShape();
    start = toCanvasPoint(event);
    snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    imageAtDragStart = canvasState.image;
    setDrawing(true);
    canvas.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (!start || !snapshot) {
      return;
    }
    if (!isSameCanvasImage(getCanvasState().image, imageAtDragStart)) {
      // MUST-1: ドラッグ中にCanvasが非同期に差し替えられた。古いsnapshotは新しい画像と
      // 食い違うため、選択矩形のプレビュー描画をせず中断する。
      resetDrag(event);
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const current = toCanvasPoint(event);
    const rect = computeMosaicRect(start, current, canvas.width, canvas.height);
    ctx.putImageData(snapshot, 0, 0);
    if (rect) {
      drawSelectionOutline(ctx, rect, resolveOutlineColor());
    }
  };

  const finishDrag = (event: PointerEvent): void => {
    if (!start || !snapshot) {
      return;
    }
    if (isSameCanvasImage(getCanvasState().image, imageAtDragStart)) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const end = toCanvasPoint(event);
        const rect = computeMosaicRect(start, end, canvas.width, canvas.height);
        ctx.putImageData(snapshot, 0, 0);
        if (rect) {
          // T24: 確定焼き込み(applyMosaic)の直前に、ドラッグ開始時のsnapshotから
          // 変更対象矩形分を切り出しUndoスタックへpushする(矢印ツールと同じ作法、
          // ARCH §5.2)。applyMosaic自体は従来どおり元の`rect`(非整数の可能性あり)を
          // 渡し、内部の丸め処理も含め挙動不変のままにする。
          const roundedRect = roundRect(rect);
          const before = cropSnapshotRect(
            snapshot.data,
            snapshot.width,
            snapshot.height,
            roundedRect,
          );
          pushUndoStep(roundedRect, before);
          applyMosaic(ctx, rect, canvas.width, canvas.height);
        }
      }
    }
    // MUST-1: 画像が差し替えられていた場合はここでも焼き込まず、状態のリセットのみ行う。
    resetDrag(event);
  };

  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", finishDrag);
  canvas.addEventListener("pointercancel", finishDrag);

  return () => {
    canvas.removeEventListener("pointerdown", handlePointerDown);
    canvas.removeEventListener("pointermove", handlePointerMove);
    canvas.removeEventListener("pointerup", finishDrag);
    canvas.removeEventListener("pointercancel", finishDrag);
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
