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
import { findObject, pickObjectAt } from "../objectModel";
import {
  applyEditDrag,
  cursorForHit,
  decidePointerDown,
  getShapeHandles,
  hitTestShape,
  isShapeTool,
  type EditableShape,
  type EditSession,
} from "../shapeEdit";
import { getToolSettings } from "../toolSettings";

/** ハンドルの当たり判定半径(画面上のCSSピクセル。Canvasピクセルへは表示倍率で換算する)。 */
const HANDLE_HIT_RADIUS_CSS = 10;
/** ハンドルの描画半径(CSSピクセル)。 */
const HANDLE_DRAW_RADIUS_CSS = 5;
/** オーバーレイの色(ハンドル塗り・枠、選択枠)。画像の上で見えるよう白地+濃色の縁取り。 */
const HANDLE_FILL = "#ffffff";
const HANDLE_STROKE = "rgba(0, 0, 0, 0.55)";
const SELECTION_STROKE = "rgba(0, 0, 0, 0.45)";

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

/**
 * 矢印・矩形・円ツールとオブジェクトの選択・編集をCanvasへ結線する(DOM依存、E2Eで検証)。
 * 戻り値は購読解除関数。
 */
export function bindShapeTools(canvas: HTMLCanvasElement): () => void {
  const overlay = createOverlay(canvas);
  let session: EditSession | null = null;
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
    if (!canvasState.image) {
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
    if (!session) {
      return;
    }
    if (isSameCanvasImage(getCanvasState().image, imageAtDragStart)) {
      const shape = applyEditDrag(session, toCanvasPoint(event), event.shiftKey, canvas.width, canvas.height);
      if (session.mode === "create") {
        if (shape) {
          addShapeObject(shape);
        } else {
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
    if (!session || event.key !== "Escape") {
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
    if (state.selectedId === null && !session) {
      canvas.style.cursor = "";
    }
    redrawOverlay();
  });

  const unsubscribeCanvas = subscribeCanvasState((state) => {
    if (state.activeTool !== lastActiveTool) {
      lastActiveTool = state.activeTool;
      // ツール切替で選択を外す(T31の「ツール切替で確定」に相当)。
      selectObject(null);
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
