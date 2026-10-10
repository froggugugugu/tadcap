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
//!
//! QE-T12: 合成(`render()`)のたびに`stampNumbers()`を1回求め、番号スタンプへ番号を渡す
//! (ARCH_quick-edits §5.2)。番号を決める`stampLabel()`は純粋関数としてユニットテストする。
//!
//! QE-T15: 合成に暗さの段を足した(ARCH_quick-edits §1.3 #9・§7.1 P)。順は「ベース → 穴(下書きを含む)の
//! 和の外側を`SPOTLIGHT_SHADE`で1回だけ塗る → 穴以外の注釈(重ね順)→ 穴以外の下書き」。穴そのものは
//! 何も描かない(選択の枠・ハンドルはオーバーレイ)。暗さは表示canvasにだけ入り、ベースには入らないため、
//! コピー・履歴(表示canvasを読む)には写り、自動マスキング・モザイク(ベースを読む、`exportBase()`・
//! `read()`)は暗さの影響を受けない。合成は`composeDocument()`(偽の`ctx`でユニットテストする)。

import type { Rect } from "./coords";
import { SPOTLIGHT_SHADE, spotlightShadeRects } from "./spotlight";
import { drawStamp, isNumberStamp, stampNumbers } from "./tools/stampShape";
import type { DocumentSurface, ShapeDraft } from "./documentState";
import type { AnnotationObject } from "./objectModel";
import type { EditableShape } from "./shapeEdit";
import type { ImageDataLike } from "./commands";
import { computeTaperArrowPolygon, drawTaperArrowPolygon } from "./tools/arrowTool";
import { computeEllipseCenterAndRadii, drawEllipseOutline, ellipseLineWidth } from "./tools/ellipseTool";
import { drawRectangleOutline, rectangleLineWidth } from "./tools/rectangleTool";
import { drawTextShape } from "./tools/textLayout";

/**
 * 番号スタンプに描く番号(QE-T12、ARCH_quick-edits §5.2)。置いてあるものは`numbers`
 * (`stampNumbers()`の`id`の順位)、作成中の下書き(`id`が`null`)は「今の番号スタンプの数 + 1」。
 * 記号スタンプ・ほかの注釈は`null`(番号を持たない)。
 */
export function stampLabel(
  shape: EditableShape,
  id: number | null,
  numbers: ReadonlyMap<number, number>,
): number | null {
  if (!isNumberStamp(shape)) {
    return null;
  }
  return id === null ? numbers.size + 1 : (numbers.get(id) ?? null);
}

/**
 * 図形1つをcanvasへ描く(ツール別の既存描画関数へ振り分ける。T31で`shapeTools.ts`に新設、T32で移設)。
 * `label`は番号スタンプの番号(`stampLabel()`)。焼き込み(`burn`)は番号スタンプを選ばない
 * (`pickBurnTarget()`)ため、省略時の`null`で足りる。
 */
export function drawEditableShape(
  ctx: CanvasRenderingContext2D,
  shape: EditableShape,
  canvasWidth: number,
  canvasHeight: number,
  label: number | null = null,
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
  if (shape.kind === "stamp") {
    drawStamp(ctx, shape, label, canvasWidth, canvasHeight);
    return;
  }
  if (shape.kind === "spotlight") {
    // 穴そのものは描かない(暗さは`composeDocument()`の段で塗る。焼き込みの対象にもならない)。
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

/**
 * 表示の合成(QE-T15、ARCH_quick-edits §7.1 P)。`clearRect` → `drawImage(base)` → 穴の和の外側を1本の
 * パスで1回だけ塗る(穴が無い・穴が画像全体を覆うなら塗らない)→ 穴以外の注釈を重ね順に描く →
 * 作成中の下書き(`id`が`null`)が穴以外なら最前面に描く。移動・リサイズ中の下書き(`id`あり)は
 * 該当オブジェクトの形を置き換える(暗さもその位置で求める)。
 */
export function composeDocument(
  ctx: CanvasRenderingContext2D,
  base: CanvasImageSource,
  width: number,
  height: number,
  objects: readonly AnnotationObject[],
  draft: ShapeDraft | null,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(base, 0, 0);
  const shapes: { id: number | null; shape: EditableShape }[] = objects.map((object) => ({
    id: object.id,
    shape: draft && draft.id === object.id ? draft.shape : object.shape,
  }));
  if (draft && draft.id === null) {
    shapes.push({ id: null, shape: draft.shape });
  }
  const holes = shapes.flatMap(({ shape }) => (shape.kind === "spotlight" ? [shape.rect] : []));
  fillSpotlightShade(ctx, holes, width, height);
  // 番号は合成ごとに1回だけ求める(消すと詰まり、取り消しで戻る。QE-T12)。
  const numbers = stampNumbers(objects);
  for (const { id, shape } of shapes) {
    if (shape.kind !== "spotlight") {
      drawEditableShape(ctx, shape, width, height, stampLabel(shape, id, numbers));
    }
  }
}

/**
 * 穴の和の外側を、互いに重ならない矩形(`spotlightShadeRects()`)の1本のパスにして1回だけ塗る。
 * 重なった穴の内側が二重に塗られず、端数の座標の境目に半透明の線も出ない(ARCH_quick-edits §1.3 #8)。
 */
function fillSpotlightShade(
  ctx: CanvasRenderingContext2D,
  holes: readonly Rect[],
  width: number,
  height: number,
): void {
  if (holes.length === 0) {
    return;
  }
  const rects = spotlightShadeRects(holes, width, height);
  if (rects.length === 0) {
    return;
  }
  ctx.save();
  ctx.beginPath();
  for (const r of rects) {
    ctx.rect(r.x, r.y, r.width, r.height);
  }
  ctx.fillStyle = SPOTLIGHT_SHADE;
  ctx.fill();
  ctx.restore();
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
  /**
   * T34: ベースと同じ内容のPNG(読み込んだ画像そのもの、または直前に`exportBase()`した結果)。
   * ベースを変えるたびに`revision`を進め、変えていなければ`exportBase()`で再エンコードしない
   * (5KのPNG化は数百ms掛かりうるため、履歴を切り替えるだけの操作を軽くする)。
   */
  let cleanBlob: Blob | null = null;
  let cleanRevision = -1;
  let revision = 0;
  const touch = (): void => {
    revision += 1;
  };
  const markClean = (blob: Blob | null): void => {
    cleanBlob = blob;
    cleanRevision = blob ? revision : -1;
  };

  return {
    size: () => ({ width: base.width, height: base.height }),
    reset: (blob) => {
      base.width = display.width;
      base.height = display.height;
      baseCtx.clearRect(0, 0, base.width, base.height);
      // 空状態(表示canvasが0×0、履歴の全削除)では取り込む画素が無い(0×0のcanvasを
      // drawImageに渡すとInvalidStateErrorになる)。
      if (display.width > 0 && display.height > 0) {
        baseCtx.drawImage(display, 0, 0);
      }
      touch();
      markClean(blob ?? null);
    },
    load: (image, blob) => {
      display.width = image.width;
      display.height = image.height;
      base.width = image.width;
      base.height = image.height;
      baseCtx.clearRect(0, 0, base.width, base.height);
      baseCtx.drawImage(image, 0, 0);
      touch();
      markClean(blob);
    },
    exportBase: () => {
      if (cleanBlob && cleanRevision === revision) {
        return Promise.resolve(cleanBlob);
      }
      // 呼んだ時点の内容を同期で複製してからPNG化する(待っている間にベースが変わっても混ざらない)。
      const copy = document.createElement("canvas");
      copy.width = base.width;
      copy.height = base.height;
      context2d(copy).drawImage(base, 0, 0);
      const at = revision;
      return new Promise<Blob>((resolve, reject) => {
        copy.toBlob((blob) => {
          if (!blob) {
            reject(new Error("ベースのPNG化に失敗した"));
            return;
          }
          if (at === revision) {
            markClean(blob);
          }
          resolve(blob);
        }, "image/png");
      });
    },
    read: (rect: Rect): ImageDataLike =>
      rect.width > 0 && rect.height > 0
        ? baseCtx.getImageData(rect.x, rect.y, rect.width, rect.height)
        : { data: new Uint8ClampedArray(0), width: 0, height: 0 },
    write: (rect: Rect, image: ImageDataLike) => {
      if (image.width > 0 && image.height > 0) {
        baseCtx.putImageData(toImageData(image), rect.x, rect.y);
        touch();
      }
    },
    burn: (shape: EditableShape) => {
      drawEditableShape(baseCtx, shape, base.width, base.height);
      touch();
    },
    editBase: (draw) => {
      touch();
      baseCtx.save();
      draw(baseCtx);
      baseCtx.restore();
    },
    render: (objects: readonly AnnotationObject[], draft: ShapeDraft | null) => {
      const { width, height } = display;
      if (width === 0 || height === 0 || base.width !== width || base.height !== height) {
        return;
      }
      composeDocument(displayCtx, base, width, height, objects, draft);
    },
  };
}
