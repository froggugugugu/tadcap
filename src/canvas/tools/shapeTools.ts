//! 矢印・矩形・円ツールの共通ポインタ結線と編集中図形の表示(T31【新設 2026-09-24】、
//! ARCH §5.4、PRD FR-006/007/011改訂)。
//!
//! 3ツールは pointerup で焼き込まず、直前に描いた1つを「編集中の図形」(`pendingShape.ts`)として
//! 保持する。Canvasには常に「描く前の画像(base)+図形」を描き、ハンドル(四隅/始点・終点)は
//! Canvasに重ねたオーバーレイ用canvas(`pointer-events: none`)にだけ描く。コピー・履歴保存は
//! `#capture-canvas` のピクセルを読むため、ハンドルは写らない。
//!
//! 判断ロジック(当たり判定・リサイズ・移動・pointerdownの分岐)は`shapeEdit.ts`の純粋関数で
//! ユニットテストし、本ファイル(DOM/Canvas依存)はE2Eで検証する(project-config.md §11)。
//!
//! 確定トリガーのうち本ファイルが担うもの: 次の図形の描き始め・編集中図形の外(空白)のクリック・
//! Canvas以外(画像の外・ツールバー・履歴サイドバー等)のpointerdown・ツール切替。
//! Enter/Escは`ui/pendingShapeKeys.ts`、コピー・新規キャプチャ・履歴切替は`main.ts`、
//! モザイク開始は`mosaicTool.ts`が`commitPendingShape()`を呼ぶ。
//!
//! MUST-1(ドラッグ中の非同期Canvas差し替え)は旧`bind*Tool()`と同じく`imageAtDragStart`+
//! `isSameCanvasImage()`で検知して中断する。

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
  beginPendingShape,
  commitPendingShape,
  dropPendingShapeIfImageChanged,
  getPendingShape,
  setPendingShapeRestorer,
  subscribePendingShape,
  updatePendingShape,
} from "../pendingShape";
import {
  applyEditDrag,
  cursorForHit,
  decidePointerDown,
  getShapeHandles,
  hitTestShape,
  type EditableShape,
  type EditSession,
} from "../shapeEdit";
import { getToolSettings } from "../toolSettings";
import type { ImageDataLike } from "../undoStack";
import { computeTaperArrowPolygon, drawTaperArrowPolygon } from "./arrowTool";
import { computeEllipseCenterAndRadii, drawEllipseOutline, ellipseLineWidth } from "./ellipseTool";
import { drawRectangleOutline, rectangleLineWidth } from "./rectangleTool";

/** ハンドルの当たり判定半径(画面上のCSSピクセル。Canvasピクセルへは表示倍率で換算する)。 */
const HANDLE_HIT_RADIUS_CSS = 10;
/** ハンドルの描画半径(CSSピクセル)。 */
const HANDLE_DRAW_RADIUS_CSS = 5;
/** オーバーレイの色(ハンドル塗り・枠、選択枠)。画像の上で見えるよう白地+濃色の縁取り。 */
const HANDLE_FILL = "#ffffff";
const HANDLE_STROKE = "rgba(0, 0, 0, 0.55)";
const SELECTION_STROKE = "rgba(0, 0, 0, 0.45)";

/** 図形1つをCanvasへ描く(ツール別の既存描画関数へ振り分ける)。 */
export function drawEditableShape(
  ctx: CanvasRenderingContext2D,
  shape: EditableShape,
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (shape.kind === "arrow") {
    const polygon = computeTaperArrowPolygon(shape.start, shape.end, canvasWidth, canvasHeight);
    if (polygon) {
      drawTaperArrowPolygon(ctx, polygon, shape.color);
    }
    return;
  }
  if (shape.kind === "rectangle") {
    drawRectangleOutline(ctx, shape.rect, rectangleLineWidth(canvasWidth, canvasHeight), shape.color);
    return;
  }
  drawEllipseOutline(
    ctx,
    {
      rect: shape.rect,
      ...computeEllipseCenterAndRadii(shape.rect),
      lineWidth: ellipseLineWidth(canvasWidth, canvasHeight),
    },
    shape.color,
  );
}

/** base(描く前の画像)を書き戻し、その上に図形を描く。 */
function renderShapeOnBase(
  canvas: HTMLCanvasElement,
  base: ImageDataLike,
  shape: EditableShape | null,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.putImageData(base as ImageData, 0, 0);
  if (shape) {
    drawEditableShape(ctx, shape, canvas.width, canvas.height);
  }
}

/** Canvasに重ねるハンドル描画用のオーバーレイを作る(Canvasの兄弟要素)。 */
function createOverlay(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const overlay = document.createElement("canvas");
  overlay.className = "shape-overlay";
  overlay.setAttribute("aria-hidden", "true");
  canvas.insertAdjacentElement("afterend", overlay);
  return overlay;
}

/** オーバーレイをCanvasの表示位置・サイズに合わせ、編集中の図形のハンドルを描く。 */
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
 * 矢印・矩形・円ツールをCanvasへ結線する(Container相当、DOM依存、E2Eで検証)。
 * 戻り値は購読解除関数。
 */
export function bindShapeTools(canvas: HTMLCanvasElement): () => void {
  const overlay = createOverlay(canvas);
  let session: EditSession | null = null;
  let base: ImageDataLike | null = null;
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
    renderOverlay(canvas, overlay, getPendingShape()?.shape ?? null);
  };

  const resetDrag = (pointerId?: number): void => {
    session = null;
    base = null;
    imageAtDragStart = null;
    if (getCanvasState().isDrawing) {
      setDrawing(false);
    }
    if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
  };

  const handlePointerDown = (event: PointerEvent): void => {
    const canvasState = getCanvasState();
    if (!canvasState.image) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    dropPendingShapeIfImageChanged(canvasState.image);
    const pending = getPendingShape();
    const point = toCanvasPoint(event);
    const decision = decidePointerDown({
      pending: pending?.shape ?? null,
      activeTool: canvasState.activeTool,
      point,
      tolerance: hitTolerance(),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      color: getToolSettings().color,
    });
    switch (decision.type) {
      case "ignore":
        return;
      case "commit":
        commitPendingShape();
        return;
      case "create":
        if (decision.commitFirst) {
          commitPendingShape();
        }
        // 確定はUndoへ積むだけでCanvasのピクセルは変わらないため、確定後の今の表示が新しいbase。
        base = ctx.getImageData(0, 0, canvas.width, canvas.height);
        break;
      case "edit":
        base = pending ? pending.base : null;
        break;
    }
    if (!base) {
      return;
    }
    session = decision.session;
    imageAtDragStart = canvasState.image;
    setDrawing(true);
    canvas.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (!session || !base) {
      const pending = getPendingShape();
      const hit = pending
        ? hitTestShape(pending.shape, toCanvasPoint(event), hitTolerance(), canvas.width, canvas.height)
        : null;
      canvas.style.cursor = cursorForHit(hit) ?? "";
      return;
    }
    if (!isSameCanvasImage(getCanvasState().image, imageAtDragStart)) {
      // MUST-1: ドラッグ中にCanvasが非同期に差し替えられた。古いbaseを描かず中断する。
      resetDrag(event.pointerId);
      return;
    }
    const shape = applyEditDrag(session, toCanvasPoint(event), event.shiftKey, canvas.width, canvas.height);
    renderShapeOnBase(canvas, base, shape);
    if (session.mode !== "create" && shape) {
      updatePendingShape(shape);
    }
  };

  const finishDrag = (event: PointerEvent): void => {
    if (!session || !base) {
      return;
    }
    const image = getCanvasState().image;
    if (isSameCanvasImage(image, imageAtDragStart)) {
      const shape = applyEditDrag(session, toCanvasPoint(event), event.shiftKey, canvas.width, canvas.height);
      renderShapeOnBase(canvas, base, shape);
      if (session.mode === "create") {
        if (shape) {
          beginPendingShape({ shape, base, image });
        }
      } else if (shape) {
        updatePendingShape(shape);
      }
    }
    // MUST-1: 画像が差し替えられていた場合は描かず、状態のリセットのみ行う。
    resetDrag(event.pointerId);
  };

  /** Canvas以外(画像の外・ツールバー・サイドバー等)を押したら編集中の図形を確定する。 */
  const handleDocumentPointerDown = (event: PointerEvent): void => {
    if (event.target === canvas) {
      return;
    }
    // T29: 取り消し・やり直しボタン(`data-preserve-pending-shape`)は確定せず、取り消しボタンで
    // 編集中の図形を破棄できるようにする(`ui/undoButton.ts`参照)。
    if (event.target instanceof Element && event.target.closest("[data-preserve-pending-shape]")) {
      return;
    }
    commitPendingShape();
  };

  setPendingShapeRestorer((restoreBase) => {
    const ctx = canvas.getContext("2d");
    if (ctx && restoreBase.width === canvas.width && restoreBase.height === canvas.height) {
      ctx.putImageData(restoreBase as ImageData, 0, 0);
    }
  });

  const unsubscribePending = subscribePendingShape((pending) => {
    if (!pending && session && session.mode !== "create") {
      // 編集ドラッグ中に外部(新規キャプチャ等)から確定・破棄された: ドラッグを終える。
      resetDrag();
    }
    if (!pending) {
      canvas.style.cursor = "";
    }
    redrawOverlay();
  });

  const unsubscribeCanvas = subscribeCanvasState((state) => {
    // 確定トリガーを経ずに画像が差し替わった場合は古いbaseを捨てる(書き戻さない)。
    dropPendingShapeIfImageChanged(state.image);
    if (state.activeTool !== lastActiveTool) {
      lastActiveTool = state.activeTool;
      // ツール切替で確定する(編集できるのは直前に描いた図形だけ、PRD FR-006/007/011改訂)。
      commitPendingShape();
    }
    redrawOverlay();
  });

  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(redrawOverlay);
  resizeObserver?.observe(canvas);
  window.addEventListener("resize", redrawOverlay);

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
    resizeObserver?.disconnect();
    unsubscribePending();
    unsubscribeCanvas();
    setPendingShapeRestorer(null);
    overlay.remove();
  };
}
