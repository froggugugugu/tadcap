//! 矢印・矩形・円ツールの共通ポインタ結線と選択ハンドルの表示(T31【新設 2026-09-24】、
//! T32【改訂 2026-09-24】オブジェクト化、ARCH §5.2 T32、PRD FR-006 オブジェクト共通基準)。
//!
//! 3ツールで描いた図形は焼き込まず、オブジェクト(`documentState.ts`)として保持する。表示canvasは
//! 常に「ベース+全オブジェクト」の合成(`documentSurface.ts`)で、選択中のオブジェクトの
//! ハンドル(四隅/始点・終点)と円の外接枠はCanvasに重ねたオーバーレイ用canvas
//! (`pointer-events: none`)にだけ描く。コピー・履歴保存は `#capture-canvas` のピクセルを
//! 読むため、ハンドルは写らない。
//!
//! 操作: pointerdownを`shapeEdit.ts::decidePointerDown()`で振り分け(選択中のハンドル・内側 →
//! 最前面のオブジェクト → 空白なら作成 or 選択解除)、ドラッグ中は下書き(`setDraft`)だけを
//! 差し替えて再描画し、pointerupで追加(`addShapeObject`)・変更(`commitShapeEdit`)を
//! 1コマンドとして確定する。ドラッグ中のEscはそのドラッグだけを取り消す。
//! 選択解除: 空白クリック・ツール切替・Canvas以外のpointerdown(取り消し・やり直しボタンは
//! `data-preserve-selection`で除外)。Enter/Escは`ui/selectionKeys.ts`。
//!
//! 判断ロジックは`shapeEdit.ts`/`objectModel.ts`/`documentState.ts`の純粋関数・状態として
//! ユニットテストし、本ファイル(DOM/Canvas依存)はE2Eで検証する(project-config.md §11)。
//!
//! MUST-1(ドラッグ中の非同期Canvas差し替え)は従来どおり`imageAtDragStart`+
//! `isSameCanvasImage()`で検知して中断する(差し替え側は`resetDocument()`で下書きも消す)。
//!
//! QE-T12: スタンプツールで空白を押すと(`decidePointerDown()`の`place`)押した位置に下書きを出し、
//! ドラッグで追従、離した位置で`addShapeObject()`(1手)。中心は半径の分だけ画像の内側に収める
//! (`placedStamp()`)。選択中のスタンプは円の外側に輪を描く(ハンドルは出さない、UI_quick-edits §2.5)。
//! 50個の上限で追加されなかったら`onObjectLimit`を呼ぶ(通知は`main.ts`が結ぶ。`canvas/`→`ui/`の
//! 依存を作らない、TASK_quick-edits【要確認】#5)。

import {
  getCanvasState,
  isSameCanvasImage,
  setDrawing,
  subscribeCanvasState,
  type CanvasImage,
  type ToolId,
} from "../canvasState";
import { clientToCanvasPoint, type Point } from "../coords";
import {
  addShapeObject,
  commitShapeEdit,
  getDocumentState,
  selectObject,
  setDraft,
  subscribeDocument,
} from "../documentState";
import { findObject, pickObjectAt, type AnnotationObject } from "../objectModel";
import {
  applyEditDrag,
  cursorForHit,
  decidePointerDown,
  getShapeHandles,
  hitTestShape,
  isShapeTool,
  moveShape,
  type EditableShape,
  type EditSession,
} from "../shapeEdit";
import { getToolSettings, type FontSize } from "../toolSettings";
import { stampShapeDiameter, type StampGlyph, type StampShape } from "./stampShape";
import { textShapeBox } from "./textLayout";
import { isTextEditorOpen } from "./textTool";

/** ハンドルの当たり判定半径(画面上のCSSピクセル。Canvasピクセルへは表示倍率で換算する)。 */
const HANDLE_HIT_RADIUS_CSS = 10;
/** ハンドルの描画半径(CSSピクセル)。 */
const HANDLE_DRAW_RADIUS_CSS = 5;
/** オーバーレイの色(ハンドル塗り・枠、選択枠)。画像の上で見えるよう白地+濃色の縁取り。 */
const HANDLE_FILL = "#ffffff";
const HANDLE_STROKE = "rgba(0, 0, 0, 0.55)";
const SELECTION_STROKE = "rgba(0, 0, 0, 0.45)";
/** テキストの選択枠を行ボックスから離す余白(CSSピクセル、T33)。 */
const TEXT_SELECTION_PADDING_CSS = 3;
/** スタンプの選択の輪を円から離す距離(CSSピクセル、UI_quick-edits §2.5)。 */
const STAMP_SELECTION_GAP_CSS = 4;

/** これから置くスタンプの見た目(`toolSettings`の種類・色・文字サイズ)。 */
export interface StampStyle {
  glyph: StampGlyph;
  color: string;
  fontSize: FontSize;
}

/**
 * 押した(離した)位置に置くスタンプ(QE-T12、ARCH_quick-edits §7.1 S)。中心は半径の分だけ
 * 画像の内側に収める(移動と同じ`moveShape()`の収め方)。
 */
export function placedStamp(
  point: Point,
  style: StampStyle,
  canvasWidth: number,
  canvasHeight: number,
): StampShape {
  const shape: StampShape = { kind: "stamp", center: { x: point.x, y: point.y }, ...style };
  return moveShape(shape, { x: 0, y: 0 }, canvasWidth, canvasHeight) as StampShape;
}

/**
 * 注釈を追加し、50個の上限で追加されなかった(`null`、ARCH_quick-edits §15 #3)ときは
 * `onObjectLimit`を呼ぶ。`add`はテストで偽物に差し替えるための口(既定は`addShapeObject`)。
 */
export function addShapeOrNotifyLimit(
  shape: EditableShape,
  onObjectLimit: (() => void) | undefined,
  add: (shape: EditableShape) => AnnotationObject | null = addShapeObject,
): AnnotationObject | null {
  const object = add(shape);
  if (!object) {
    onObjectLimit?.();
  }
  return object;
}

/** 選択中のオブジェクトの今の形(移動・リサイズ中は下書き)。選択が無ければ`null`。 */
function selectedShape(): EditableShape | null {
  const { objects, selectedId, draft } = getDocumentState();
  if (draft && draft.id !== null && draft.id === selectedId) {
    return draft.shape;
  }
  return findObject(objects, selectedId)?.shape ?? null;
}

/** Canvasに重ねるハンドル描画用のオーバーレイを作る(Canvasの兄弟要素)。 */
function createOverlay(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const overlay = document.createElement("canvas");
  overlay.className = "shape-overlay";
  overlay.setAttribute("aria-hidden", "true");
  canvas.insertAdjacentElement("afterend", overlay);
  return overlay;
}

/** オーバーレイをCanvasの表示位置・サイズに合わせ、選択中のオブジェクトのハンドルを描く。 */
function renderOverlay(
  canvas: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  shape: EditableShape | null,
): void {
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  overlay.style.left = `${canvas.offsetLeft}px`;
  overlay.style.top = `${canvas.offsetTop}px`;
  overlay.style.width = `${cssWidth}px`;
  overlay.style.height = `${cssHeight}px`;
  const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
  if (overlay.width !== pixelWidth || overlay.height !== pixelHeight) {
    overlay.width = pixelWidth;
    overlay.height = pixelHeight;
  }
  overlay.hidden = shape === null;
  const ctx = overlay.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!shape || canvas.width === 0 || canvas.height === 0) {
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const scaleX = cssWidth / canvas.width;
  const scaleY = cssHeight / canvas.height;
  const toCss = (p: Point): Point => ({ x: p.x * scaleX, y: p.y * scaleY });

  // 円は外接矩形を点線で示す(四隅のハンドルが楕円から離れているため、どの図形のハンドルか
  // 分かるように)。矩形は枠自体が外接矩形と重なり点線が線を汚すため描かない。
  if (shape.kind === "ellipse") {
    const topLeft = toCss({ x: shape.rect.x, y: shape.rect.y });
    ctx.save();
    ctx.strokeStyle = SELECTION_STROKE;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(
      topLeft.x + 0.5,
      topLeft.y + 0.5,
      shape.rect.width * scaleX,
      shape.rect.height * scaleY,
    );
    ctx.restore();
  }

  // T33: テキストはハンドルを持たないため、行ボックスを枠で示す(白の実線+濃色の点線にして
  // 明るい背景・暗い背景のどちらでも見えるようにする)。
  if (shape.kind === "text") {
    const box = textShapeBox(shape, canvas.width, canvas.height);
    const x = box.x * scaleX - TEXT_SELECTION_PADDING_CSS + 0.5;
    const y = box.y * scaleY - TEXT_SELECTION_PADDING_CSS + 0.5;
    const w = box.width * scaleX + TEXT_SELECTION_PADDING_CSS * 2;
    const h = box.height * scaleY + TEXT_SELECTION_PADDING_CSS * 2;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = HANDLE_FILL;
    ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = HANDLE_STROKE;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // QE-T12: スタンプはハンドルを持たないため、円の外側に輪を描く(テキストの選択の枠と同じ部品:
  // 白の実線 + 濃色の破線)。縦横の表示倍率が違っても円に沿うよう楕円で描く。
  if (shape.kind === "stamp") {
    const radius = stampShapeDiameter(shape, canvas.width, canvas.height) / 2;
    const center = toCss(shape.center);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(
      center.x,
      center.y,
      radius * scaleX + STAMP_SELECTION_GAP_CSS,
      radius * scaleY + STAMP_SELECTION_GAP_CSS,
      0,
      0,
      Math.PI * 2,
    );
    ctx.strokeStyle = HANDLE_FILL;
    ctx.stroke();
    ctx.strokeStyle = HANDLE_STROKE;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  }

  for (const handle of getShapeHandles(shape)) {
    const p = toCss(handle.point);
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_DRAW_RADIUS_CSS, 0, Math.PI * 2);
    ctx.fillStyle = HANDLE_FILL;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = HANDLE_STROKE;
    ctx.stroke();
  }
}

export interface ShapeToolsOptions {
  /** 50個の上限で注釈を追加できなかったときに呼ぶ(`main.ts`がトーストを結ぶ、QE-T12)。 */
  onObjectLimit?: () => void;
}

/**
 * 矢印・矩形・円・スタンプツールとオブジェクトの選択・編集をCanvasへ結線する(DOM依存、E2Eで検証)。
 * 戻り値は購読解除関数。
 */
export function bindShapeTools(canvas: HTMLCanvasElement, options: ShapeToolsOptions = {}): () => void {
  const overlay = createOverlay(canvas);
  let session: EditSession | null = null;
  /** スタンプを置くドラッグ中の見た目(押した時点の設定)。置いていなければ`null`。 */
  let placing: StampStyle | null = null;
  /** 移動・リサイズ中のオブジェクトid(作成中は`null`)。 */
  let editId: number | null = null;
  let activePointerId: number | null = null;
  let imageAtDragStart: CanvasImage | null = null;
  let lastActiveTool: ToolId | null = getCanvasState().activeTool;

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

  /** 画面上一定サイズの当たり判定半径をCanvasピクセルへ換算する。 */
  const hitTolerance = (): number => {
    const cssWidth = canvas.getBoundingClientRect().width;
    return cssWidth > 0 ? (HANDLE_HIT_RADIUS_CSS * canvas.width) / cssWidth : HANDLE_HIT_RADIUS_CSS;
  };

  const redrawOverlay = (): void => {
    renderOverlay(canvas, overlay, selectedShape());
  };

  const resetDrag = (): void => {
    session = null;
    placing = null;
    editId = null;
    imageAtDragStart = null;
    if (getCanvasState().isDrawing) {
      setDrawing(false);
    }
    if (activePointerId !== null && canvas.hasPointerCapture(activePointerId)) {
      canvas.releasePointerCapture(activePointerId);
    }
    activePointerId = null;
  };

  /** ホバー中のカーソル(選択中のハンドル・内側、または掴めるオブジェクトの線の上)。 */
  const updateHoverCursor = (point: Point): void => {
    const tool = getCanvasState().activeTool;
    if (tool === "stamp") {
      // QE-T12: スタンプツールはスタンプだけを掴む。上は`move`、空白は置ける印の`crosshair`。
      const stamps = getDocumentState().objects.filter((object) => object.shape.kind === "stamp");
      const over = pickObjectAt(stamps, point, hitTolerance(), canvas.width, canvas.height);
      canvas.style.cursor = over ? "move" : "crosshair";
      return;
    }
    if (tool !== null && !isShapeTool(tool)) {
      canvas.style.cursor = "";
      return;
    }
    const { objects } = getDocumentState();
    const shape = selectedShape();
    const tolerance = hitTolerance();
    const hit = shape ? hitTestShape(shape, point, tolerance, canvas.width, canvas.height) : null;
    const picked = hit ? null : pickObjectAt(objects, point, tolerance, canvas.width, canvas.height);
    canvas.style.cursor = cursorForHit(hit) ?? (picked ? "move" : "");
  };

  const handlePointerDown = (event: PointerEvent): void => {
    const canvasState = getCanvasState();
    // T33: テキストの入力中(新規・再編集)にCanvasを押したら、確定(`textTool.ts`)だけにする。
    if (!canvasState.image || isTextEditorOpen()) {
      return;
    }
    const { objects, selectedId } = getDocumentState();
    const decision = decidePointerDown({
      objects,
      selectedId,
      activeTool: canvasState.activeTool,
      point: toCanvasPoint(event),
      tolerance: hitTolerance(),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      color: getToolSettings().color,
    });
    switch (decision.type) {
      case "ignore":
        return;
      case "deselect":
        selectObject(null);
        return;
      case "place": {
        const { stampKind, color, fontSize } = getToolSettings();
        selectObject(null);
        placing = { glyph: stampKind, color, fontSize };
        setDraft({ id: null, shape: placedStamp(decision.point, placing, canvas.width, canvas.height) });
        imageAtDragStart = canvasState.image;
        activePointerId = event.pointerId;
        setDrawing(true);
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      case "create":
        selectObject(null);
        editId = null;
        break;
      case "edit":
        selectObject(decision.id);
        editId = decision.id;
        break;
    }
    session = decision.session;
    imageAtDragStart = canvasState.image;
    activePointerId = event.pointerId;
    setDrawing(true);
    canvas.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (placing) {
      if (!isSameCanvasImage(getCanvasState().image, imageAtDragStart)) {
        resetDrag();
        return;
      }
      setDraft({ id: null, shape: placedStamp(toCanvasPoint(event), placing, canvas.width, canvas.height) });
      return;
    }
    if (!session) {
      updateHoverCursor(toCanvasPoint(event));
      return;
    }
    if (!isSameCanvasImage(getCanvasState().image, imageAtDragStart)) {
      // MUST-1: ドラッグ中にCanvasが非同期に差し替えられた。古い下書きを描かず中断する。
      resetDrag();
      return;
    }
    const shape = applyEditDrag(session, toCanvasPoint(event), event.shiftKey, canvas.width, canvas.height);
    setDraft(shape ? { id: editId, shape } : null);
  };

  const finishDrag = (event: PointerEvent): void => {
    if (placing) {
      if (isSameCanvasImage(getCanvasState().image, imageAtDragStart)) {
        // 離した位置に置く(1手)。上限で追加されなかったら下書きを消して通知する。
        const shape = placedStamp(toCanvasPoint(event), placing, canvas.width, canvas.height);
        if (!addShapeOrNotifyLimit(shape, options.onObjectLimit)) {
          setDraft(null);
        }
      }
      resetDrag();
      return;
    }
    if (!session) {
      return;
    }
    if (isSameCanvasImage(getCanvasState().image, imageAtDragStart)) {
      const shape = applyEditDrag(session, toCanvasPoint(event), event.shiftKey, canvas.width, canvas.height);
      if (session.mode === "create") {
        // 上限で追加されなかった(`null`、ARCH_quick-edits §15 #3)ときも下書きは消し、通知する。
        if (!shape) {
          setDraft(null);
        } else if (!addShapeOrNotifyLimit(shape, options.onObjectLimit)) {
          setDraft(null);
        }
      } else if (editId !== null && shape) {
        commitShapeEdit(editId, shape);
      }
    }
    // MUST-1: 画像が差し替えられていた場合は確定せず、状態のリセットのみ行う。
    resetDrag();
  };

  /** ドラッグ中のEscはそのドラッグだけを取り消す(作成中は何も残さず、編集中は掴む前に戻す)。 */
  const handleKeydown = (event: KeyboardEvent): void => {
    if ((!session && !placing) || event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    resetDrag();
    setDraft(null);
  };

  /** Canvas以外(画像の外・ツールバー・サイドバー等)を押したら選択を外す。 */
  const handleDocumentPointerDown = (event: PointerEvent): void => {
    if (event.target === canvas) {
      return;
    }
    // 取り消し・やり直しボタン(`data-preserve-selection`)は選択を保つ(移動の取り消しなどで
    // 同じオブジェクトを続けて調整できるように)。
    if (event.target instanceof Element && event.target.closest("[data-preserve-selection]")) {
      return;
    }
    selectObject(null);
  };

  const unsubscribeDocument = subscribeDocument((state) => {
    if (state.selectedId === null && !session && !placing && getCanvasState().activeTool !== "stamp") {
      canvas.style.cursor = "";
    }
    redrawOverlay();
  });

  const unsubscribeCanvas = subscribeCanvasState((state) => {
    if (state.activeTool !== lastActiveTool) {
      lastActiveTool = state.activeTool;
      // ツール切替で選択を外す(T31の「ツール切替で確定」に相当)。
      selectObject(null);
      // QE-T12: スタンプツールの空白は置ける印(`crosshair`)。ほかのツールへ移ったら既定に戻す。
      canvas.style.cursor = state.activeTool === "stamp" ? "crosshair" : "";
    }
    redrawOverlay();
  });

  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(redrawOverlay);
  resizeObserver?.observe(canvas);
  window.addEventListener("resize", redrawOverlay);
  window.addEventListener("keydown", handleKeydown);

  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", finishDrag);
  canvas.addEventListener("pointercancel", finishDrag);
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  redrawOverlay();

  return () => {
    canvas.removeEventListener("pointerdown", handlePointerDown);
    canvas.removeEventListener("pointermove", handlePointerMove);
    canvas.removeEventListener("pointerup", finishDrag);
    canvas.removeEventListener("pointercancel", finishDrag);
    document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
    window.removeEventListener("resize", redrawOverlay);
    window.removeEventListener("keydown", handleKeydown);
    resizeObserver?.disconnect();
    unsubscribeDocument();
    unsubscribeCanvas();
    overlay.remove();
  };
}
