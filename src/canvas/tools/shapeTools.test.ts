import { describe, expect, it, vi } from "vitest";

import type { AnnotationObject } from "../objectModel";
import type { EditableShape } from "../shapeEdit";
import { addShapeOrNotifyLimit, placedStamp } from "./shapeTools";
import { stampDiameter } from "./stampShape";

// QE-T12: スタンプを置く位置と、50 個の上限の通知(ARCH_quick-edits §7.1 S、UI_quick-edits §6)。
// ポインタの結線(DOM)は E2E で確かめる。

const style = { glyph: "number", color: "#FF5C8A", fontSize: "medium" } as const;

describe("placedStamp", () => {
  it("押した位置を中心に、種類・色・文字サイズを持つスタンプを作る", () => {
    expect(placedStamp({ x: 500, y: 300 }, style, 1000, 600)).toEqual({
      kind: "stamp",
      center: { x: 500, y: 300 },
      glyph: "number",
      color: "#FF5C8A",
      fontSize: "medium",
    });
  });

  it("記号の種類もそのまま持つ", () => {
    expect(placedStamp({ x: 500, y: 300 }, { ...style, glyph: "check" }, 1000, 600).glyph).toBe("check");
  });

  it("画像の端で押しても、中心を半径の分だけ内側に収める", () => {
    const radius = stampDiameter("medium", Math.hypot(1000, 600)) / 2;
    expect(placedStamp({ x: 0, y: 0 }, style, 1000, 600).center).toEqual({ x: radius, y: radius });
    expect(placedStamp({ x: 1000, y: 600 }, style, 1000, 600).center).toEqual({
      x: 1000 - radius,
      y: 600 - radius,
    });
  });
});

describe("placedStamp: 置く位置の収め方(moveShape の移動範囲とは別)", () => {
  it("画像の端で押しても、移動の範囲(はみ出しを増やさない)ではなく中心を内側に収める", () => {
    const radius = stampDiameter("medium", Math.hypot(1000, 600)) / 2;
    expect(placedStamp({ x: 3, y: 600 }, style, 1000, 600).center).toEqual({ x: radius, y: 600 - radius });
  });

  it("直径が画像より大きいときは、その向きの中央に置く(範囲が逆転しない)", () => {
    const diameter = stampDiameter("large", Math.hypot(30, 600));
    expect(diameter).toBeGreaterThan(30);
    expect(placedStamp({ x: 0, y: 300 }, { ...style, fontSize: "large" }, 30, 600).center).toEqual({ x: 15, y: 300 });
  });
});

describe("addShapeOrNotifyLimit", () => {
  const shape: EditableShape = { kind: "rectangle", rect: { x: 0, y: 0, width: 10, height: 10 }, color: "#FF5C8A" };

  it("上限で追加されなければ(null)onObjectLimit を 1 回呼び、null を返す", () => {
    const add = vi.fn((): AnnotationObject | null => null);
    const onObjectLimit = vi.fn();
    expect(addShapeOrNotifyLimit(shape, onObjectLimit, add)).toBeNull();
    expect(add).toHaveBeenCalledWith(shape);
    expect(onObjectLimit).toHaveBeenCalledTimes(1);
  });

  it("追加できたら通知せず、追加したオブジェクトを返す", () => {
    const object: AnnotationObject = { id: 7, shape };
    const onObjectLimit = vi.fn();
    expect(addShapeOrNotifyLimit(shape, onObjectLimit, () => object)).toBe(object);
    expect(onObjectLimit).not.toHaveBeenCalled();
  });

  it("通知先が無くても落ちない", () => {
    expect(addShapeOrNotifyLimit(shape, undefined, () => null)).toBeNull();
  });
});
