//! オブジェクト配列の純粋関数(T32【新設 2026-09-24】、PRD FR-006 オブジェクト共通基準、ARCH §5.2 T32)。
//!
//! 矢印・矩形・円は画像に焼き込まず `AnnotationObject` として保持する。配列順が重ね順で、
//! 末尾が最前面(後から描いたもの)。T33でテキストを`shape`の種類に加える。
//! 状態(配列・選択中id)の保持と操作は`documentState.ts`、取り消し・やり直しは`commands.ts`。

import type { Point } from "./coords";
import { hitTestShape, type EditableShape } from "./shapeEdit";
import { computeEllipseCenterAndRadii, ellipseLineWidth } from "./tools/ellipseTool";
import { rectangleLineWidth } from "./tools/rectangleTool";

/**
 * 1画像あたりのオブジェクト上限(人間決定 2026-09-24)。超えた分は最も古いものから
 * ベース(元画像)へ焼き込み、編集不可にする(`documentState.ts::addShapeObject()`)。
 */
export const OBJECT_LIMIT = 50;

export interface AnnotationObject {
  /** ドキュメント内で一意なid(取り消し・やり直しで同じオブジェクトを指すため)。 */
  id: number;
  shape: EditableShape;
}

/** `index`の位置へ挿入した新しい配列を返す(範囲外は先頭・末尾へ丸める)。 */
export function insertObject(
  objects: readonly AnnotationObject[],
  object: AnnotationObject,
  index: number,
): AnnotationObject[] {
  const at = Math.min(Math.max(index, 0), objects.length);
  return [...objects.slice(0, at), object, ...objects.slice(at)];
}

export function removeObject(objects: readonly AnnotationObject[], id: number): AnnotationObject[] {
  return objects.filter((object) => object.id !== id);
}

export function replaceObjectShape(
  objects: readonly AnnotationObject[],
  id: number,
  shape: EditableShape,
): AnnotationObject[] {
  return objects.map((object) => (object.id === id ? { id, shape } : object));
}

export function findObject(
  objects: readonly AnnotationObject[],
  id: number | null,
): AnnotationObject | undefined {
  return id === null ? undefined : objects.find((object) => object.id === id);
}

/**
 * 未選択のオブジェクトを掴める範囲か。矩形・円は線(枠線)の付近だけ、矢印は胴体。
 *
 * 【設計判断】選択中のオブジェクト(`shapeEdit.ts::hitTestShape()`)と違い内側は含めない。
 * 内側でも掴めると、大きな枠の中に新しい図形を描こうとしたドラッグが枠の移動になってしまうため。
 * 許容幅は「線の太さ+`tolerance`」(細い線でも画面上一定の幅で掴めるように)。
 */
export function hitTestObjectOutline(
  shape: EditableShape,
  point: Point,
  tolerance: number,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  if (shape.kind === "arrow" || shape.kind === "text") {
    // 矢印は胴体、テキストは行ボックス全体(文字の隙間でも掴めるように、T33)。
    return hitTestShape(shape, point, tolerance, canvasWidth, canvasHeight)?.type === "body";
  }
  const { rect } = shape;
  if (shape.kind === "rectangle") {
    const reach = rectangleLineWidth(canvasWidth, canvasHeight) + tolerance;
    const insideOuter =
      point.x >= rect.x - reach &&
      point.x <= rect.x + rect.width + reach &&
      point.y >= rect.y - reach &&
      point.y <= rect.y + rect.height + reach;
    const insideInner =
      point.x > rect.x + reach &&
      point.x < rect.x + rect.width - reach &&
      point.y > rect.y + reach &&
      point.y < rect.y + rect.height - reach;
    return insideOuter && !insideInner;
  }
  const reach = ellipseLineWidth(canvasWidth, canvasHeight) + tolerance;
  const { center, radiusX, radiusY } = computeEllipseCenterAndRadii(rect);
  const outer = normalizedRadius(point, center, radiusX + reach, radiusY + reach);
  const innerRx = radiusX - reach;
  const innerRy = radiusY - reach;
  const inner = innerRx > 0 && innerRy > 0 ? normalizedRadius(point, center, innerRx, innerRy) : Infinity;
  return outer <= 1 && inner >= 1;
}

/** `point`で掴めるオブジェクトを最前面(配列の末尾)から探す。無ければ`null`。 */
export function pickObjectAt(
  objects: readonly AnnotationObject[],
  point: Point,
  tolerance: number,
  canvasWidth: number,
  canvasHeight: number,
): AnnotationObject | null {
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const object = objects[i]!;
    if (hitTestObjectOutline(object.shape, point, tolerance, canvasWidth, canvasHeight)) {
      return object;
    }
  }
  return null;
}

function normalizedRadius(point: Point, center: Point, rx: number, ry: number): number {
  const nx = (point.x - center.x) / rx;
  const ny = (point.y - center.y) / ry;
  return nx * nx + ny * ny;
}
