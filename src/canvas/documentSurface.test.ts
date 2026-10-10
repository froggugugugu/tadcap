import { describe, expect, it } from "vitest";

import { stampLabel } from "./documentSurface";
import type { AnnotationObject } from "./objectModel";
import type { EditableShape } from "./shapeEdit";
import { stampNumbers, type StampGlyph, type StampShape } from "./tools/stampShape";

// QE-T12: 合成のときに番号スタンプへ渡す番号(ARCH_quick-edits §5.2・§7.1 S-4)。
// 描画そのもの(Canvas API)は E2E で確かめる。

function stamp(glyph: StampGlyph = "number"): StampShape {
  return { kind: "stamp", center: { x: 50, y: 50 }, glyph, color: "#FF5C8A", fontSize: "medium" };
}

const box: EditableShape = { kind: "rectangle", rect: { x: 0, y: 0, width: 10, height: 10 }, color: "#FF5C8A" };

function objects(...shapes: EditableShape[]): AnnotationObject[] {
  return shapes.map((shape, index) => ({ id: index + 1, shape }));
}

describe("stampLabel", () => {
  it("置いてある番号スタンプは stampNumbers() の番号", () => {
    const list = objects(stamp(), stamp(), stamp());
    const numbers = stampNumbers(list);
    expect(list.map((o) => stampLabel(o.shape, o.id, numbers))).toEqual([1, 2, 3]);
  });

  it("下書きの新しい番号スタンプは「今の番号スタンプの数 + 1」", () => {
    const list = objects(stamp(), stamp(), stamp());
    expect(stampLabel(stamp(), null, stampNumbers(list))).toBe(4);
  });

  it("最初の 1 つの下書きは 1", () => {
    expect(stampLabel(stamp(), null, stampNumbers([]))).toBe(1);
  });

  it("記号スタンプ・ほかの注釈は数えないので、下書きの番号に影響しない", () => {
    const list = objects(stamp(), stamp("check"), box, stamp(), stamp("question"));
    expect(stampLabel(stamp(), null, stampNumbers(list))).toBe(3);
  });

  it("途中を消すと詰まった番号になる(2 を消すと 1・2、次の下書きは 3)", () => {
    const list = objects(stamp(), stamp(), stamp()).filter((o) => o.id !== 2);
    const numbers = stampNumbers(list);
    expect(list.map((o) => stampLabel(o.shape, o.id, numbers))).toEqual([1, 2]);
    expect(stampLabel(stamp(), null, numbers)).toBe(3);
  });

  it("移動中の下書き(既存の id)は自分の番号のまま", () => {
    const list = objects(stamp(), stamp());
    const moved: StampShape = { ...stamp(), center: { x: 80, y: 80 } };
    expect(stampLabel(moved, 2, stampNumbers(list))).toBe(2);
  });

  it("記号スタンプ・ほかの注釈には番号を渡さない(null)", () => {
    const numbers = stampNumbers(objects(stamp()));
    expect(stampLabel(stamp("check"), null, numbers)).toBeNull();
    expect(stampLabel(stamp("cross"), 5, numbers)).toBeNull();
    expect(stampLabel(box, 1, numbers)).toBeNull();
  });
});
