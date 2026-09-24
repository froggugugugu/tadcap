import { describe, expect, it } from "vitest";

import {
  computeEllipseBoundingRect,
  computeEllipseCenterAndRadii,
  computeEllipseGeometry,
  constrainToSquare,
  ellipseLineWidth,
} from "./ellipseTool";

describe("ellipseLineWidth", () => {
  it("典型的な画像サイズ(2000x1000)では対角線比率から8pxになる(矩形と同じ算出式のローカル定数)", () => {
    expect(ellipseLineWidth(2000, 1000)).toBe(8);
  });

  it("非常に小さい画像では下限(2px)にクランプする", () => {
    expect(ellipseLineWidth(10, 10)).toBe(2);
  });

  it("非常に大きい画像では上限(14px)にクランプする", () => {
    expect(ellipseLineWidth(8000, 6000)).toBe(14);
  });

  it("外接矩形のサイズには依存しない(Canvasサイズのみで決まる)", () => {
    const canvasWidth = 2000;
    const canvasHeight = 1000;
    const small = computeEllipseGeometry(
      { x: 100, y: 100 },
      { x: 120, y: 120 },
      canvasWidth,
      canvasHeight,
    );
    const large = computeEllipseGeometry(
      { x: 0, y: 0 },
      { x: 1900, y: 900 },
      canvasWidth,
      canvasHeight,
    );

    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(small?.lineWidth).toBe(ellipseLineWidth(canvasWidth, canvasHeight));
    expect(large?.lineWidth).toBe(ellipseLineWidth(canvasWidth, canvasHeight));
    expect(small?.lineWidth).toBe(large?.lineWidth);
  });
});

describe("constrainToSquare", () => {
  const start = { x: 100, y: 100 };

  it("shiftKeyがfalseのときはendをそのまま返す", () => {
    const end = { x: 400, y: 180 };
    expect(constrainToSquare(start, end, false)).toEqual(end);
  });

  it("shiftKeyがtrueのとき、水平方向が長い場合は垂直方向を水平に合わせて正方形の外接矩形にする", () => {
    const end = { x: 400, y: 180 }; // dx=300, dy=80
    const constrained = constrainToSquare(start, end, true);
    expect(constrained.x).toBe(400); // 水平方向(長辺)はそのまま
    expect(constrained.y - start.y).toBe(300); // 垂直方向を長辺(300)に合わせる
  });

  it("shiftKeyがtrueのとき、垂直方向が長い場合は水平方向を垂直に合わせて正方形の外接矩形にする", () => {
    const end = { x: 150, y: 500 }; // dx=50, dy=400
    const constrained = constrainToSquare(start, end, true);
    expect(constrained.y).toBe(500);
    expect(constrained.x - start.x).toBe(400);
  });

  it("shiftKeyがtrueのとき、逆方向(左上へ)のドラッグでも符号を保ったまま正方形の外接矩形にする", () => {
    const end = { x: -100, y: 40 }; // dx=-200, dy=-60
    const constrained = constrainToSquare(start, end, true);
    expect(constrained.x).toBe(-100);
    expect(constrained.y - start.y).toBe(-200);
  });

  it("shiftKeyがtrueで既に正方形の外接矩形の場合は変化しない", () => {
    const end = { x: 300, y: 300 };
    expect(constrainToSquare(start, end, true)).toEqual(end);
  });
});

describe("computeEllipseCenterAndRadii", () => {
  it("外接矩形の中心・X半径・Y半径を算出する", () => {
    const result = computeEllipseCenterAndRadii({
      x: 100,
      y: 50,
      width: 300,
      height: 200,
    });
    expect(result.center).toEqual({ x: 250, y: 150 });
    expect(result.radiusX).toBe(150);
    expect(result.radiusY).toBe(100);
  });

  it("正方形の外接矩形では正円(X半径=Y半径)になる", () => {
    const result = computeEllipseCenterAndRadii({
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    });
    expect(result.radiusX).toBe(result.radiusY);
    expect(result.radiusX).toBe(100);
  });

  it("原点以外に位置する外接矩形でも中心座標が正しい", () => {
    const result = computeEllipseCenterAndRadii({
      x: -50,
      y: -20,
      width: 100,
      height: 40,
    });
    expect(result.center).toEqual({ x: 0, y: 0 });
    expect(result.radiusX).toBe(50);
    expect(result.radiusY).toBe(20);
  });
});

describe("computeEllipseGeometry", () => {
  const canvasWidth = 1000;
  const canvasHeight = 800;

  it("通常のドラッグでは正規化された外接矩形・中心・半径・線幅を返す", () => {
    const geometry = computeEllipseGeometry(
      { x: 100, y: 100 },
      { x: 400, y: 300 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry).not.toBeNull();
    expect(geometry?.rect).toEqual({ x: 100, y: 100, width: 300, height: 200 });
    expect(geometry?.center).toEqual({ x: 250, y: 200 });
    expect(geometry?.radiusX).toBe(150);
    expect(geometry?.radiusY).toBe(100);
    expect(geometry?.lineWidth).toBe(ellipseLineWidth(canvasWidth, canvasHeight));
  });

  it("右→左・下→上への逆方向ドラッグでも正規化される", () => {
    const geometry = computeEllipseGeometry(
      { x: 400, y: 300 },
      { x: 100, y: 100 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry?.rect).toEqual({ x: 100, y: 100, width: 300, height: 200 });
  });

  it("ドラッグ距離が最小しきい値(2px)未満のときはnullを返す(誤クリック対策)", () => {
    const geometry = computeEllipseGeometry(
      { x: 100, y: 100 },
      { x: 101, y: 100.5 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry).toBeNull();
  });

  it("始点と終点が同一のときはnullを返す", () => {
    const geometry = computeEllipseGeometry(
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry).toBeNull();
  });

  it("Canvasをはみ出すドラッグはCanvas範囲内へクリップされる", () => {
    const geometry = computeEllipseGeometry(
      { x: 900, y: 700 },
      { x: 1200, y: 1000 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry?.rect).toEqual({ x: 900, y: 700, width: 100, height: 100 });
  });

  it("shiftKey=trueのとき正円(外接矩形が正方形)になる", () => {
    const geometry = computeEllipseGeometry(
      { x: 100, y: 100 },
      { x: 400, y: 180 },
      canvasWidth,
      canvasHeight,
      true,
    );

    expect(geometry).not.toBeNull();
    expect(geometry?.rect.width).toBe(geometry?.rect.height);
    expect(geometry?.radiusX).toBe(geometry?.radiusY);
    expect(geometry?.rect.width).toBe(300);
  });
});

describe("computeEllipseBoundingRect", () => {
  const canvasWidth = 1000;
  const canvasHeight = 800;

  it("線の太さ分の余白を含み外接矩形全体を包含する整数矩形を返す", () => {
    const geometry = computeEllipseGeometry(
      { x: 100, y: 100 },
      { x: 400, y: 300 },
      canvasWidth,
      canvasHeight,
    );
    expect(geometry).not.toBeNull();

    const bounding = computeEllipseBoundingRect(geometry!, canvasWidth, canvasHeight);

    const { rect, lineWidth } = geometry!;
    expect(bounding.x).toBeLessThanOrEqual(rect.x);
    expect(bounding.y).toBeLessThanOrEqual(rect.y);
    expect(bounding.x + bounding.width).toBeGreaterThanOrEqual(rect.x + rect.width);
    expect(bounding.y + bounding.height).toBeGreaterThanOrEqual(rect.y + rect.height);
    // 余白が実際に加わっている(外接矩形ぴったりではない)ことも確認する。
    expect(bounding.x).toBeLessThan(rect.x);
    expect(rect.x - bounding.x).toBeGreaterThanOrEqual(lineWidth / 2);
    // 整数座標(getImageData/putImageDataへそのまま渡せること)。
    expect(Number.isInteger(bounding.x)).toBe(true);
    expect(Number.isInteger(bounding.y)).toBe(true);
    expect(Number.isInteger(bounding.width)).toBe(true);
    expect(Number.isInteger(bounding.height)).toBe(true);
  });

  it("Canvas端に近い外接矩形では包含矩形がCanvas範囲内へクリップされる", () => {
    const geometry = computeEllipseGeometry(
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      canvasWidth,
      canvasHeight,
    );
    expect(geometry).not.toBeNull();

    const bounding = computeEllipseBoundingRect(geometry!, canvasWidth, canvasHeight);

    expect(bounding.x).toBeGreaterThanOrEqual(0);
    expect(bounding.y).toBeGreaterThanOrEqual(0);
    expect(bounding.x + bounding.width).toBeLessThanOrEqual(canvasWidth);
    expect(bounding.y + bounding.height).toBeLessThanOrEqual(canvasHeight);
  });
});
