import { describe, expect, it } from "vitest";
import { shapeStyleDiagonal } from "./styleBasis";

describe("shapeStyleDiagonal", () => {
  it("styleBasis が無いときは今の画像の対角線を返す", () => {
    expect(shapeStyleDiagonal({}, 3, 4)).toBe(5);
    expect(shapeStyleDiagonal({ styleBasis: undefined }, 2080, 1204)).toBe(Math.hypot(2080, 1204));
  });

  it("styleBasis が有るときは画像の大きさによらずその値を返す", () => {
    expect(shapeStyleDiagonal({ styleBasis: 3396 }, 1200, 800)).toBe(3396);
    expect(shapeStyleDiagonal({ styleBasis: 3396 }, 10, 10)).toBe(3396);
  });

  it("同じ入力で同じ値を返す(決定論的)", () => {
    const a = shapeStyleDiagonal({}, 2880, 1800);
    const b = shapeStyleDiagonal({}, 2880, 1800);
    expect(a).toBe(b);
  });
});
