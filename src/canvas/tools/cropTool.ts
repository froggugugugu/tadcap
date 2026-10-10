//! トリミングツール(QE-T21、ARCH_quick-edits §5.1・§6.3・§7.1 C-1〜2・C-6、UI_quick-edits §4.1・§4.2)。
//!
//! 画像の上をドラッグして残す範囲を囲み(`cropSession`)、8 つのハンドル(四隅はかぎ形・四辺の中央は棒、
//! 当たり半径 10px)でリサイズ、範囲の内側のドラッグで移動する。範囲の外の暗さ・白の枠・ハンドルは
//! Canvas に重ねたオーバーレイ(`pointer-events: none`)にだけ描き、合成には描かない(確定前のコピー・
//! 履歴は切り詰めていない画像のまま)。Enter で確定(`applyCrop()` → `cancelCrop()` → `onCropped`)、
//! Esc でやめる。範囲が無いときの Enter / Esc は何もしない(選択の解除などへ渡す)。
//!
//! 確定の通知(トースト)は`onCropped`で`main.ts`から受ける(`canvas/`→`ui/`の依存を作らない、
//! TASK_quick-edits【要確認】#5)。やめる条件(ツールの変化・自動マスキングの開始・ドキュメントの大きさの
//! 変化)は本モジュールが購読して`cancelCrop()`する(ARCH §6.3)。
//!
//! 判定は純粋関数(`hitTestCrop`・`resizeCropRect`・`moveCropRect`・`cropKeyAction`・`shouldCancelCrop` など)に
//! 切り出してユニットテストし、ポインタとオーバーレイの結線(DOM)は E2E(QE-T23)で確かめる。

import {
  getCanvasState,
  isSameCanvasImage,
  setDrawing,
  subscribeCanvasState,
  type CanvasImage,
  type ToolId,
} from "../canvasState";
import { clientToCanvasPoint, normalizeRect, type Point, type Rect } from "../coords";
import {
  beginCrop,
  cancelCrop,
  getCropSession,
  subscribeCropSession,
  updateCropRect,
  type CropSession,
} from "../cropSession";
import { applyCrop, subscribeDocument } from "../documentState";
import { isMaskSessionActive, subscribeMaskSession } from "../maskSession";

/** 範囲の外の暗さ(UI_quick-edits §4.1)。スポットライト(50%)より一段暗くし、焼き込まれる暗さと見分ける。 */
export const CROP_SHADE = "rgba(0, 0, 0, 0.6)";

/** ハンドルの当たり判定半径(画面上の CSS ピクセル。既存の注釈のハンドルと同じ)。 */
const HANDLE_HIT_RADIUS_CSS = 10;
/** かぎ形の腕・棒の長さと太さ(CSS ピクセル、UI_quick-edits §4.1)。 */
const HANDLE_LENGTH_CSS = 16;
const HANDLE_THICKNESS_CSS = 3;
const FRAME_WIDTH_CSS = 1.5;
const LIGHT = "#ffffff";
const DARK_EDGE = "rgba(0, 0, 0, 0.5)";

/** 四隅(`nw` など)と四辺の中央(`n` など)。 */
export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export type CropHit = { type: "handle"; handle: CropHandle } | { type: "inside" } | null;

const CORNERS: ReadonlyArray<CropHandle> = ["nw", "ne", "se", "sw"];

/** 8 つのハンドルの位置(画像のピクセル座標。四隅 → 辺の中央の順ではなく、左上から時計回り)。 */
export function cropHandles(rect: Rect): Array<{ id: CropHandle; point: Point }> {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  return [
    { id: "nw", point: { x: left, y: top } },
    { id: "n", point: { x: midX, y: top } },
    { id: "ne", point: { x: right, y: top } },
    { id: "e", point: { x: right, y: midY } },
    { id: "se", point: { x: right, y: bottom } },
    { id: "s", point: { x: midX, y: bottom } },
    { id: "sw", point: { x: left, y: bottom } },
    { id: "w", point: { x: left, y: midY } },
  ];
}

/**
 * `point` が範囲のどこに当たるか。ハンドル(`tolerance` 以内、重なれば四隅を優先)→ 内側(移動)→ 外側
 * (`null`。新しい範囲を描く)。`tolerance` は画面上一定になるよう呼び出し側が表示倍率で換算して渡す。
 */
export function hitTestCrop(rect: Rect, point: Point, tolerance: number): CropHit {
  const handles = cropHandles(rect);
  const ordered = [
    ...handles.filter((h) => CORNERS.includes(h.id)),
    ...handles.filter((h) => !CORNERS.includes(h.id)),
  ];
  for (const handle of ordered) {
    if (Math.hypot(point.x - handle.point.x, point.y - handle.point.y) <= tolerance) {
      return { type: "handle", handle: handle.id };
    }
  }
  const inside =
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height;
  return inside ? { type: "inside" } : null;
}

/** 当たりに応じたカーソル(UI_quick-edits §4.1)。外側は範囲を描ける印の`crosshair`。 */
export function cropCursor(hit: CropHit): string {
  if (!hit) {
    return "crosshair";
  }
  if (hit.type === "inside") {
    return "move";
  }
  switch (hit.handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
  }
}

/**
 * ハンドルのドラッグでリサイズした範囲。ハンドルの辺だけを`pointer`へ動かし(辺の中央は 1 辺、四隅は 2 辺)、
 * 画像の内側に収める。反対の辺を越えても逆転せず、幅・高さ 0 で止まる。
 */
export function resizeCropRect(
  initial: Rect,
  handle: CropHandle,
  pointer: Point,
  canvasWidth: number,
  canvasHeight: number,
): Rect {
  let left = initial.x;
  let right = initial.x + initial.width;
  let top = initial.y;
  let bottom = initial.y + initial.height;
  if (handle === "nw" || handle === "w" || handle === "sw") {
    left = clamp(pointer.x, 0, right);
  }
  if (handle === "ne" || handle === "e" || handle === "se") {
    right = clamp(pointer.x, left, canvasWidth);
  }
  if (handle === "nw" || handle === "n" || handle === "ne") {
    top = clamp(pointer.y, 0, bottom);
  }
  if (handle === "sw" || handle === "s" || handle === "se") {
    bottom = clamp(pointer.y, top, canvasHeight);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 範囲を`delta`だけ動かす。大きさは保ち、画像の端で止める。 */
export function moveCropRect(initial: Rect, delta: Point, canvasWidth: number, canvasHeight: number): Rect {
  return {
    ...initial,
    x: clamp(initial.x + delta.x, 0, Math.max(0, canvasWidth - initial.width)),
    y: clamp(initial.y + delta.y, 0, Math.max(0, canvasHeight - initial.height)),
  };
}

/** 範囲の外を覆う重ならない矩形(上・下・左・右の順、面積 0 は除く)。オーバーレイの暗さに使う。 */
export function cropShadeRects(rect: Rect, canvasWidth: number, canvasHeight: number): Rect[] {
  const bottom = rect.y + rect.height;
  const right = rect.x + rect.width;
  const rects: Rect[] = [
    { x: 0, y: 0, width: canvasWidth, height: rect.y },
    { x: 0, y: bottom, width: canvasWidth, height: canvasHeight - bottom },
    { x: 0, y: rect.y, width: rect.x, height: rect.height },
    { x: right, y: rect.y, width: canvasWidth - right, height: rect.height },
  ];
  return rects.filter((r) => r.width > 0 && r.height > 0);
}

/** キーの判定に使う`KeyboardEvent`の部分(テストで組み立てられるように)。 */
export interface CropKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
}

export interface CropKeyContext {
  activeTool: ToolId | null;
  /** 範囲があるか(`getCropSession() !== null`)。 */
  hasRange: boolean;
  /** 範囲をドラッグ中か。 */
  dragging: boolean;
}

/**
 * keydown をトリミングが受けるか(UI_quick-edits §4.2)。範囲がある間の Enter = 確定・Esc = やめる。
 * 範囲が無いとき・ほかのツール・修飾キー付き・IME の変換中・処理済みは`null`(選択の解除などへ渡す)。
 * ドラッグ中は Esc(やめる)だけを受ける。
 */
export function cropKeyAction(event: CropKeyEvent, context: CropKeyContext): "apply" | "cancel" | null {
  if (
    context.activeTool !== "crop" ||
    !context.hasRange ||
    event.defaultPrevented ||
    event.isComposing ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return null;
  }
  if (event.key === "Escape") {
    return "cancel";
  }
  if (event.key === "Enter" && !context.dragging) {
    return "apply";
  }
  return null;
}

/**
 * 今の範囲で切り詰める(Enter・確定ボタン共通、ARCH §5.2)。切り詰めたら範囲を消して`onCropped`を呼び
 * `true`。範囲が無い・何もしない範囲(`applyCrop()`が`false`)なら範囲を残して`false`。
 */
export function confirmCrop(
  onCropped?: () => void,
  apply: (rect: Rect) => boolean = applyCrop,
): boolean {
  const session = getCropSession();
  if (!session || !apply(session.rect)) {
    return false;
  }
  cancelCrop();
  onCropped?.();
  return true;
}

/** やめる条件を見るための値(ARCH §7.1 C-6)。 */
export interface CropWatch {
  activeTool: ToolId | null;
  /** 自動マスキングの処理中・確認中。 */
  masking: boolean;
  /** ドキュメント(表示 canvas)の大きさ。 */
  width: number;
  height: number;
}

/** 範囲を捨てるか: ツールの変化・自動マスキングの開始(処理中・確認中)・ドキュメントの大きさの変化。 */
export function shouldCancelCrop(previous: CropWatch, next: CropWatch): boolean {
  return (
    next.activeTool !== previous.activeTool ||
    next.masking ||
    next.width !== previous.width ||
    next.height !== previous.height
  );
}

/**
 * やめる条件を購読し、当てはまれば`cancelCrop()`する(`canvasState`・`maskSession`・`documentState`)。
 * `size`はドキュメントの今の大きさ(DOM では表示 canvas の`width`/`height`)。戻り値は解除関数。
 */
export function bindCropCancelConditions(size: () => { width: number; height: number }): () => void {
  const read = (): CropWatch => {
    const { width, height } = size();
    return { activeTool: getCanvasState().activeTool, masking: isMaskSessionActive(), width, height };
  };
  let last = read();
  const check = (): void => {
    const next = read();
    if (shouldCancelCrop(last, next)) {
      cancelCrop();
    }
    last = next;
  };
  const unsubscribers = [subscribeCanvasState(check), subscribeMaskSession(check), subscribeDocument(check)];
  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}

export interface CropToolOptions {
  /** 切り詰めたときに呼ぶ(`main.ts`がトースト「切り抜きました。⌘Z で戻せます。」を結ぶ)。 */
  onCropped?: () => void;
}

type CropDrag =
  | { mode: "create"; origin: Point; before: CropSession | null }
  | { mode: "resize"; handle: CropHandle; initial: Rect }
  | { mode: "move"; origin: Point; initial: Rect };

/**
 * トリミングツールを Canvas へ結線する(DOM 依存、E2E で検証)。`bindSelectionKeys()`より前に呼ぶ
 * (範囲がある間の Enter / Esc を先に受けるため、ARCH_quick-edits §11)。戻り値は解除関数。
 */
export function bindCropTool(canvas: HTMLCanvasElement, options: CropToolOptions = {}): () => void {
  const overlay = document.createElement("canvas");
  overlay.className = "shape-overlay crop-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.pointerEvents = "none";
  overlay.hidden = true;
  canvas.insertAdjacentElement("afterend", overlay);

  let drag: CropDrag | null = null;
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

  const hitTolerance = (): number => {
    const cssWidth = canvas.getBoundingClientRect().width;
    return cssWidth > 0 ? (HANDLE_HIT_RADIUS_CSS * canvas.width) / cssWidth : HANDLE_HIT_RADIUS_CSS;
  };

  const redrawOverlay = (): void => {
    const session = getCropSession();
    renderCropOverlay(canvas, overlay, getCanvasState().activeTool === "crop" ? session : null);
  };

  const resetDrag = (): void => {
    drag = null;
    imageAtDragStart = null;
    if (getCanvasState().isDrawing) {
      setDrawing(false);
    }
    if (activePointerId !== null && canvas.hasPointerCapture(activePointerId)) {
      canvas.releasePointerCapture(activePointerId);
    }
    activePointerId = null;
  };

  const handlePointerDown = (event: PointerEvent): void => {
    const state = getCanvasState();
    if (state.activeTool !== "crop" || !state.image || isMaskSessionActive() || drag) {
      return;
    }
    const point = toCanvasPoint(event);
    const session = getCropSession();
    const hit = session ? hitTestCrop(session.rect, point, hitTolerance()) : null;
    if (session && hit?.type === "handle") {
      drag = { mode: "resize", handle: hit.handle, initial: session.rect };
    } else if (session && hit?.type === "inside") {
      drag = { mode: "move", origin: point, initial: session.rect };
    } else {
      drag = { mode: "create", origin: point, before: session };
      beginCrop({ x: point.x, y: point.y, width: 0, height: 0 }, canvas.width, canvas.height);
    }
    imageAtDragStart = state.image;
    activePointerId = event.pointerId;
    setDrawing(true);
    canvas.setPointerCapture(event.pointerId);
  };

  const dragRect = (current: CropDrag, point: Point): Rect => {
    switch (current.mode) {
      case "create":
        return normalizeRect(current.origin, point);
      case "resize":
        return resizeCropRect(current.initial, current.handle, point, canvas.width, canvas.height);
      case "move":
        return moveCropRect(
          current.initial,
          { x: point.x - current.origin.x, y: point.y - current.origin.y },
          canvas.width,
          canvas.height,
        );
    }
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (getCanvasState().activeTool !== "crop") {
      return;
    }
    const point = toCanvasPoint(event);
    if (!drag) {
      const session = getCropSession();
      canvas.style.cursor = cropCursor(session ? hitTestCrop(session.rect, point, hitTolerance()) : null);
      return;
    }
    if (!isSameCanvasImage(getCanvasState().image, imageAtDragStart)) {
      // ドラッグ中に画像が差し替えられた(MUST-1 と同じ)。範囲を捨てて中断する。
      resetDrag();
      cancelCrop();
      return;
    }
    updateCropRect(dragRect(drag, point), canvas.width, canvas.height);
  };

  const finishDrag = (event: PointerEvent): void => {
    const current = drag;
    if (!current) {
      return;
    }
    if (isSameCanvasImage(getCanvasState().image, imageAtDragStart)) {
      updateCropRect(dragRect(current, toCanvasPoint(event)), canvas.width, canvas.height);
      const rect = getCropSession()?.rect;
      if (current.mode === "create" && rect && (rect.width === 0 || rect.height === 0)) {
        // 押しただけ(囲んでいない)なら、押す前の範囲に戻す(無ければ範囲なし)。
        if (current.before) {
          beginCrop(current.before.rect, canvas.width, canvas.height);
        } else {
          cancelCrop();
        }
      }
    }
    resetDrag();
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    const action = cropKeyAction(event, {
      activeTool: getCanvasState().activeTool,
      hasRange: getCropSession() !== null,
      dragging: drag !== null,
    });
    if (!action) {
      return;
    }
    event.preventDefault();
    if (action === "cancel") {
      resetDrag();
      cancelCrop();
      return;
    }
    confirmCrop(options.onCropped);
  };

  const unbindCancel = bindCropCancelConditions(() => ({ width: canvas.width, height: canvas.height }));
  const unsubscribeSession = subscribeCropSession(redrawOverlay);
  const unsubscribeDocument = subscribeDocument(redrawOverlay);
  const unsubscribeCanvas = subscribeCanvasState((state) => {
    if (state.activeTool !== lastActiveTool) {
      lastActiveTool = state.activeTool;
      if (drag) {
        resetDrag();
      }
      canvas.style.cursor = state.activeTool === "crop" ? "crosshair" : "";
    }
    redrawOverlay();
  });

  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(redrawOverlay);
  resizeObserver?.observe(canvas);
  window.addEventListener("resize", redrawOverlay);
  window.addEventListener("keydown", handleKeydown);
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", finishDrag);
  canvas.addEventListener("pointercancel", finishDrag);
  redrawOverlay();

  return () => {
    canvas.removeEventListener("pointerdown", handlePointerDown);
    canvas.removeEventListener("pointermove", handlePointerMove);
    canvas.removeEventListener("pointerup", finishDrag);
    canvas.removeEventListener("pointercancel", finishDrag);
    window.removeEventListener("resize", redrawOverlay);
    window.removeEventListener("keydown", handleKeydown);
    resizeObserver?.disconnect();
    unbindCancel();
    unsubscribeSession();
    unsubscribeDocument();
    unsubscribeCanvas();
    overlay.remove();
  };
}

/** オーバーレイを Canvas の表示位置・大きさに合わせ、範囲の外の暗さ・枠・ハンドルを描く(範囲なしは隠す)。 */
function renderCropOverlay(
  canvas: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  session: CropSession | null,
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
  overlay.hidden = session === null;
  const ctx = overlay.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!session || canvas.width === 0 || canvas.height === 0) {
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const scaleX = cssWidth / canvas.width;
  const scaleY = cssHeight / canvas.height;
  const toCss = (r: Rect): Rect => ({ x: r.x * scaleX, y: r.y * scaleY, width: r.width * scaleX, height: r.height * scaleY });

  ctx.fillStyle = CROP_SHADE;
  for (const shade of cropShadeRects(session.rect, canvas.width, canvas.height)) {
    const r = toCss(shade);
    ctx.fillRect(r.x, r.y, r.width, r.height);
  }

  const { x, y, width, height } = toCss(session.rect);
  // 枠: 白の実線 1.5px(内側)+ その外側に濃い 1px(UI_quick-edits §4.1)。
  ctx.lineWidth = 1;
  ctx.strokeStyle = DARK_EDGE;
  ctx.strokeRect(x - 0.5, y - 0.5, width + 1, height + 1);
  if (width >= FRAME_WIDTH_CSS && height >= FRAME_WIDTH_CSS) {
    ctx.lineWidth = FRAME_WIDTH_CSS;
    ctx.strokeStyle = LIGHT;
    ctx.strokeRect(x + FRAME_WIDTH_CSS / 2, y + FRAME_WIDTH_CSS / 2, width - FRAME_WIDTH_CSS, height - FRAME_WIDTH_CSS);
  }

  // ハンドル: 四隅はかぎ形、四辺の中央は棒(長さ 16px・太さ 3px、白 + 1px の濃い縁)。枠の内側に沿わせる。
  const inset = HANDLE_THICKNESS_CSS / 2;
  const armX = Math.min(HANDLE_LENGTH_CSS, width / 2);
  const armY = Math.min(HANDLE_LENGTH_CSS, height / 2);
  const left = x + inset;
  const right = x + width - inset;
  const top = y + inset;
  const bottom = y + height - inset;
  const midX = x + width / 2;
  const midY = y + height / 2;
  const paths: Point[][] = [
    [{ x: left, y: top + armY }, { x: left, y: top }, { x: left + armX, y: top }],
    [{ x: right - armX, y: top }, { x: right, y: top }, { x: right, y: top + armY }],
    [{ x: right, y: bottom - armY }, { x: right, y: bottom }, { x: right - armX, y: bottom }],
    [{ x: left + armX, y: bottom }, { x: left, y: bottom }, { x: left, y: bottom - armY }],
    [{ x: midX - armX / 2, y: top }, { x: midX + armX / 2, y: top }],
    [{ x: right, y: midY - armY / 2 }, { x: right, y: midY + armY / 2 }],
    [{ x: midX - armX / 2, y: bottom }, { x: midX + armX / 2, y: bottom }],
    [{ x: left, y: midY - armY / 2 }, { x: left, y: midY + armY / 2 }],
  ];
  ctx.lineCap = "square";
  ctx.lineJoin = "miter";
  for (const [lineWidth, color] of [
    [HANDLE_THICKNESS_CSS + 2, DARK_EDGE],
    [HANDLE_THICKNESS_CSS, LIGHT],
  ] as const) {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color;
    for (const path of paths) {
      ctx.beginPath();
      path.forEach((p, index) => (index === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
