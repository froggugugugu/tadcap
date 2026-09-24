//! テキストツール(T27、PRD FR-012・§10決定#10/#12、ARCH §5.2)。
//!
//! Canvasのクリック位置に単一行の入力欄(Canvasの兄弟要素として絶対配置した`<input>`)を重ね、
//! `Enter`(IME変換中を除く)またはフォーカスアウト(blur)で確定してCanvasへ焼き込み、`Esc`で取り消す。
//! 空文字(空白のみ)は何も焼き込まない。配置後の移動・再編集は提供しない(図形の編集はT31の矢印・
//! 矩形・円のみ)。
//!
//! - 入力欄は`<input>`のため、`shortcutGuards.ts::isEditableTarget()`によりCmd+C/Cmd+Z等の
//!   アプリショートカットと`pendingShapeKeys.ts`のEnter/Escを奪わない(T22・T31)。
//! - 入力欄の見た目(フォントサイズ・位置・行の高さ・影)はCanvas実ピクセルの値に表示倍率
//!   (`canvasToCssScale()`)を掛けて決め、焼き込み結果と一致させる。
//! - 確定・取消・画像差し替えの状態遷移と、各寸法の算出は純粋関数でユニットテストし、
//!   DOM/Canvasの結線(`bindTextTool`)はE2Eで検証する(project-config.md §11)。
//! - 画像差し替え: 通常経路(新規キャプチャ・履歴切替・コピー)は`main.ts`が差し替え前に
//!   `commitPendingText()`で確定する。確定を経ずに画像が差し替わった場合は、古い画像向けの
//!   入力として焼き込まずに破棄する(ドラッグ系ツールのMUST-1と同じ考え方)。

import {
  getCanvasState,
  isSameCanvasImage,
  subscribeCanvasState,
  type CanvasImage,
} from "../canvasState";
import { clientToCanvasPoint, clipRectToCanvas, type Point, type Rect } from "../coords";
import { commitPendingShape } from "../pendingShape";
import { getToolSettings, type FontSize } from "../toolSettings";
import { pushUndoStep } from "../undoStack";

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
/** 入力欄の最小幅(フォント実寸に対する比率。空の入力欄でもクリック位置が分かるように)。 */
const MIN_INPUT_WIDTH_RATIO = 1;
/** 入力欄の末尾の余白(キャレットが欄の端で欠けないように、フォント実寸に対する比率)。 */
const INPUT_TRAILING_RATIO = 0.5;
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

function fontString(px: number): string {
  return `${FONT_WEIGHT} ${px}px ${FONT_FAMILY}`;
}

// --- DOM/Canvas結線(E2Eで検証) ---

interface TextEditor {
  input: HTMLInputElement;
  session: TextSession;
  /** 行の左端・上端(Canvasピクセル)。 */
  x: number;
  top: number;
  fontPx: number;
  lineHeight: number;
  color: string;
  image: CanvasImage | null;
  composing: boolean;
}

let finishActive: ((reason: TextFinishReason) => void) | null = null;

/**
 * 入力中のテキストがあれば確定して焼き込む(新規キャプチャ・履歴切替・コピーの直前に
 * `main.ts`が呼ぶ)。入力中でなければ`false`。
 */
export function commitPendingText(): boolean {
  if (!finishActive) {
    return false;
  }
  finishActive("external");
  return true;
}

/** Canvasへテキストを焼き込む(確定直前に外接矩形を`pushUndoStep()`してから描く)。 */
function burnText(canvas: HTMLCanvasElement, editor: TextEditor, text: string): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.save();
  ctx.font = fontString(editor.fontPx);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const metrics = ctx.measureText(text);
  const fontAscent = metrics.fontBoundingBoxAscent ?? editor.fontPx * 0.8;
  const fontDescent = metrics.fontBoundingBoxDescent ?? editor.fontPx * 0.2;
  const baselineY = computeBaselineY(editor.top, editor.lineHeight, fontAscent, fontDescent);
  const shadow = textShadowParams(editor.fontPx);
  const rect = computeTextBoundingRect({
    x: editor.x,
    baselineY,
    metrics: {
      left: metrics.actualBoundingBoxLeft,
      right: metrics.actualBoundingBoxRight,
      ascent: metrics.actualBoundingBoxAscent,
      descent: metrics.actualBoundingBoxDescent,
    },
    shadow,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  });
  if (rect.width === 0 || rect.height === 0) {
    ctx.restore();
    return;
  }
  pushUndoStep(rect, ctx.getImageData(rect.x, rect.y, rect.width, rect.height));
  ctx.fillStyle = editor.color;
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = shadow.offsetY;
  ctx.fillText(text, editor.x, baselineY);
  ctx.restore();
}

/** 入力欄の位置・文字サイズ・幅をCanvasの表示倍率に合わせる。 */
function layoutInput(canvas: HTMLCanvasElement, editor: TextEditor): void {
  const scale = canvasToCssScale(canvas.clientWidth, canvas.width);
  const { input } = editor;
  input.style.left = `${canvas.offsetLeft + editor.x * scale}px`;
  input.style.top = `${canvas.offsetTop + editor.top * scale}px`;
  input.style.font = fontString(editor.fontPx * scale);
  input.style.lineHeight = `${editor.lineHeight * scale}px`;
  input.style.height = `${editor.lineHeight * scale}px`;
  const shadow = textShadowParams(editor.fontPx);
  input.style.textShadow = `0 ${shadow.offsetY * scale}px ${shadow.blur * scale}px ${shadow.color}`;

  let textWidth = 0;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.save();
    ctx.font = fontString(editor.fontPx);
    textWidth = ctx.measureText(input.value).width;
    ctx.restore();
  }
  const width = Math.max(
    editor.fontPx * MIN_INPUT_WIDTH_RATIO,
    textWidth + editor.fontPx * INPUT_TRAILING_RATIO,
  );
  input.style.width = `${width * scale}px`;
}

/**
 * テキストツールをCanvasへ結線する(DOM依存、E2Eで検証)。戻り値は解除関数。
 * テキストツール選択中のクリックで入力欄を開く。入力中にCanvasを押すと確定だけ行う
 * (続けて新しい入力欄は開かない。誤って空の入力欄が増えないように)。
 */
export function bindTextTool(canvas: HTMLCanvasElement): () => void {
  let editor: TextEditor | null = null;
  let hadEditorAtPointerDown = false;

  const finish = (reason: TextFinishReason): void => {
    const current = editor;
    if (!current) {
      return;
    }
    const result = finishTextSession(current.session, reason, current.input.value);
    current.session = result.session;
    if (result.action.type === "none") {
      return;
    }
    editor = null;
    finishActive = null;
    // 除去でblurが来ても`editor`は既に空のため二重処理しない。
    current.input.remove();
    if (
      result.action.type === "commit" &&
      isSameCanvasImage(getCanvasState().image, current.image)
    ) {
      burnText(canvas, current, result.action.text);
    }
  };

  const open = (point: Point): void => {
    const state = getCanvasState();
    // T31: 配置を始める前に編集中の図形を確定する。
    commitPendingShape();
    const settings = getToolSettings();
    const fontPx = computeFontSizePx(settings.fontSize, canvas.width, canvas.height);
    const lineHeight = textLineHeight(fontPx);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "text-tool-input";
    input.setAttribute("aria-label", "テキスト入力");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.color = settings.color;
    const next: TextEditor = {
      input,
      session: createTextSession(),
      x: point.x,
      top: computeTextLineTop(point.y, lineHeight, canvas.height),
      fontPx,
      lineHeight,
      color: settings.color,
      image: state.image,
      composing: false,
    };
    input.addEventListener("keydown", (event) => {
      const action = textKeyAction(event, next.composing);
      if (!action) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      finish(action === "commit" ? "enter" : "escape");
    });
    input.addEventListener("compositionstart", () => {
      next.composing = true;
    });
    input.addEventListener("compositionend", () => {
      next.composing = false;
    });
    input.addEventListener("input", () => layoutInput(canvas, next));
    input.addEventListener("blur", () => {
      // ウィンドウ自体がフォーカスを失った(他アプリへの切替等)ときのblurでは確定しない。
      // ウィンドウへ戻ると入力欄のフォーカスも戻り、入力を続けられる。
      if (!document.hasFocus()) {
        return;
      }
      finish("blur");
    });
    canvas.insertAdjacentElement("afterend", input);
    editor = next;
    finishActive = finish;
    layoutInput(canvas, next);
    input.focus();
  };

  const handlePointerDown = (): void => {
    hadEditorAtPointerDown = editor !== null;
    if (editor) {
      finish("external");
    }
  };

  const handleClick = (event: MouseEvent): void => {
    const state = getCanvasState();
    if (hadEditorAtPointerDown) {
      hadEditorAtPointerDown = false;
      return;
    }
    if (state.activeTool !== "text" || !state.image || editor) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    open(
      clientToCanvasPoint({
        clientX: event.clientX,
        clientY: event.clientY,
        rectLeft: rect.left,
        rectTop: rect.top,
        rectWidth: rect.width,
        rectHeight: rect.height,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      }),
    );
  };

  const handleResize = (): void => {
    if (editor) {
      layoutInput(canvas, editor);
    }
  };

  const unsubscribeCanvas = subscribeCanvasState((state) => {
    canvas.classList.toggle("capture-canvas--text-tool", state.activeTool === "text");
    if (!editor) {
      return;
    }
    if (!isSameCanvasImage(state.image, editor.image)) {
      finish("imageChanged");
    } else if (state.activeTool !== "text") {
      // ツール切替で確定する(shapeToolsの購読と同じくツール切替を確定トリガーにする)。
      finish("external");
    }
  });

  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("click", handleClick);
  window.addEventListener("resize", handleResize);

  return () => {
    canvas.removeEventListener("pointerdown", handlePointerDown);
    canvas.removeEventListener("click", handleClick);
    window.removeEventListener("resize", handleResize);
    unsubscribeCanvas();
    finish("external");
  };
}
