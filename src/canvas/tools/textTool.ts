//! テキストツール(T27、PRD FR-012・§10決定#10/#12、ARCH §5.2)。
//!
//! Canvasのクリック位置に単一行の入力欄(Canvasの兄弟要素として絶対配置した`<input>`)を重ね、
//! `Enter`(IME変換中を除く)またはフォーカスアウト(blur)で確定し、`Esc`で取り消す。
//! 空文字(空白のみ)は何も残さない。
//!
//! T33【改訂 2026-09-24】: 確定したテキストは焼き込まず、矢印・矩形・円と同じオブジェクト
//! (`shapeEdit.ts::TextShape`、`documentState.ts::addShapeObject()`、上限50の対象)として重ね順に入る。
//! 選択・移動は`shapeTools.ts`(テキストツール中はテキストだけを掴む)。**ダブルクリックで再編集**:
//! 入力欄を元の位置・文字サイズ・色で開き(オブジェクトは`setHiddenObject()`で一時的に描かない)、
//! Enter/blurで`update`、Escで編集前のまま、空にして確定したら`remove`(`textLayout.ts::decideTextEdit()`)。
//! 【判断】再編集のダブルクリックはテキスト・図形ツール・ツール未選択のときに受け付け、モザイク中は
//! 受け付けない(モザイクはオブジェクトを選ばないツールのため、誤操作で入力欄が開かないように)。
//! 寸法・描画・判定の純粋関数は`textLayout.ts`(本ファイルから再export)。
//!
//! - 入力欄は`<input>`のため、`shortcutGuards.ts::isEditableTarget()`によりCmd+C/Cmd+Z等の
//!   アプリショートカットと`selectionKeys.ts`のEnter/Escを奪わない(T22・T31・T32)。
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
import { clientToCanvasPoint, type Point } from "../coords";
import {
  addShapeObject,
  commitShapeEdit,
  getDocumentState,
  removeShapeObject,
  selectObject,
  setHiddenObject,
  setTextMeasurer,
} from "../documentState";
import { pickObjectAt, type AnnotationObject } from "../objectModel";
import type { TextMetricsSnapshot, TextShape } from "../shapeEdit";
import { getToolSettings, type FontSize } from "../toolSettings";
import {
  canvasToCssScale,
  computeFontSizePx,
  computeTextLineTop,
  createTextSession,
  decideTextEdit,
  finishTextSession,
  fontString,
  textKeyAction,
  textLineHeight,
  textShadowParams,
  type TextFinishReason,
  type TextSession,
} from "./textLayout";

export * from "./textLayout";

/** ダブルクリックの当たり判定の許容幅(画面上のCSSピクセル、`shapeTools.ts`のハンドルと同じ)。 */
const HIT_RADIUS_CSS = 10;
/** 入力欄の最小幅(フォント実寸に対する比率。空の入力欄でもクリック位置が分かるように)。 */
const MIN_INPUT_WIDTH_RATIO = 1;
/** 入力欄の末尾の余白(キャレットが欄の端で欠けないように、フォント実寸に対する比率)。 */
const INPUT_TRAILING_RATIO = 0.5;

// --- DOM/Canvas結線(E2Eで検証) ---

interface TextEditor {
  input: HTMLInputElement;
  session: TextSession;
  /** 行の左端・上端(Canvasピクセル)。 */
  x: number;
  top: number;
  fontSize: FontSize;
  fontPx: number;
  lineHeight: number;
  color: string;
  image: CanvasImage | null;
  composing: boolean;
  /** 再編集中のオブジェクト(新規入力は`null`)。 */
  target: { id: number; original: TextShape } | null;
}

let finishActive: ((reason: TextFinishReason) => void) | null = null;

/**
 * 入力中のテキストがあれば確定する(新規キャプチャ・履歴切替・コピーの直前に
 * `main.ts`が呼ぶ)。入力中でなければ`false`。
 */
export function commitPendingText(): boolean {
  if (!finishActive) {
    return false;
  }
  finishActive("external");
  return true;
}

/** 入力欄が開いているか(`shapeTools.ts`が、入力中のCanvasクリックを確定だけにするために使う)。 */
export function isTextEditorOpen(): boolean {
  return finishActive !== null;
}

/** 表示canvasで文字の寸法を測る(フォントは描画と同じ)。 */
function measureText(canvas: HTMLCanvasElement, text: string, fontPx: number): TextMetricsSnapshot {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { width: 0, left: 0, right: 0, ascent: 0, descent: 0, fontAscent: fontPx * 0.8, fontDescent: fontPx * 0.2 };
  }
  ctx.save();
  ctx.font = fontString(fontPx);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText(text);
  ctx.restore();
  return {
    width: m.width,
    left: m.actualBoundingBoxLeft,
    right: m.actualBoundingBoxRight,
    ascent: m.actualBoundingBoxAscent,
    descent: m.actualBoundingBoxDescent,
    fontAscent: m.fontBoundingBoxAscent ?? fontPx * 0.8,
    fontDescent: m.fontBoundingBoxDescent ?? fontPx * 0.2,
  };
}

function buildTextShape(canvas: HTMLCanvasElement, editor: TextEditor, text: string): TextShape {
  return {
    kind: "text",
    text,
    x: editor.x,
    top: editor.top,
    fontSize: editor.fontSize,
    color: editor.color,
    metrics: measureText(canvas, text, editor.fontPx),
  };
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

  const textWidth = measureText(canvas, input.value, editor.fontPx).width;
  const width = Math.max(editor.fontPx * MIN_INPUT_WIDTH_RATIO, textWidth + editor.fontPx * INPUT_TRAILING_RATIO);
  input.style.width = `${width * scale}px`;
}

/**
 * テキストツールをCanvasへ結線する(DOM依存、E2Eで検証)。戻り値は解除関数。
 * テキストツール選択中の空白クリックで入力欄を開く。入力中にCanvasを押すと確定だけ行う
 * (続けて新しい入力欄は開かない。誤って空の入力欄が増えないように)。テキストオブジェクトの
 * ダブルクリックで再編集する(T33)。
 */
export function bindTextTool(canvas: HTMLCanvasElement): () => void {
  let editor: TextEditor | null = null;
  let hadEditorAtPointerDown = false;
  // T34: 選択中のテキストの文字サイズ変更で寸法を測り直すために登録する。
  setTextMeasurer((text, fontPx) => measureText(canvas, text, fontPx));

  const toCanvasPoint = (event: MouseEvent): Point => {
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
    const { target } = current;
    if (target) {
      setHiddenObject(null);
    }
    if (!isSameCanvasImage(getCanvasState().image, current.image)) {
      return;
    }
    const outcome = decideTextEdit(reason, current.input.value, target ? target.original.text : null);
    switch (outcome.type) {
      case "add":
        addShapeObject(buildTextShape(canvas, current, outcome.text));
        break;
      case "update":
        if (target) {
          commitShapeEdit(target.id, { ...target.original, text: outcome.text, metrics: measureText(canvas, outcome.text, current.fontPx) });
          selectObject(target.id);
        }
        break;
      case "remove":
        if (target) {
          removeShapeObject(target.id);
        }
        break;
      case "none":
        if (target) {
          selectObject(target.id);
        }
        break;
    }
  };

  const openEditor = (next: Omit<TextEditor, "input" | "session" | "composing">, value: string): void => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "text-tool-input";
    input.setAttribute("aria-label", "テキスト入力");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.color = next.color;
    input.value = value;
    const created: TextEditor = { ...next, input, session: createTextSession(), composing: false };
    input.addEventListener("keydown", (event) => {
      const action = textKeyAction(event, created.composing);
      if (!action) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      finish(action === "commit" ? "enter" : "escape");
    });
    input.addEventListener("compositionstart", () => {
      created.composing = true;
    });
    input.addEventListener("compositionend", () => {
      created.composing = false;
    });
    input.addEventListener("input", () => layoutInput(canvas, created));
    input.addEventListener("blur", () => {
      // ウィンドウ自体がフォーカスを失った(他アプリへの切替等)ときのblurでは確定しない。
      // ウィンドウへ戻ると入力欄のフォーカスも戻り、入力を続けられる。
      if (!document.hasFocus()) {
        return;
      }
      finish("blur");
    });
    canvas.insertAdjacentElement("afterend", input);
    editor = created;
    finishActive = finish;
    layoutInput(canvas, created);
    input.focus();
    input.setSelectionRange(value.length, value.length);
  };

  /** 新しい入力欄をクリック位置に開く(文字サイズ・色は今のツール設定)。 */
  const openNew = (point: Point): void => {
    const settings = getToolSettings();
    const fontPx = computeFontSizePx(settings.fontSize, canvas.width, canvas.height);
    const lineHeight = textLineHeight(fontPx);
    openEditor(
      {
        x: point.x,
        top: computeTextLineTop(point.y, lineHeight, canvas.height),
        fontSize: settings.fontSize,
        fontPx,
        lineHeight,
        color: settings.color,
        image: getCanvasState().image,
        target: null,
      },
      "",
    );
  };

  /** テキストオブジェクトを元の位置・文字サイズ・色で再編集する(T33)。 */
  const openExisting = (object: AnnotationObject & { shape: TextShape }): void => {
    const { shape } = object;
    const fontPx = computeFontSizePx(shape.fontSize, canvas.width, canvas.height);
    selectObject(null);
    setHiddenObject(object.id);
    openEditor(
      {
        x: shape.x,
        top: shape.top,
        fontSize: shape.fontSize,
        fontPx,
        lineHeight: textLineHeight(fontPx),
        color: shape.color,
        image: getCanvasState().image,
        target: { id: object.id, original: shape },
      },
      shape.text,
    );
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
    // T33: 既存のテキストをクリックした(`shapeTools.ts`が選択した)ときは入力欄を開かない。
    if (getDocumentState().selectedId !== null) {
      return;
    }
    openNew(toCanvasPoint(event));
  };

  const handleDoubleClick = (event: MouseEvent): void => {
    const state = getCanvasState();
    if (!state.image || editor || state.activeTool === "mosaic") {
      return;
    }
    const cssWidth = canvas.getBoundingClientRect().width;
    const tolerance = cssWidth > 0 ? (HIT_RADIUS_CSS * canvas.width) / cssWidth : HIT_RADIUS_CSS;
    const texts = getDocumentState().objects.filter((o) => o.shape.kind === "text");
    const target = pickObjectAt(texts, toCanvasPoint(event), tolerance, canvas.width, canvas.height);
    if (target && target.shape.kind === "text") {
      openExisting({ id: target.id, shape: target.shape });
    }
  };

  const handleResize = (): void => {
    if (editor) {
      layoutInput(canvas, editor);
    }
  };

  let lastTool = getCanvasState().activeTool;
  const unsubscribeCanvas = subscribeCanvasState((state) => {
    canvas.classList.toggle("capture-canvas--text-tool", state.activeTool === "text");
    const toolChanged = state.activeTool !== lastTool;
    lastTool = state.activeTool;
    if (!editor) {
      return;
    }
    if (!isSameCanvasImage(state.image, editor.image)) {
      finish("imageChanged");
    } else if (toolChanged) {
      // ツール切替で確定する(shapeToolsの購読と同じくツール切替を確定トリガーにする)。
      finish("external");
    }
  });

  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("click", handleClick);
  canvas.addEventListener("dblclick", handleDoubleClick);
  window.addEventListener("resize", handleResize);

  return () => {
    canvas.removeEventListener("pointerdown", handlePointerDown);
    canvas.removeEventListener("click", handleClick);
    canvas.removeEventListener("dblclick", handleDoubleClick);
    window.removeEventListener("resize", handleResize);
    unsubscribeCanvas();
    setTextMeasurer(null);
    finish("external");
  };
}
