//! ドキュメントのベース(オフスクリーンcanvas)と合成描画のDOM実装
//! (T32【新設 2026-09-24】、ARCH §5.2 T32。状態と操作は`documentState.ts`)。
//!
//! 【設計判断】性能: ベースは`ImageData`ではなく画像と同サイズのcanvas(DOMに挿さない)として持ち、
//! 表示は毎回 `clearRect` → `drawImage(base)` → オブジェクトを重ね順にパス描画、で作る。
//! canvas同士の`drawImage`はピクセル配列のコピー(`putImageData`)より速く、ドラッグ中の
//! 1フレームが「画像1枚の転写+図形N個」で済む(50個×5Kでの計測値はT32の報告を参照)。
//!
//! ブラウザのCanvas APIに依存するため、Vitest(Node)では自動テストせずE2Eで検証する
//! (状態遷移は`documentState.test.ts`が偽のサーフェスで検証済み)。

import type { Rect } from "./coords";
import type { DocumentSurface, ShapeDraft } from "./documentState";
import type { AnnotationObject } from "./objectModel";
import type { EditableShape } from "./shapeEdit";
import type { ImageDataLike } from "./commands";
import { computeTaperArrowPolygon, drawTaperArrowPolygon } from "./tools/arrowTool";
import { computeEllipseCenterAndRadii, drawEllipseOutline, ellipseLineWidth } from "./tools/ellipseTool";
import { drawRectangleOutline, rectangleLineWidth } from "./tools/rectangleTool";
import { drawTextShape } from "./tools/textLayout";

/** 図形1つをcanvasへ描く(ツール別の既存描画関数へ振り分ける。T31で`shapeTools.ts`に新設、T32で移設)。 */
export function drawEditableShape(
  ctx: CanvasRenderingContext2D,
  shape: EditableShape,
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (shape.kind === "text") {
    drawTextShape(ctx, shape, canvasWidth, canvasHeight);
    return;
  }
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

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D描画コンテキストの取得に失敗した");
  }
  return ctx;
}

function toImageData(image: ImageDataLike): ImageData {
  return image instanceof ImageData
    ? image
    : new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
}

/** 表示canvas(`#capture-canvas`)に対応するサーフェスを作る。 */
export function createDocumentSurface(display: HTMLCanvasElement): DocumentSurface {
  const base = document.createElement("canvas");
  const baseCtx = context2d(base);
  const displayCtx = context2d(display);

  return {
    size: () => ({ width: base.width, height: base.height }),
    reset: () => {
      base.width = display.width;
      base.height = display.height;
      baseCtx.clearRect(0, 0, base.width, base.height);
      baseCtx.drawImage(display, 0, 0);
    },
    read: (rect: Rect): ImageDataLike =>
      rect.width > 0 && rect.height > 0
        ? baseCtx.getImageData(rect.x, rect.y, rect.width, rect.height)
        : { data: new Uint8ClampedArray(0), width: 0, height: 0 },
    write: (rect: Rect, image: ImageDataLike) => {
      if (image.width > 0 && image.height > 0) {
        baseCtx.putImageData(toImageData(image), rect.x, rect.y);
      }
    },
    burn: (shape: EditableShape) => drawEditableShape(baseCtx, shape, base.width, base.height),
    editBase: (draw) => {
      baseCtx.save();
      draw(baseCtx);
      baseCtx.restore();
    },
    render: (objects: readonly AnnotationObject[], draft: ShapeDraft | null) => {
      const { width, height } = display;
      if (width === 0 || height === 0 || base.width !== width || base.height !== height) {
        return;
      }
      displayCtx.clearRect(0, 0, width, height);
      displayCtx.drawImage(base, 0, 0);
      for (const object of objects) {
        const shape = draft && draft.id === object.id ? draft.shape : object.shape;
        drawEditableShape(displayCtx, shape, width, height);
      }
      if (draft && draft.id === null) {
        drawEditableShape(displayCtx, draft.shape, width, height);
      }
    },
  };
}
