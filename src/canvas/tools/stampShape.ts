//! スタンプ(番号・記号の丸)の寸法・記号の色・番号・描画・当たり判定の純粋関数
//! (UI_quick-edits §2.3・§2.4、ARCH_quick-edits §5.1・§5.3)。
//!
//! 状態ストア・DOM(描画先の `ctx` を除く)・`ui/`・`ipc/` には依存しない。番号は形に持たず、
//! 描くたびに `stampNumbers()` で `id` の順位から求める(消すと詰まり、取り消しで戻る)。

import type { Point } from "../coords";
import { shapeStyleDiagonal } from "../styleBasis";
import type { FontSize } from "../toolSettings";
import { fontSizePxForDiagonal } from "./textLayout";

// --- 型 ---

/** スタンプの種類: 番号と 4 つの記号(✓・×・!・?)。 */
export type StampGlyph = "number" | "check" | "cross" | "exclamation" | "question";

export interface StampShape {
  kind: "stamp";
  /** 丸の中心(Canvas ピクセル)。 */
  center: Point;
  glyph: StampGlyph;
  /** 丸の色(`#RRGGBB`)。 */
  color: string;
  /** 文字サイズの段階(直径はテキストの文字の大きさに連動する)。 */
  fontSize: FontSize;
  /** 大きさの基準の対角線(px)。トリミングの確定で残ったときだけ付く(`styleBasis.ts`)。 */
  styleBasis?: number;
}

// --- 定数(UI §2.3・§2.4) ---

/** 直径 = round(文字の大きさ × この比率)。 */
export const STAMP_DIAMETER_RATIO = 1.2;
/** 直径の下限(px)。 */
export const STAMP_MIN_DIAMETER = 20;
/** 白の縁の太さ = max(STAMP_MIN_RING_WIDTH, round(直径 × この比率))。 */
export const STAMP_RING_RATIO = 0.07;
const STAMP_MIN_RING_WIDTH = 2;
/** 1 桁の数字・「!」「?」の文字の大きさ = round(直径 × この比率)。 */
export const STAMP_DIGIT_RATIO_1 = 0.58;
/** 2 桁以上の数字の文字の大きさ = round(直径 × この比率)(丸からはみ出さない)。 */
export const STAMP_DIGIT_RATIO_2 = 0.48;
/** 「✓」「×」の線の太さ = 直径 × この比率(端は丸)。 */
export const STAMP_STROKE_RATIO = 0.11;
/** 記号を黒にする白とのコントラスト比のしきい値(これ未満なら黒)。 */
export const STAMP_GLYPH_CONTRAST_THRESHOLD = 2.5;
/** 白とのコントラストが低い明るい色の上の記号の色。 */
export const STAMP_DARK_GLYPH_COLOR = "#1a1a1a";
/** 記号の基本の色・白の縁の色。 */
export const STAMP_LIGHT_COLOR = "#ffffff";

/** 影: 黒 35%(テキスト・矢印と同じ)、ぼかし D × 0.08、下へ D × 0.04。 */
const SHADOW_COLOR = "rgba(0, 0, 0, 0.35)";
const SHADOW_BLUR_RATIO = 0.08;
const SHADOW_OFFSET_Y_RATIO = 0.04;
/** 影を消すときの色(Canvas の既定値と同じ透明)。 */
const NO_SHADOW_COLOR = "rgba(0, 0, 0, 0)";
/** 記号の字体(テキストと同じ字体を太字で)。 */
const GLYPH_FONT_WEIGHT = "700";
const GLYPH_FONT_FAMILY = 'system-ui, -apple-system, "Helvetica Neue", sans-serif';

/** ✓ の折れ線(直径 D に対する中心からの位置)。 */
const CHECK_POINTS: readonly (readonly [number, number])[] = [
  [-0.22, 0.01],
  [-0.06, 0.17],
  [0.23, -0.15],
];
/** × の対角線の端(中心から ±この比率 × D)。 */
const CROSS_HALF_RATIO = 0.165;

// --- 寸法 ---

/**
 * 文字サイズの段階と大きさの基準の対角線(px)から直径(px)を決定論的に求める。
 * 文字の大きさはテキストと同じ `fontSizePxForDiagonal()`(QE-T17)。
 */
export function stampDiameter(fontSize: FontSize, diagonal: number): number {
  const fontPx = fontSizePxForDiagonal(fontSize, diagonal);
  return Math.max(STAMP_MIN_DIAMETER, Math.round(fontPx * STAMP_DIAMETER_RATIO));
}

/** スタンプの直径(px)。対角線は `shapeStyleDiagonal()`(トリミング後は `styleBasis`)。 */
export function stampShapeDiameter(
  shape: StampShape,
  canvasWidth: number,
  canvasHeight: number,
): number {
  return stampDiameter(shape.fontSize, shapeStyleDiagonal(shape, canvasWidth, canvasHeight));
}

/** 白の縁の太さ(px)。 */
export function stampRingWidth(diameter: number): number {
  return Math.max(STAMP_MIN_RING_WIDTH, Math.round(diameter * STAMP_RING_RATIO));
}

/** 数字・「!」「?」の文字の大きさ(px)。`digits` は文字数(記号は 1)。 */
export function stampDigitPx(diameter: number, digits: number): number {
  const ratio = digits >= 2 ? STAMP_DIGIT_RATIO_2 : STAMP_DIGIT_RATIO_1;
  return Math.round(diameter * ratio);
}

/** 「✓」「×」の線の太さ(px)。 */
export function stampStrokeWidth(diameter: number): number {
  return diameter * STAMP_STROKE_RATIO;
}

// --- 記号の色 ---

/** `#RRGGBB` の相対輝度(WCAG 2.x の式)。形式が違えば `null`。 */
function relativeLuminance(color: string): number | null {
  const match = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(color);
  if (!match) return null;
  const [r, g, b] = match.slice(1).map((hex) => {
    const c = parseInt(hex, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 丸の色の上に描く記号の色。白とのコントラスト比が 2.5 未満の明るい色(黄・橙・緑など)
 * では `#1a1a1a`、それ以外は白。色コードとして読めないときは白(基本の色)にする。
 */
export function stampGlyphColor(color: string): string {
  const luminance = relativeLuminance(color);
  if (luminance === null) return STAMP_LIGHT_COLOR;
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  return contrastWithWhite < STAMP_GLYPH_CONTRAST_THRESHOLD
    ? STAMP_DARK_GLYPH_COLOR
    : STAMP_LIGHT_COLOR;
}

// --- 番号 ---

/** 番号スタンプかを判定する(`EditableShape` に加わる前の注釈とも比べられるよう構造で見る)。 */
export function isNumberStamp(shape: { kind: string }): shape is StampShape {
  return shape.kind === "stamp" && (shape as StampShape).glyph === "number";
}

/**
 * 番号スタンプの `id` → 番号(1 から)。番号は置いた順 = `id` の昇順の順位で、
 * 配列の順(重ね順)によらない。記号スタンプ・他の注釈は数えない。
 */
export function stampNumbers(
  objects: readonly { id: number; shape: { kind: string } }[],
): Map<number, number> {
  const ids = objects
    .filter((object) => isNumberStamp(object.shape))
    .map((object) => object.id)
    .sort((a, b) => a - b);
  return new Map(ids.map((id, index) => [id, index + 1]));
}

// --- 当たり判定・描画 ---

/** 点がスタンプの円の内側(縁を含む)にあるか。 */
export function hitStamp(
  shape: StampShape,
  point: Point,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  const radius = stampShapeDiameter(shape, canvasWidth, canvasHeight) / 2;
  return Math.hypot(point.x - shape.center.x, point.y - shape.center.y) <= radius;
}

function fillCircle(ctx: CanvasRenderingContext2D, center: Point, radius: number): void {
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** 文字(数字・!・?)を丸の中心にそろえて描く。縦はインクの上下の中央を中心に合わせる。 */
function drawGlyphText(
  ctx: CanvasRenderingContext2D,
  text: string,
  center: Point,
  diameter: number,
): void {
  ctx.font = `${GLYPH_FONT_WEIGHT} ${stampDigitPx(diameter, text.length)}px ${GLYPH_FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const metrics = ctx.measureText(text);
  const baselineY =
    center.y + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
  ctx.fillText(text, center.x, baselineY);
}

/** ✓・× を線で描く。 */
function drawGlyphStroke(
  ctx: CanvasRenderingContext2D,
  glyph: "check" | "cross",
  center: Point,
  diameter: number,
): void {
  ctx.lineWidth = stampStrokeWidth(diameter);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (glyph === "check") {
    CHECK_POINTS.forEach(([rx, ry], index) => {
      const x = center.x + rx * diameter;
      const y = center.y + ry * diameter;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  } else {
    const half = CROSS_HALF_RATIO * diameter;
    ctx.moveTo(center.x - half, center.y - half);
    ctx.lineTo(center.x + half, center.y + half);
    ctx.moveTo(center.x + half, center.y - half);
    ctx.lineTo(center.x - half, center.y + half);
  }
  ctx.stroke();
}

/**
 * スタンプを描く: 影 → 白の円(直径 D)→ 色の円(直径 D − 2 × 縁)→ 記号。
 * `label` は番号スタンプの番号(`stampNumbers()` の値。下書きは「今の数 + 1」)で、記号では使わない。
 * 番号スタンプで `label` が `null` なら丸だけを描く。
 */
export function drawStamp(
  ctx: CanvasRenderingContext2D,
  shape: StampShape,
  label: number | null,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const diameter = stampShapeDiameter(shape, canvasWidth, canvasHeight);
  const radius = diameter / 2;
  const { center } = shape;
  ctx.save();

  // 1・2. 影つきの白の円(白い地では影で、暗い地では白の縁で輪郭を出す)
  ctx.shadowColor = SHADOW_COLOR;
  ctx.shadowBlur = diameter * SHADOW_BLUR_RATIO;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = diameter * SHADOW_OFFSET_Y_RATIO;
  ctx.fillStyle = STAMP_LIGHT_COLOR;
  fillCircle(ctx, center, radius);

  // 3. 色の円(影は白の円の 1 回だけ)
  ctx.shadowColor = NO_SHADOW_COLOR;
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = shape.color;
  fillCircle(ctx, center, radius - stampRingWidth(diameter));

  // 4. 記号
  const glyphColor = stampGlyphColor(shape.color);
  ctx.fillStyle = glyphColor;
  ctx.strokeStyle = glyphColor;
  switch (shape.glyph) {
    case "number":
      if (label !== null) drawGlyphText(ctx, String(label), center, diameter);
      break;
    case "exclamation":
      drawGlyphText(ctx, "!", center, diameter);
      break;
    case "question":
      drawGlyphText(ctx, "?", center, diameter);
      break;
    case "check":
    case "cross":
      drawGlyphStroke(ctx, shape.glyph, center, diameter);
      break;
  }

  ctx.restore();
}
