//! テキストの寸法・見た目・入力終了の判定の純粋関数(T27 の `textTool.ts` から T33【改訂 2026-09-24】で分離)。
//!
//! テキストがオブジェクト(`shapeEdit.ts::TextShape`)になり、`shapeEdit.ts`・`objectModel.ts`・
//! `documentSurface.ts` からも寸法・描画を使うため、DOM結線(`textTool.ts`)と状態
//! (`documentState.ts`)に依存しないモジュールへ切り出した(`textTool.ts` → `documentState.ts` →
//! `shapeEdit.ts` → `textTool.ts` の循環を避ける)。`textTool.ts` は本モジュールを再exportする。

import { clipRectToCanvas, type Rect } from "../coords";
import type { TextShape } from "../shapeEdit";
import type { FontSize } from "../toolSettings";

// --- 定数(テキストの寸法・見た目はすべてここに集約) ---

/**
 * フォント実寸(「中」)= Canvas対角線(ピクセルバッファサイズ=画像の実ピクセル)× この比率。
 *
 * 【設計判断】矢印の胴幅(`arrowTool.ts`の`LINE_WIDTH_RATIO`=0.0135、典型2000x1000で30px)と同じ
 * 「対角線基準・決定論的・クランプ付き」の考え方にそろえた。典型サイズ(2000x1000、対角線≈2236px)で
 * 「中」=54px。Retina(2倍)の画面を撮った画像なら表示上27pt相当で、胴幅30pxの矢印と並べたとき
 * 文字の高さ(大文字の高さ≈0.7em≈38px)が矢じり(長さ90px)より小さく胴幅より大きい、
 * 「矢印に添える注記」として違和感のない大きさになる(`output/reports/ui/text-sizes.png`で目視確認)。
 */
const FONT_SIZE_RATIO = 0.024;
/** 「中」の下限・上限(px)。下限は極小画像でも読める大きさ、上限は5K相当で大きくなりすぎないため。 */
const MIN_BASE_FONT_SIZE = 18;
const MAX_BASE_FONT_SIZE = 128;
/**
 * 小・中・大の倍率(「中」を1とする)。1.5倍刻み(2/3・1・1.5)にして、隣り合う段階の差が
 * どの画像サイズでも同じ比率で見分けられるようにした。
 */
export const FONT_SIZE_MULTIPLIER: Record<FontSize, number> = {
  small: 2 / 3,
  medium: 1,
  large: 1.5,
};
/** 行の高さ = フォント実寸 × この比率(入力欄の高さ・クリック位置からの縦配置に使う)。 */
const LINE_HEIGHT_RATIO = 1.25;
/** 太字寄りにして細い画面文字の上でも埋もれにくくする。 */
const FONT_WEIGHT = "600";
/** システムフォント(依存追加なし。日本語はOS標準のフォールバックに任せる)。 */
const FONT_FAMILY = 'system-ui, -apple-system, "Helvetica Neue", sans-serif';
/**
 * 影(背景に埋もれないための薄いドロップシャドウ)。
 *
 * 【設計判断】縁取り(stroke)ではなく影を採用した。矢印(`arrowTool.ts`の`SHADOW_COLOR`)と同じ
 * 半透明の黒35%にそろえ、注釈全体を同じトーンにするため。縁取りは文字の周りに2色目の太い線が
 * 入り、矢印・矩形・円(縁取りなし)より重く見える。ぼかし・オフセットはフォント実寸に比例させる
 * (矢印が胴幅に比例させているのと同じ理由で、画像サイズによらず見た目の比率を保つ)。
 */
const SHADOW_COLOR = "rgba(0, 0, 0, 0.35)";
const SHADOW_BLUR_RATIO = 0.08;
const SHADOW_OFFSET_Y_RATIO = 0.05;
/** Undo用の外接矩形に足すアンチエイリアス分の余白(px)。 */
const ANTIALIAS_MARGIN = 2;
/** IMEが変換確定のEnterなどで送るkeyCode(WebKitはcompositionend後にこの値でkeydownを送る)。 */
const IME_PROCESS_KEY_CODE = 229;

// --- 純粋関数 ---

/** フォントサイズ段階と画像サイズからフォント実寸(px、Canvasピクセル)を決定論的に算出する。 */
export function computeFontSizePx(
  fontSize: FontSize,
  canvasWidth: number,
  canvasHeight: number,
): number {
  const diagonal = Math.hypot(canvasWidth, canvasHeight);
  const base = clamp(Math.round(diagonal * FONT_SIZE_RATIO), MIN_BASE_FONT_SIZE, MAX_BASE_FONT_SIZE);
  return Math.round(base * FONT_SIZE_MULTIPLIER[fontSize]);
}

/** 行の高さ(px、Canvasピクセル)。 */
export function textLineHeight(fontPx: number): number {
  return Math.round(fontPx * LINE_HEIGHT_RATIO);
}

export interface TextShadowParams {
  blur: number;
  offsetY: number;
  color: string;
}

/** フォント実寸に比例した影のパラメータ。 */
export function textShadowParams(fontPx: number): TextShadowParams {
  return {
    blur: fontPx * SHADOW_BLUR_RATIO,
    offsetY: fontPx * SHADOW_OFFSET_Y_RATIO,
    color: SHADOW_COLOR,
  };
}

/** Canvas実ピクセル→CSS表示ピクセルの倍率(表示幅/実ピクセル幅)。 */
export function canvasToCssScale(cssWidth: number, canvasWidth: number): number {
  return canvasWidth > 0 && cssWidth > 0 ? cssWidth / canvasWidth : 1;
}

/** クリック位置(y)が行の縦中央になる行の上端。画像の上下からはみ出さないようクランプする。 */
export function computeTextLineTop(clickY: number, lineHeight: number, canvasHeight: number): number {
  const top = clickY - lineHeight / 2;
  return Math.max(0, Math.min(top, canvasHeight - lineHeight));
}

/**
 * 行ボックス(上端`top`・高さ`lineHeight`)内のベースライン位置。CSSのインラインレイアウトと
 * 同じ式(half-leading = (line-height − (ascent + descent)) / 2)で、入力欄に見えている文字と
 * 焼き込み結果の縦位置を一致させる。`ascent`/`descent`はフォントの値(`fontBoundingBox*`)。
 */
export function computeBaselineY(
  top: number,
  lineHeight: number,
  ascent: number,
  descent: number,
): number {
  return top + (lineHeight - (ascent + descent)) / 2 + ascent;
}

export interface TextInkMetrics {
  /** `actualBoundingBoxLeft`(描画原点より左へはみ出す量、正が左)。 */
  left: number;
  /** `actualBoundingBoxRight`。 */
  right: number;
  /** `actualBoundingBoxAscent`。 */
  ascent: number;
  /** `actualBoundingBoxDescent`。 */
  descent: number;
}

export interface TextBoundingRectInput {
  x: number;
  baselineY: number;
  metrics: TextInkMetrics;
  shadow: TextShadowParams;
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * 焼き込みで変わる範囲(Undoへ積む外接矩形)。`ctx.measureText()`の実際の外接値に、影の
 * ぼかし×2(ぼかしは概ね半径分外へ滲むため安全側に2倍、矢印と同じ考え方)・下方向オフセット・
 * アンチエイリアス分を全方向に足し、整数化してCanvas内へクリップする。
 */
export function computeTextBoundingRect(input: TextBoundingRectInput): Rect {
  const { x, baselineY, metrics, shadow } = input;
  const margin = shadow.blur * 2 + shadow.offsetY + ANTIALIAS_MARGIN;
  const minX = Math.floor(x - metrics.left - margin);
  const minY = Math.floor(baselineY - metrics.ascent - margin);
  const maxX = Math.ceil(x + metrics.right + margin);
  const maxY = Math.ceil(baselineY + metrics.descent + margin);
  const clipped = clipRectToCanvas(
    { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    input.canvasWidth,
    input.canvasHeight,
  );
  return {
    x: Math.round(clipped.x),
    y: Math.round(clipped.y),
    width: Math.max(0, Math.round(clipped.width)),
    height: Math.max(0, Math.round(clipped.height)),
  };
}

export interface TextKeyEventLike {
  key: string;
  isComposing: boolean;
  keyCode: number;
}

/**
 * IME変換中のキー入力か。`isComposing`に加え、`compositionstart`〜`compositionend`の間
 * (`composing`)と、変換確定のEnterを`compositionend`の後に`keyCode 229`で送る実装(WebKit)を考慮する。
 */
export function isImeComposingKey(event: TextKeyEventLike, composing: boolean): boolean {
  return event.isComposing || composing || event.keyCode === IME_PROCESS_KEY_CODE;
}

/** 入力欄のkeydownを確定(`commit`)・取消(`cancel`)・何もしない(`null`)に振り分ける。 */
export function textKeyAction(
  event: TextKeyEventLike,
  composing: boolean,
): "commit" | "cancel" | null {
  if (isImeComposingKey(event, composing)) {
    return null;
  }
  if (event.key === "Enter") {
    return "commit";
  }
  if (event.key === "Escape") {
    return "cancel";
  }
  return null;
}

export interface TextSession {
  done: boolean;
}

/** 入力を終える理由。`external`は他の操作(ツール切替・コピー・差し替え前の確定等)からの確定。 */
export type TextFinishReason = "enter" | "blur" | "external" | "escape" | "imageChanged";

export type TextFinishAction =
  | { type: "commit"; text: string }
  | { type: "cancel" }
  | { type: "none" };

export function createTextSession(): TextSession {
  return { done: false };
}

/**
 * 入力の終了(確定・取消)の状態遷移。一度終わったセッションは二度処理しない(Enterで確定した
 * 直後に入力欄の除去でblurが来る等)。Esc・画像差し替えは焼き込まない。空白のみも焼き込まない。
 */
export function finishTextSession(
  session: TextSession,
  reason: TextFinishReason,
  value: string,
): { session: TextSession; action: TextFinishAction } {
  if (session.done) {
    return { session, action: { type: "none" } };
  }
  const next: TextSession = { done: true };
  if (reason === "escape" || reason === "imageChanged" || value.trim() === "") {
    return { session: next, action: { type: "cancel" } };
  }
  return { session: next, action: { type: "commit", text: value } };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Canvasの`font`指定(太字寄り・システムフォント)。 */
export function fontString(px: number): string {
  return `${FONT_WEIGHT} ${px}px ${FONT_FAMILY}`;
}


// --- テキストオブジェクト(T33) ---

/** テキストオブジェクトのフォント実寸(文字サイズ段階と画像サイズから決まる)。 */
export function textShapeFontPx(shape: TextShape, canvasWidth: number, canvasHeight: number): number {
  return computeFontSizePx(shape.fontSize, canvasWidth, canvasHeight);
}

/**
 * 行ボックス(当たり判定・移動のクランプ・選択枠に使う)。横は描画原点`x`から、左右へ
 * はみ出す字形(`actualBoundingBox*`)も含めた文字幅、縦は行の上端`top`から行の高さ。
 */
export function textShapeBox(shape: TextShape, canvasWidth: number, canvasHeight: number): Rect {
  const lineHeight = textLineHeight(textShapeFontPx(shape, canvasWidth, canvasHeight));
  const left = Math.max(0, shape.metrics.left);
  const right = Math.max(shape.metrics.width, shape.metrics.right);
  return { x: shape.x - left, y: shape.top, width: left + right, height: lineHeight };
}

/** 描画するベースラインの位置(入力欄に見えていた文字と同じ縦位置、T27と同じ式)。 */
export function textShapeBaselineY(shape: TextShape, canvasWidth: number, canvasHeight: number): number {
  const lineHeight = textLineHeight(textShapeFontPx(shape, canvasWidth, canvasHeight));
  return computeBaselineY(shape.top, lineHeight, shape.metrics.fontAscent, shape.metrics.fontDescent);
}

/** 描画で変わる範囲(影・アンチエイリアス込み、上限超過の焼き込み範囲)。 */
export function textShapeBoundingRect(shape: TextShape, canvasWidth: number, canvasHeight: number): Rect {
  const { left, right, ascent, descent } = shape.metrics;
  return computeTextBoundingRect({
    x: shape.x,
    baselineY: textShapeBaselineY(shape, canvasWidth, canvasHeight),
    metrics: { left, right, ascent, descent },
    shadow: textShadowParams(textShapeFontPx(shape, canvasWidth, canvasHeight)),
    canvasWidth,
    canvasHeight,
  });
}

/** テキストオブジェクトを描く(T27の焼き込みと同じ見た目: 太字寄り・影付き)。 */
export function drawTextShape(
  ctx: CanvasRenderingContext2D,
  shape: TextShape,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const fontPx = textShapeFontPx(shape, canvasWidth, canvasHeight);
  const shadow = textShadowParams(fontPx);
  ctx.save();
  ctx.font = fontString(fontPx);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = shape.color;
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = shadow.offsetY;
  ctx.fillText(shape.text, shape.x, textShapeBaselineY(shape, canvasWidth, canvasHeight));
  ctx.restore();
}

export type TextEditOutcome =
  | { type: "none" }
  | { type: "add"; text: string }
  | { type: "update"; text: string }
  | { type: "remove" };

/**
 * 入力欄の終わり方から、オブジェクトへの操作を決める。`originalText`は再編集なら編集前の文字、
 * 新規入力なら`null`。Esc・画像差し替えは何もしない(再編集なら編集前のまま)。再編集で
 * 空(空白のみ)にして確定したら削除、同じ文字なら何もしない(取り消しに空の操作を積まない)。
 */
export function decideTextEdit(
  reason: TextFinishReason,
  value: string,
  originalText: string | null,
): TextEditOutcome {
  if (reason === "escape" || reason === "imageChanged") {
    return { type: "none" };
  }
  const empty = value.trim() === "";
  if (originalText === null) {
    return empty ? { type: "none" } : { type: "add", text: value };
  }
  if (empty) {
    return { type: "remove" };
  }
  return value === originalText ? { type: "none" } : { type: "update", text: value };
}
