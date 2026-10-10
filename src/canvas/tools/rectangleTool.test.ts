import { describe, expect, it } from "vitest";

import {
  computeRectangleBoundingRect,
  computeRectangleGeometry,
  constrainToSquare,
  rectangleCornerRadius,
  rectangleLineWidth,
  rectangleLineWidthForDiagonal,
} from "./rectangleTool";
import { resizeShape, shapeUndoRect, type BoxShape } from "../shapeEdit";

describe("rectangleCornerRadius(角丸の半径、決定論的)", () => {
  it("十分大きい矩形では線幅×係数(2.5)になる", () => {
    expect(rectangleCornerRadius({ x: 0, y: 0, width: 1000, height: 500 }, 8)).toBe(20);
    expect(rectangleCornerRadius({ x: 0, y: 0, width: 1000, height: 500 }, 14)).toBe(35);
  });

  it("小さい矩形では短辺の1/4で頭打ちになる(辺の直線部分を残す)", () => {
    expect(rectangleCornerRadius({ x: 0, y: 0, width: 40, height: 24 }, 8)).toBe(6);
    expect(rectangleCornerRadius({ x: 0, y: 0, width: 24, height: 40 }, 8)).toBe(6);
  });

  it("正方形(Shift)でも同じ式で決まる", () => {
    expect(rectangleCornerRadius({ x: 0, y: 0, width: 200, height: 200 }, 8)).toBe(20);
  });

  it("幅・高さ0以下では0(負の半径にしない)", () => {
    expect(rectangleCornerRadius({ x: 0, y: 0, width: 0, height: 10 }, 8)).toBe(0);
  });
});

describe("rectangleLineWidth", () => {
  it("典型的な画像サイズ(2000x1000)では対角線比率から8pxになる(矢印と同じ考え方のローカル定数)", () => {
    expect(rectangleLineWidth(2000, 1000)).toBe(8);
  });

  it("非常に小さい画像では下限(2px)にクランプする", () => {
    expect(rectangleLineWidth(10, 10)).toBe(2);
  });

  it("非常に大きい画像では上限(14px)にクランプする", () => {
    expect(rectangleLineWidth(8000, 6000)).toBe(14);
  });

  it("矩形サイズには依存しない(Canvasサイズのみで決まる)", () => {
    const canvasWidth = 2000;
    const canvasHeight = 1000;
    const small = computeRectangleGeometry(
      { x: 100, y: 100 },
      { x: 120, y: 120 },
      canvasWidth,
      canvasHeight,
    );
    const large = computeRectangleGeometry(
      { x: 0, y: 0 },
      { x: 1900, y: 900 },
      canvasWidth,
      canvasHeight,
    );

    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(small?.lineWidth).toBe(rectangleLineWidth(canvasWidth, canvasHeight));
    expect(large?.lineWidth).toBe(rectangleLineWidth(canvasWidth, canvasHeight));
    expect(small?.lineWidth).toBe(large?.lineWidth);
  });
});

describe("constrainToSquare", () => {
  const start = { x: 100, y: 100 };

  it("shiftKeyがfalseのときはendをそのまま返す", () => {
    const end = { x: 400, y: 180 };
    expect(constrainToSquare(start, end, false)).toEqual(end);
  });

  it("shiftKeyがtrueのとき、水平方向が長い場合は垂直方向を水平に合わせて正方形にする", () => {
    const end = { x: 400, y: 180 }; // dx=300, dy=80
    const constrained = constrainToSquare(start, end, true);
    expect(constrained.x).toBe(400); // 水平方向(長辺)はそのまま
    expect(constrained.y - start.y).toBe(300); // 垂直方向を長辺(300)に合わせる
  });

  it("shiftKeyがtrueのとき、垂直方向が長い場合は水平方向を垂直に合わせて正方形にする", () => {
    const end = { x: 150, y: 500 }; // dx=50, dy=400
    const constrained = constrainToSquare(start, end, true);
    expect(constrained.y).toBe(500);
    expect(constrained.x - start.x).toBe(400);
  });

  it("shiftKeyがtrueのとき、逆方向(左上へ)のドラッグでも符号を保ったまま正方形にする", () => {
    const end = { x: -100, y: 40 }; // dx=-200, dy=-60
    const constrained = constrainToSquare(start, end, true);
    expect(constrained.x).toBe(-100);
    expect(constrained.y - start.y).toBe(-200);
  });

  it("shiftKeyがtrueで既に正方形の場合は変化しない", () => {
    const end = { x: 300, y: 300 };
    expect(constrainToSquare(start, end, true)).toEqual(end);
  });
});

describe("computeRectangleGeometry", () => {
  const canvasWidth = 1000;
  const canvasHeight = 800;

  it("通常のドラッグでは正規化された選択矩形と線幅を返す", () => {
    const geometry = computeRectangleGeometry(
      { x: 100, y: 100 },
      { x: 400, y: 300 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry).not.toBeNull();
    expect(geometry?.rect).toEqual({ x: 100, y: 100, width: 300, height: 200 });
    expect(geometry?.lineWidth).toBe(rectangleLineWidth(canvasWidth, canvasHeight));
  });

  it("右→左・下→上への逆方向ドラッグでも正規化される", () => {
    const geometry = computeRectangleGeometry(
      { x: 400, y: 300 },
      { x: 100, y: 100 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry?.rect).toEqual({ x: 100, y: 100, width: 300, height: 200 });
  });

  it("ドラッグ距離が最小しきい値(2px)未満のときはnullを返す(誤クリック対策)", () => {
    const geometry = computeRectangleGeometry(
      { x: 100, y: 100 },
      { x: 101, y: 100.5 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry).toBeNull();
  });

  it("始点と終点が同一のときはnullを返す", () => {
    const geometry = computeRectangleGeometry(
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry).toBeNull();
  });

  it("Canvasをはみ出すドラッグはCanvas範囲内へクリップされる", () => {
    const geometry = computeRectangleGeometry(
      { x: 900, y: 700 },
      { x: 1200, y: 1000 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry?.rect).toEqual({ x: 900, y: 700, width: 100, height: 100 });
  });

  it("shiftKey=trueのとき正方形の選択矩形になる", () => {
    const geometry = computeRectangleGeometry(
      { x: 100, y: 100 },
      { x: 400, y: 180 },
      canvasWidth,
      canvasHeight,
      true,
    );

    expect(geometry).not.toBeNull();
    expect(geometry?.rect.width).toBe(geometry?.rect.height);
    expect(geometry?.rect.width).toBe(300);
  });
});

describe("computeRectangleBoundingRect", () => {
  const canvasWidth = 1000;
  const canvasHeight = 800;

  it("線の太さ分の余白を含み選択矩形全体を包含する整数矩形を返す", () => {
    const geometry = computeRectangleGeometry(
      { x: 100, y: 100 },
      { x: 400, y: 300 },
      canvasWidth,
      canvasHeight,
    );
    expect(geometry).not.toBeNull();

    const bounding = computeRectangleBoundingRect(geometry!, canvasWidth, canvasHeight);

    const { rect, lineWidth } = geometry!;
    expect(bounding.x).toBeLessThanOrEqual(rect.x);
    expect(bounding.y).toBeLessThanOrEqual(rect.y);
    expect(bounding.x + bounding.width).toBeGreaterThanOrEqual(rect.x + rect.width);
    expect(bounding.y + bounding.height).toBeGreaterThanOrEqual(rect.y + rect.height);
    // 余白が実際に加わっている(選択矩形ぴったりではない)ことも確認する。
    expect(bounding.x).toBeLessThan(rect.x);
    expect(rect.x - bounding.x).toBeGreaterThanOrEqual(lineWidth / 2);
    // 整数座標(getImageData/putImageDataへそのまま渡せること)。
    expect(Number.isInteger(bounding.x)).toBe(true);
    expect(Number.isInteger(bounding.y)).toBe(true);
    expect(Number.isInteger(bounding.width)).toBe(true);
    expect(Number.isInteger(bounding.height)).toBe(true);
  });

  it("Canvas端に近い矩形では包含矩形がCanvas範囲内へクリップされる", () => {
    const geometry = computeRectangleGeometry(
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      canvasWidth,
      canvasHeight,
    );
    expect(geometry).not.toBeNull();

    const bounding = computeRectangleBoundingRect(geometry!, canvasWidth, canvasHeight);

    expect(bounding.x).toBeGreaterThanOrEqual(0);
    expect(bounding.y).toBeGreaterThanOrEqual(0);
    expect(bounding.x + bounding.width).toBeLessThanOrEqual(canvasWidth);
    expect(bounding.y + bounding.height).toBeLessThanOrEqual(canvasHeight);
  });
});

// QE-T17(ADR-002「注釈の大きさの基準」): 太さは対角線から決め、呼び出し元は`shapeStyleDiagonal()`を渡す。
describe("注釈の大きさの基準(styleBasis、QE-T17)", () => {
  const sizes: [number, number][] = [
    [10, 10],
    [300, 200],
    [400, 300],
    [1234, 567],
    [2000, 1000],
    [5120, 2880],
    [8000, 6000],
  ];
  const rect = { x: 100, y: 100, width: 100, height: 80 };
  const basis = Math.hypot(8000, 6000);

  it("rectangleLineWidthForDiagonal(hypot(幅, 高さ))は今のrectangleLineWidth(幅, 高さ)と同じ値(styleBasis無しは回帰しない)", () => {
    for (const [w, h] of sizes) {
      expect(rectangleLineWidthForDiagonal(Math.hypot(w, h))).toBe(rectangleLineWidth(w, h));
    }
  });

  it("対角線から決めるので、同じ基準なら画像の大きさによらず同じ太さ", () => {
    expect(rectangleLineWidthForDiagonal(basis)).toBe(rectangleLineWidth(8000, 6000));
    expect(rectangleLineWidthForDiagonal(basis)).not.toBe(rectangleLineWidth(400, 300));
  });

  it("shapeUndoRect: styleBasis無しは今の範囲、有りは基準の太さで見積もる", () => {
    const shape: BoxShape = { kind: "rectangle", rect, color: "#FF5C8A" };
    const expected = (lineWidth: number) =>
      computeRectangleBoundingRect(
        { ...computeRectangleGeometry({ x: 100, y: 100 }, { x: 200, y: 180 }, 400, 300)!, lineWidth },
        400,
        300,
      );
    expect(shapeUndoRect(shape, 400, 300)).toEqual(expected(rectangleLineWidth(400, 300)));
    expect(shapeUndoRect({ ...shape, styleBasis: basis }, 400, 300)).toEqual(
      expected(rectangleLineWidthForDiagonal(basis)),
    );
  });

  it("resizeShape: 大きさを変えてもstyleBasisを保つ", () => {
    const shape: BoxShape = { kind: "rectangle", rect, color: "#FF5C8A", styleBasis: basis };
    const resized = resizeShape(shape, "se", { x: 250, y: 220 }, 400, 300, false);
    expect(resized).toMatchObject({ kind: "rectangle", styleBasis: basis });
    expect(resized).not.toEqual(shape);
  });
});
