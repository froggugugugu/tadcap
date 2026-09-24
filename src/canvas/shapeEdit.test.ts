import { describe, expect, it } from "vitest";

import {
  applyEditDrag,
  createShapeFromDrag,
  cursorForHit,
  decidePointerDown,
  getShapeHandles,
  hitTestShape,
  isShapeTool,
  moveShape,
  resizeShape,
  shapeUndoRect,
  type ArrowShape,
  type BoxShape,
} from "./shapeEdit";
import { computeTaperArrowBoundingRect, computeTaperArrowPolygon } from "./tools/arrowTool";
import { computeRectangleBoundingRect, rectangleLineWidth } from "./tools/rectangleTool";

const W = 400;
const H = 300;
const COLOR = "#FF5C8A";

const rectShape: BoxShape = {
  kind: "rectangle",
  rect: { x: 100, y: 100, width: 100, height: 50 },
  color: COLOR,
};
const ellipseShape: BoxShape = { ...rectShape, kind: "ellipse" };
const arrowShape: ArrowShape = {
  kind: "arrow",
  start: { x: 50, y: 150 },
  end: { x: 250, y: 150 },
  color: COLOR,
};

describe("isShapeTool", () => {
  it("矢印・矩形・円は編集可能な図形ツール、モザイク・未選択は対象外", () => {
    expect(isShapeTool("arrow")).toBe(true);
    expect(isShapeTool("rectangle")).toBe(true);
    expect(isShapeTool("ellipse")).toBe(true);
    expect(isShapeTool("mosaic")).toBe(false);
    expect(isShapeTool(null)).toBe(false);
  });
});

describe("createShapeFromDrag", () => {
  it("矩形: 逆方向ドラッグでも正規化された矩形になる", () => {
    const shape = createShapeFromDrag("rectangle", { x: 200, y: 150 }, { x: 100, y: 100 }, COLOR, W, H, false);
    expect(shape).toEqual(rectShape);
  });

  it("円: Shift押下時は外接矩形が正方形になる", () => {
    const shape = createShapeFromDrag("ellipse", { x: 100, y: 100 }, { x: 200, y: 150 }, COLOR, W, H, true);
    expect(shape).toEqual({ kind: "ellipse", rect: { x: 100, y: 100, width: 100, height: 100 }, color: COLOR });
  });

  it("矢印: 始点・終点をそのまま保持する", () => {
    const shape = createShapeFromDrag("arrow", arrowShape.start, arrowShape.end, COLOR, W, H, false);
    expect(shape).toEqual(arrowShape);
  });

  it("誤クリック(ほぼ移動なし)はnull", () => {
    expect(createShapeFromDrag("arrow", { x: 10, y: 10 }, { x: 11, y: 10 }, COLOR, W, H, false)).toBeNull();
    expect(createShapeFromDrag("rectangle", { x: 10, y: 10 }, { x: 11, y: 30 }, COLOR, W, H, false)).toBeNull();
  });
});

describe("getShapeHandles", () => {
  it("矩形・円は四隅の4ハンドル", () => {
    expect(getShapeHandles(rectShape)).toEqual([
      { id: "nw", point: { x: 100, y: 100 } },
      { id: "ne", point: { x: 200, y: 100 } },
      { id: "sw", point: { x: 100, y: 150 } },
      { id: "se", point: { x: 200, y: 150 } },
    ]);
    expect(getShapeHandles(ellipseShape)).toHaveLength(4);
  });

  it("矢印は始点・終点の2ハンドル", () => {
    expect(getShapeHandles(arrowShape)).toEqual([
      { id: "start", point: { x: 50, y: 150 } },
      { id: "end", point: { x: 250, y: 150 } },
    ]);
  });
});

describe("hitTestShape", () => {
  const tol = 8;

  it("ハンドル付近はハンドル(内側判定より優先)", () => {
    expect(hitTestShape(rectShape, { x: 203, y: 147 }, tol, W, H)).toEqual({ type: "handle", handle: "se" });
    expect(hitTestShape(arrowShape, { x: 52, y: 151 }, tol, W, H)).toEqual({ type: "handle", handle: "start" });
  });

  it("矩形の内側は本体(移動)", () => {
    expect(hitTestShape(rectShape, { x: 150, y: 125 }, tol, W, H)).toEqual({ type: "body" });
  });

  it("矩形の外側(許容範囲外)はnull", () => {
    expect(hitTestShape(rectShape, { x: 300, y: 250 }, tol, W, H)).toBeNull();
  });

  it("円は楕円の内側のみ本体。外接矩形の角(楕円の外)はハンドル範囲外ならnull", () => {
    expect(hitTestShape(ellipseShape, { x: 150, y: 125 }, tol, W, H)).toEqual({ type: "body" });
    expect(hitTestShape(ellipseShape, { x: 103, y: 102 }, 2, W, H)).toBeNull();
  });

  it("矢印は胴体の近くが本体、離れた点はnull", () => {
    expect(hitTestShape(arrowShape, { x: 150, y: 153 }, tol, W, H)).toEqual({ type: "body" });
    expect(hitTestShape(arrowShape, { x: 150, y: 220 }, tol, W, H)).toBeNull();
  });
});

describe("resizeShape", () => {
  it("矩形のse(右下)ハンドルをドラッグすると対角(左上)を固定してリサイズ", () => {
    const next = resizeShape(rectShape, "se", { x: 260, y: 200 }, W, H, false);
    expect(next).toEqual({ ...rectShape, rect: { x: 100, y: 100, width: 160, height: 100 } });
  });

  it("nwハンドルを対角の向こうまで引くと反転しても正規化される", () => {
    const next = resizeShape(rectShape, "nw", { x: 250, y: 180 }, W, H, false);
    expect(next).toEqual({ ...rectShape, rect: { x: 200, y: 150, width: 50, height: 30 } });
  });

  it("Shift押下時は正方形(円は正円)に拘束する", () => {
    const next = resizeShape(ellipseShape, "se", { x: 260, y: 170 }, W, H, true);
    expect(next.kind === "ellipse" && next.rect).toEqual({ x: 100, y: 100, width: 160, height: 160 });
  });

  it("小さすぎるサイズへは縮めず直前の図形を保つ", () => {
    const next = resizeShape(rectShape, "se", { x: 100.5, y: 100.5 }, W, H, false);
    expect(next).toBe(rectShape);
  });

  it("矢印の終点ハンドルで終点のみ動く", () => {
    const next = resizeShape(arrowShape, "end", { x: 300, y: 50 }, W, H, false);
    expect(next).toEqual({ ...arrowShape, end: { x: 300, y: 50 } });
  });

  it("矢印の始点を終点に重ねると直前の図形を保つ", () => {
    expect(resizeShape(arrowShape, "start", { x: 250, y: 150 }, W, H, false)).toBe(arrowShape);
  });

  it("Canvas外へのドラッグはCanvas範囲内へクランプする", () => {
    const next = resizeShape(rectShape, "se", { x: 999, y: 999 }, W, H, false);
    expect(next).toEqual({ ...rectShape, rect: { x: 100, y: 100, width: 300, height: 200 } });
  });
});

describe("moveShape", () => {
  it("矩形を平行移動する(サイズ不変)", () => {
    expect(moveShape(rectShape, { x: 30, y: -20 }, W, H)).toEqual({
      ...rectShape,
      rect: { x: 130, y: 80, width: 100, height: 50 },
    });
  });

  it("Canvas外へははみ出さないよう移動量をクランプする(形は崩れない)", () => {
    expect(moveShape(rectShape, { x: 1000, y: -1000 }, W, H)).toEqual({
      ...rectShape,
      rect: { x: 300, y: 0, width: 100, height: 50 },
    });
  });

  it("矢印は両端点を同じだけ移動し、Canvas内にクランプする", () => {
    expect(moveShape(arrowShape, { x: 10, y: 5 }, W, H)).toEqual({
      ...arrowShape,
      start: { x: 60, y: 155 },
      end: { x: 260, y: 155 },
    });
    expect(moveShape(arrowShape, { x: -500, y: 0 }, W, H)).toEqual({
      ...arrowShape,
      start: { x: 0, y: 150 },
      end: { x: 200, y: 150 },
    });
  });
});

describe("applyEditDrag", () => {
  it("create: 起点から現在点までの図形(誤クリックはnull)", () => {
    const session = { mode: "create" as const, kind: "rectangle" as const, origin: { x: 100, y: 100 }, color: COLOR };
    expect(applyEditDrag(session, { x: 200, y: 150 }, false, W, H)).toEqual(rectShape);
    expect(applyEditDrag(session, { x: 100, y: 100 }, false, W, H)).toBeNull();
  });

  it("resize: 開始時の図形に対してハンドル操作を適用", () => {
    const session = { mode: "resize" as const, handle: "se" as const, initial: rectShape };
    expect(applyEditDrag(session, { x: 260, y: 200 }, false, W, H)).toEqual({
      ...rectShape,
      rect: { x: 100, y: 100, width: 160, height: 100 },
    });
  });

  it("move: 押下点からの移動量を開始時の図形に適用", () => {
    const session = { mode: "move" as const, origin: { x: 150, y: 125 }, initial: rectShape };
    expect(applyEditDrag(session, { x: 160, y: 135 }, false, W, H)).toEqual({
      ...rectShape,
      rect: { x: 110, y: 110, width: 100, height: 50 },
    });
  });
});

describe("decidePointerDown", () => {
  const base = { point: { x: 150, y: 125 }, tolerance: 8, canvasWidth: W, canvasHeight: H, color: COLOR };

  it("編集中の図形の内側を押すと移動セッション", () => {
    expect(decidePointerDown({ ...base, pending: rectShape, activeTool: "rectangle" })).toEqual({
      type: "edit",
      session: { mode: "move", origin: base.point, initial: rectShape },
    });
  });

  it("ハンドルを押すとリサイズセッション", () => {
    expect(
      decidePointerDown({ ...base, point: { x: 200, y: 150 }, pending: rectShape, activeTool: "rectangle" }),
    ).toEqual({ type: "edit", session: { mode: "resize", handle: "se", initial: rectShape } });
  });

  it("空白部分を押すと編集中の図形を確定してから新しい図形の作成を始める", () => {
    expect(
      decidePointerDown({ ...base, point: { x: 350, y: 280 }, pending: rectShape, activeTool: "rectangle" }),
    ).toEqual({
      type: "create",
      commitFirst: true,
      session: { mode: "create", kind: "rectangle", origin: { x: 350, y: 280 }, color: COLOR },
    });
  });

  it("編集中の図形が無ければそのまま作成", () => {
    expect(decidePointerDown({ ...base, pending: null, activeTool: "arrow" })).toEqual({
      type: "create",
      commitFirst: false,
      session: { mode: "create", kind: "arrow", origin: base.point, color: COLOR },
    });
  });

  it("図形ツール以外(モザイク・未選択)では何もしない(編集中の図形があれば確定のみ)", () => {
    expect(decidePointerDown({ ...base, pending: null, activeTool: "mosaic" })).toEqual({ type: "ignore" });
    expect(
      decidePointerDown({ ...base, point: { x: 350, y: 280 }, pending: rectShape, activeTool: null }),
    ).toEqual({ type: "commit" });
  });
});

describe("shapeUndoRect", () => {
  it("矩形は既存computeRectangleBoundingRect()と同じ(線幅の余白込み)", () => {
    expect(shapeUndoRect(rectShape, W, H)).toEqual(
      computeRectangleBoundingRect(
        { rect: rectShape.rect, lineWidth: rectangleLineWidth(W, H) },
        W,
        H,
      ),
    );
  });

  it("矢印は既存computeTaperArrowBoundingRect()と同じ", () => {
    const polygon = computeTaperArrowPolygon(arrowShape.start, arrowShape.end, W, H)!;
    expect(shapeUndoRect(arrowShape, W, H)).toEqual(computeTaperArrowBoundingRect(polygon, W, H));
  });
});

describe("cursorForHit", () => {
  it("ハンドル・本体に応じたカーソル、外はnull", () => {
    expect(cursorForHit({ type: "handle", handle: "nw" })).toBe("nwse-resize");
    expect(cursorForHit({ type: "handle", handle: "se" })).toBe("nwse-resize");
    expect(cursorForHit({ type: "handle", handle: "ne" })).toBe("nesw-resize");
    expect(cursorForHit({ type: "handle", handle: "sw" })).toBe("nesw-resize");
    expect(cursorForHit({ type: "handle", handle: "end" })).toBe("crosshair");
    expect(cursorForHit({ type: "body" })).toBe("move");
    expect(cursorForHit(null)).toBeNull();
  });
});
