import { describe, expect, it } from "vitest";

import type { Rect } from "./coords";
import { normalizeCropRect, planCrop } from "./crop";
import type { AnnotationObject } from "./objectModel";
import {
  shapeUndoRect,
  type ArrowShape,
  type BoxShape,
  type EditableShape,
  type SpotlightShape,
  type StampShape,
  type TextShape,
} from "./shapeEdit";
import { stampShapeDiameter } from "./tools/stampShape";
import { textShapeFontPx } from "./tools/textLayout";

const W = 400;
const H = 300;
/** 400x300 の対角線。 */
const DIAGONAL = 500;
const COLOR = "#FF5C8A";

const obj = (id: number, shape: EditableShape): AnnotationObject => ({ id, shape });

describe("normalizeCropRect(範囲の整数化、ARCH_quick-edits §7.1 C-3-1)", () => {
  it("各辺を四捨五入する", () => {
    // 左 10.4→10、右 110.6→111、上 20.6→21、下 70.9→71
    expect(normalizeCropRect({ x: 10.4, y: 20.6, width: 100.2, height: 50.3 }, W, H)).toEqual({
      x: 10,
      y: 21,
      width: 101,
      height: 50,
    });
  });

  it("画像の外へ出た辺は [0, 幅] × [0, 高さ] に切り詰める", () => {
    expect(normalizeCropRect({ x: -20, y: -10, width: 100, height: 500 }, W, H)).toEqual({
      x: 0,
      y: 0,
      width: 80,
      height: 300,
    });
  });

  it("負の幅・高さ(逆向きのドラッグ)は向きをそろえる", () => {
    expect(normalizeCropRect({ x: 110, y: 70, width: -100, height: -50 }, W, H)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it("幅・高さが 0(丸めて 0 になる・画像の外だけを含む)なら何もしない(null)", () => {
    expect(normalizeCropRect({ x: 10, y: 10, width: 0, height: 50 }, W, H)).toBeNull();
    expect(normalizeCropRect({ x: 10, y: 10, width: 50, height: 0 }, W, H)).toBeNull();
    expect(normalizeCropRect({ x: 10.1, y: 10, width: 0.2, height: 50 }, W, H)).toBeNull();
    expect(normalizeCropRect({ x: 500, y: 10, width: 50, height: 50 }, W, H)).toBeNull();
  });

  it("画像全体と同じ(はみ出して全体を覆う場合を含む)なら何もしない(null)", () => {
    expect(normalizeCropRect({ x: 0, y: 0, width: W, height: H }, W, H)).toBeNull();
    expect(normalizeCropRect({ x: -5, y: -5, width: W + 10, height: H + 10 }, W, H)).toBeNull();
    expect(normalizeCropRect({ x: 0.3, y: -0.4, width: W - 0.2, height: H + 0.1 }, W, H)).toBeNull();
  });
});

describe("planCrop(注釈ごとに「ずらす / 消す」、ARCH_quick-edits §7.1 C-3-2)", () => {
  const crop: Rect = { x: 100, y: 50, width: 200, height: 150 };

  const arrow: ArrowShape = { kind: "arrow", start: { x: 150, y: 100 }, end: { x: 250, y: 100 }, color: COLOR };
  const rectangle: BoxShape = { kind: "rectangle", rect: { x: 120, y: 80, width: 50, height: 40 }, color: COLOR };
  const ellipse: BoxShape = { ...rectangle, kind: "ellipse" };
  const text: TextShape = {
    kind: "text",
    text: "Hi",
    x: 150,
    top: 100,
    fontSize: "medium",
    color: COLOR,
    metrics: { width: 40, left: 0, right: 38, ascent: 13, descent: 1, fontAscent: 17, fontDescent: 4 },
  };
  const stamp: StampShape = {
    kind: "stamp",
    center: { x: 200, y: 120 },
    glyph: "number",
    color: COLOR,
    fontSize: "medium",
  };
  const hole: SpotlightShape = { kind: "spotlight", rect: { x: 150, y: 100, width: 40, height: 40 } };

  it("全種類を範囲の左上の分だけずらし、styleBasis に切る前の対角線を付ける", () => {
    const objects = [obj(1, arrow), obj(2, rectangle), obj(3, ellipse), obj(4, text), obj(5, stamp), obj(6, hole)];
    const plan = planCrop(objects, crop, W, H);
    expect(plan.removals).toEqual([]);
    expect(plan.updates.map((u) => u.after)).toEqual([
      { ...arrow, start: { x: 50, y: 50 }, end: { x: 150, y: 50 }, styleBasis: DIAGONAL },
      { ...rectangle, rect: { x: 20, y: 30, width: 50, height: 40 }, styleBasis: DIAGONAL },
      { ...ellipse, rect: { x: 20, y: 30, width: 50, height: 40 }, styleBasis: DIAGONAL },
      { ...text, x: 50, top: 50, styleBasis: DIAGONAL },
      { ...stamp, center: { x: 100, y: 70 }, styleBasis: DIAGONAL },
      { ...hole, rect: { x: 50, y: 50, width: 40, height: 40 }, styleBasis: DIAGONAL },
    ]);
    expect(plan.updates.map((u) => u.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.updates.map((u) => u.before)).toEqual(objects.map((o) => o.shape));
    expect(plan.objects).toEqual(plan.updates.map((u) => ({ id: u.id, shape: u.after })));
  });

  it("切り詰めた後の画像でも、残った注釈の大きさ(線の太さ・文字・直径)は変わらない", () => {
    const plan = planCrop([obj(1, rectangle), obj(2, text), obj(3, stamp)], crop, W, H);
    const [r, t, s] = plan.updates.map((u) => u.after);
    const shifted = (rect: Rect): Rect => ({ ...rect, x: rect.x - crop.x, y: rect.y - crop.y });
    expect(shapeUndoRect(r!, crop.width, crop.height)).toEqual(shifted(shapeUndoRect(rectangle, W, H)));
    expect(textShapeFontPx(t as TextShape, crop.width, crop.height)).toBe(textShapeFontPx(text, W, H));
    expect(stampShapeDiameter(s as StampShape, crop.width, crop.height)).toBe(stampShapeDiameter(stamp, W, H));
  });

  it("一部がはみ出した注釈は残り、完全に外へ出た注釈は消す", () => {
    const partial: BoxShape = { ...rectangle, rect: { x: 50, y: 20, width: 100, height: 100 } };
    const outside: BoxShape = { ...rectangle, rect: { x: 10, y: 10, width: 30, height: 30 } };
    const plan = planCrop([obj(1, partial), obj(2, outside)], crop, W, H);
    expect(plan.updates).toEqual([
      { id: 1, before: partial, after: { ...partial, rect: { x: -50, y: -30, width: 100, height: 100 }, styleBasis: DIAGONAL } },
    ]);
    expect(plan.removals).toEqual([{ object: obj(2, outside), index: 1 }]);
    expect(plan.objects.map((o) => o.id)).toEqual([1]);
  });

  it("端点は範囲の外でも、描画範囲(矢じり・影)が範囲に掛かる矢印は残る", () => {
    const nearArrow: ArrowShape = { kind: "arrow", start: { x: 20, y: 40 }, end: { x: 95, y: 40 }, color: COLOR };
    const drawn = shapeUndoRect(nearArrow, W, H);
    // 前提: 端点の外接矩形は範囲の外、描画範囲は範囲に掛かる
    expect(Math.max(nearArrow.start.x, nearArrow.end.x)).toBeLessThan(crop.x);
    expect(drawn.x + drawn.width).toBeGreaterThan(crop.x);
    expect(drawn.y + drawn.height).toBeGreaterThan(crop.y);
    const plan = planCrop([obj(1, nearArrow)], crop, W, H);
    expect(plan.removals).toEqual([]);
    expect(plan.updates[0]!.after).toEqual({
      ...nearArrow,
      start: { x: -80, y: -10 },
      end: { x: -5, y: -10 },
      styleBasis: DIAGONAL,
    });
  });

  it("描画範囲が範囲の辺に接するだけ(重なりの面積 0)なら消す", () => {
    // 穴の描画範囲は穴の矩形そのもの。右端 100 が範囲の左端 100 に接する。
    const touching: SpotlightShape = { kind: "spotlight", rect: { x: 60, y: 60, width: 40, height: 40 } };
    expect(planCrop([obj(1, touching)], crop, W, H).removals).toEqual([{ object: obj(1, touching), index: 0 }]);
  });

  it("消す注釈は先頭から順に、消した時点の位置(index)を持つ", () => {
    const outside: BoxShape = { ...rectangle, rect: { x: 10, y: 10, width: 30, height: 30 } };
    const outside2: BoxShape = { ...rectangle, rect: { x: 340, y: 240, width: 30, height: 30 } };
    const objects = [obj(1, outside), obj(2, rectangle), obj(3, outside2), obj(4, text), obj(5, outside)];
    const plan = planCrop(objects, crop, W, H);
    expect(plan.updates.map((u) => u.id)).toEqual([2, 4]);
    // 1 を消すと 3 は位置 1 へ、さらに 3 を消すと 5 は位置 2 へ詰まる(2・4 が前に残る)
    expect(plan.removals).toEqual([
      { object: objects[0], index: 0 },
      { object: objects[2], index: 1 },
      { object: objects[4], index: 2 },
    ]);
    expect(plan.objects.map((o) => o.id)).toEqual([2, 4]);
  });

  it("styleBasis が既にあれば変えない(2 回目のトリミング)", () => {
    const first = planCrop([obj(1, rectangle), obj(2, { ...stamp, styleBasis: 1234 })], crop, W, H);
    expect(first.updates[1]!.after.styleBasis).toBe(1234);
    const second = planCrop(first.objects, { x: 10, y: 10, width: 100, height: 100 }, crop.width, crop.height);
    expect(second.updates.map((u) => u.after.styleBasis)).toEqual([DIAGONAL, 1234]);
    expect(second.updates[0]!.after).toEqual({
      ...rectangle,
      rect: { x: 10, y: 20, width: 50, height: 40 },
      styleBasis: DIAGONAL,
    });
  });

  it("形が変わらない注釈(左上が原点の範囲・styleBasis 済み)は update に含めない", () => {
    const fixed: BoxShape = { ...rectangle, rect: { x: 20, y: 20, width: 30, height: 30 }, styleBasis: 900 };
    const plan = planCrop([obj(1, fixed)], { x: 0, y: 0, width: 200, height: 150 }, W, H);
    expect(plan.updates).toEqual([]);
    expect(plan.removals).toEqual([]);
    expect(plan.objects).toEqual([obj(1, fixed)]);
  });

  it("入力の配列・形を変えない", () => {
    const objects = [obj(1, rectangle), obj(2, { ...rectangle, rect: { x: 0, y: 0, width: 10, height: 10 } })];
    const copy = structuredClone(objects);
    planCrop(objects, crop, W, H);
    expect(objects).toEqual(copy);
  });
});
