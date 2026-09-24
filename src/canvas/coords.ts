//! CSS表示座標→Canvasピクセル座標の変換(T09。ARCHに座標変換の明示的な規定が
//! 無いため、本タスクで最小の方式を選定した)。
//!
//! `#capture-canvas`(styles.css `max-width: 100%; max-height: 100%;`)は、Canvasの
//! ピクセルバッファサイズ(`canvas.width`/`height`。`render.ts` が画像の
//! `naturalWidth`/`naturalHeight` をそのまま採用、= 画像の実ピクセル)と、CSSが決める
//! 表示サイズ(`getBoundingClientRect()`)が異なりうる。矢印ツールのドラッグ座標
//! (`PointerEvent.clientX`/`clientY`)は表示座標系(CSSピクセル)なので、焼き込み先の
//! Canvasピクセル座標系へ拡大縮小率(`canvasサイズ ÷ 表示サイズ`)で変換する。
//!
//! `window.devicePixelRatio` はこの変換に登場しない。Canvasのピクセルバッファサイズは
//! `screencapture` が出力した画像の実ピクセル数で既に固定されており(Retinaディスプレイでは
//! この時点で高解像度になっている)、ブラウザの表示側デバイスピクセル比とは独立しているため。
//!
//! DOM型(`DOMRect`/`PointerEvent`)に依存しないプレーンな数値のみを受け取る純粋関数として
//! 切り出し、Vitestの既定環境(Node、DOM無し)でも直接テストできるようにしてある。
//!
//! T20【改訂 2026-09-24】: `Rect`/`normalizeRect()`/`clipRectToCanvas()` を
//! `tools/mosaicTool.ts` から移設した(挙動不変)。矩形の正規化・クリップは矩形・円・
//! モザイクの3ツールが共通に必要とする純粋な幾何計算のため、本ファイルへ集約する
//! (ARCH §5.2)。
//!
//! T25【改訂 2026-09-24】: `roundRect()`/`cropSnapshotRect()` を `tools/arrowTool.ts`・
//! `tools/mosaicTool.ts` から移設した(挙動不変、PJM指示)。両ファイルはそれぞれ「2ファイル
//! のみの重複は共通化しない」方針で同一ロジックを自己完結的に複製していたが、矩形ツール
//! (`rectangleTool.ts`)が3ファイル目の利用者になったため、Rule of Three(AGENTS.md「3箇所
//! 以上の重複で共通化を検討」)に基づき本ファイルへ集約する。`normalizeRect()`/
//! `clipRectToCanvas()` と同じ「Undo連携で使う純粋な幾何・配列操作」という性質のため、
//! ここに置く。矢印・矩形・円それぞれの太さ比率(`LINE_WIDTH_RATIO`等)自体は視覚調整の
//! ためツールごとに異なってよく、集約の対象外のまま(ARCH §5.2)。

export interface Point {
  x: number;
  y: number;
}

/** Canvasピクセル座標系の矩形(T20【改訂 2026-09-24】。旧 `tools/mosaicTool.ts` から移設)。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `clientToCanvasPoint()` の入力。呼び出し側(DOM依存コード)が実測値を渡す。 */
export interface ClientToCanvasPointParams {
  /** `PointerEvent.clientX`/`clientY`(表示座標系、CSSピクセル)。 */
  clientX: number;
  clientY: number;
  /** `canvas.getBoundingClientRect()` の `left`/`top`/`width`/`height`。 */
  rectLeft: number;
  rectTop: number;
  rectWidth: number;
  rectHeight: number;
  /** `canvas.width`/`height`(ピクセルバッファサイズ、画像の実ピクセル)。 */
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * 表示座標(CSSピクセル)をCanvasピクセル座標へ変換する純粋関数。
 *
 * 表示サイズ(`rectWidth`/`rectHeight`)が0以下の場合はスケール不能なため `{ x: 0, y: 0 }` を
 * 返す(Canvas未描画・非表示状態からの呼び出しに対する防御)。結果はCanvas範囲内
 * ([0, canvasWidth] × [0, canvasHeight])にクランプする(ドラッグがCanvas外へはみ出す場合に備える)。
 */
export function clientToCanvasPoint(params: ClientToCanvasPointParams): Point {
  const {
    clientX,
    clientY,
    rectLeft,
    rectTop,
    rectWidth,
    rectHeight,
    canvasWidth,
    canvasHeight,
  } = params;

  if (rectWidth <= 0 || rectHeight <= 0) {
    return { x: 0, y: 0 };
  }

  const scaleX = canvasWidth / rectWidth;
  const scaleY = canvasHeight / rectHeight;
  const x = (clientX - rectLeft) * scaleX;
  const y = (clientY - rectTop) * scaleY;

  return {
    x: clamp(x, 0, canvasWidth),
    y: clamp(y, 0, canvasHeight),
  };
}

/**
 * ドラッグの始点・終点(Canvasピクセル座標)から矩形を正規化する純粋関数
 * (T20【改訂 2026-09-24】。旧 `tools/mosaicTool.ts` から移設、挙動不変)。
 * 右→左・下→上への逆方向ドラッグでも `x`/`y` が左上、`width`/`height` が非負になるようにする。
 * 矩形・円ツール(T25・T26)もこの関数を再利用する(ARCH §5.2)。
 */
export function normalizeRect(start: Point, end: Point): Rect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/**
 * 矩形をCanvas範囲([0, canvasWidth] × [0, canvasHeight])にクリップする純粋関数
 * (T20【改訂 2026-09-24】。旧 `tools/mosaicTool.ts` から移設、挙動不変)。
 * `clientToCanvasPoint()` は個々の点を既にクランプしているが、本関数は矩形単位で独立に
 * テスト・再利用できるよう防御的に用意する。
 */
export function clipRectToCanvas(
  rect: Rect,
  canvasWidth: number,
  canvasHeight: number,
): Rect {
  const x = clamp(rect.x, 0, canvasWidth);
  const y = clamp(rect.y, 0, canvasHeight);
  const right = clamp(rect.x + rect.width, 0, canvasWidth);
  const bottom = clamp(rect.y + rect.height, 0, canvasHeight);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * `rect`の各フィールドを最も近い整数へ丸める純粋関数(T25【改訂 2026-09-24】。旧
 * `tools/mosaicTool.ts` から移設、挙動不変)。`width`/`height`は0未満にならないよう
 * クランプする(丸め誤差で負値になるのを防ぐ)。`getImageData()`/`putImageData()`に
 * そのまま渡せる整数矩形が必要な箇所(Undoの`before`切り出し等)で使う。
 */
export function roundRect(rect: Rect): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}

/**
 * ドラッグ開始時点の全体スナップショット(Canvas全体のRGBA8、`data`は行優先)から`rect`領域
 * 分のピクセルのみを切り出す純粋関数(T25【改訂 2026-09-24】。旧 `tools/arrowTool.ts`/
 * `tools/mosaicTool.ts` から移設、挙動不変。ARCH §5.2「追加の`getImageData()`呼び出しなしで
 * `undoStack.pushUndoStep(rect, before)`を呼ぶ」)。`rect`は整数座標(呼び出し側が
 * `roundRect()`済みの値を渡す)であることを前提とするが、範囲外読み出しにならないよう
 * 防御的にクランプする。
 */
export function cropSnapshotRect(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  rect: Rect,
): { data: Uint8ClampedArray; width: number; height: number } {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  // スナップショットの範囲外を読まないよう防御的にクランプする(`width`/`height`は
  // スナップショット自体のサイズ。`rect`はCanvas範囲内クリップ済みの想定だが、
  // 呼び出し側の前提が崩れても配列外読み出しにならないようにする)。
  const cropWidth = Math.max(0, Math.min(Math.round(rect.width), width - x));
  const cropHeight = Math.max(0, Math.min(Math.round(rect.height), height - y));
  const channels = 4;
  const output = new Uint8ClampedArray(cropWidth * cropHeight * channels);

  for (let row = 0; row < cropHeight; row++) {
    const srcRowStart = ((y + row) * width + x) * channels;
    const destRowStart = row * cropWidth * channels;
    output.set(
      data.subarray(srcRowStart, srcRowStart + cropWidth * channels),
      destRowStart,
    );
  }

  return { data: output, width: cropWidth, height: cropHeight };
}
