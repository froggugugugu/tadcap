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
  type TextShape,
} from "./shapeEdit";
import { textShapeBoundingRect } from "./tools/textLayout";
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

describe("decidePointerDown(T32: オブジェクト一般化)", () => {
  const base = { point: { x: 150, y: 125 }, tolerance: 8, canvasWidth: W, canvasHeight: H, color: COLOR };
  const rectObj = { id: 1, shape: rectShape };
  const arrowObj = { id: 2, shape: arrowShape };

  it("選択中のオブジェクトの内側を押すと移動セッション", () => {
    expect(
      decidePointerDown({ ...base, objects: [rectObj], selectedId: 1, activeTool: "rectangle" }),
    ).toEqual({ type: "edit", id: 1, session: { mode: "move", origin: base.point, initial: rectShape } });
  });

  it("選択中のオブジェクトのハンドルを押すとリサイズセッション", () => {
    expect(
      decidePointerDown({
        ...base,
        point: { x: 200, y: 150 },
        objects: [rectObj],
        selectedId: 1,
        activeTool: "rectangle",
      }),
    ).toEqual({ type: "edit", id: 1, session: { mode: "resize", handle: "se", initial: rectShape } });
  });

  it("未選択のオブジェクトは線の付近を押すと選択して移動セッション(ツール未選択でも)", () => {
    const point = { x: 101, y: 125 };
    for (const activeTool of ["rectangle", "arrow", null] as const) {
      expect(decidePointerDown({ ...base, point, objects: [rectObj], selectedId: null, activeTool })).toEqual({
        type: "edit",
        id: 1,
        session: { mode: "move", origin: point, initial: rectShape },
      });
    }
  });

  it("未選択の矩形の内側(線から離れた所)は掴まず、図形ツールなら新しい図形の作成", () => {
    expect(
      decidePointerDown({ ...base, objects: [rectObj], selectedId: null, activeTool: "ellipse" }),
    ).toEqual({ type: "create", session: { mode: "create", kind: "ellipse", origin: base.point, color: COLOR } });
  });

  it("重なっていれば最前面(配列の後ろ)を掴む", () => {
    const point = { x: 150, y: 150 }; // 矩形の下辺と矢印の胴体が重なる位置
    expect(
      decidePointerDown({ ...base, point, objects: [rectObj, arrowObj], selectedId: null, activeTool: null }),
    ).toMatchObject({ type: "edit", id: 2 });
    expect(
      decidePointerDown({ ...base, point, objects: [arrowObj, rectObj], selectedId: null, activeTool: null }),
    ).toMatchObject({ type: "edit", id: 1 });
  });

  it("空白を押すと、図形ツールなら作成、それ以外は選択解除(選択が無ければ何もしない)", () => {
    const point = { x: 350, y: 280 };
    expect(decidePointerDown({ ...base, point, objects: [rectObj], selectedId: 1, activeTool: "arrow" })).toEqual({
      type: "create",
      session: { mode: "create", kind: "arrow", origin: point, color: COLOR },
    });
    expect(decidePointerDown({ ...base, point, objects: [rectObj], selectedId: 1, activeTool: null })).toEqual({
      type: "deselect",
    });
    expect(decidePointerDown({ ...base, point, objects: [rectObj], selectedId: null, activeTool: null })).toEqual({
      type: "ignore",
    });
  });

  it("モザイク・テキストツール中は矢印・矩形・円を掴まず、選択解除だけ(処理は各ツール)", () => {
    for (const activeTool of ["mosaic", "text"] as const) {
      const point = { x: 101, y: 125 };
      expect(decidePointerDown({ ...base, point, objects: [rectObj], selectedId: 1, activeTool })).toEqual({
        type: "deselect",
      });
      expect(decidePointerDown({ ...base, point, objects: [rectObj], selectedId: null, activeTool })).toEqual({
        type: "ignore",
      });
    }
  });

  it("選択中のidが配列に無ければ未選択と同じに扱う", () => {
    expect(
      decidePointerDown({ ...base, objects: [], selectedId: 9, activeTool: "rectangle" }),
    ).toMatchObject({ type: "create" });
  });
});

describe("テキスト(T33)", () => {
  // 400x300 の「中」= 18px、行の高さ 23px。行ボックス = (100,50)-(140,73)。
  const textShape: TextShape = {
    kind: "text",
    text: "Hi",
    x: 100,
    top: 50,
    fontSize: "medium",
    color: COLOR,
    metrics: { width: 40, left: 0, right: 38, ascent: 13, descent: 1, fontAscent: 17, fontDescent: 4 },
  };
  const textObj = { id: 7, shape: textShape };
  const decideBase = { tolerance: 4, canvasWidth: W, canvasHeight: H, color: COLOR };

  it("ハンドルは出さない(サイズは文字サイズで変える、T34)", () => {
    expect(getShapeHandles(textShape)).toEqual([]);
  });

  it("行ボックス(+許容幅)の中が本体", () => {
    expect(hitTestShape(textShape, { x: 120, y: 60 }, 4, W, H)).toEqual({ type: "body" });
    expect(hitTestShape(textShape, { x: 142, y: 75 }, 4, W, H)).toEqual({ type: "body" });
    expect(hitTestShape(textShape, { x: 150, y: 60 }, 4, W, H)).toBeNull();
  });

  it("移動は位置だけ変え、行ボックスがCanvas外へ出ないようクランプする", () => {
    expect(moveShape(textShape, { x: 10, y: -5 }, W, H)).toEqual({ ...textShape, x: 110, top: 45 });
    expect(moveShape(textShape, { x: 1000, y: 1000 }, W, H)).toEqual({ ...textShape, x: 360, top: 277 });
    expect(moveShape(textShape, { x: -1000, y: -1000 }, W, H)).toEqual({ ...textShape, x: 0, top: 0 });
  });

  it("リサイズしても形は変わらない", () => {
    expect(resizeShape(textShape, "se", { x: 300, y: 300 }, W, H, false)).toBe(textShape);
  });

  it("取り消し・焼き込み用の外接矩形は影込みの文字の範囲", () => {
    expect(shapeUndoRect(textShape, W, H)).toEqual(textShapeBoundingRect(textShape, W, H));
  });

  it("テキストツール中はテキストだけを掴む(選択中でも未選択でも)", () => {
    const rectObj = { id: 1, shape: rectShape };
    const onText = { x: 120, y: 60 };
    expect(
      decidePointerDown({ ...decideBase, point: onText, objects: [textObj], selectedId: null, activeTool: "text" }),
    ).toEqual({ type: "edit", id: 7, session: { mode: "move", origin: onText, initial: textShape } });
    expect(
      decidePointerDown({ ...decideBase, point: onText, objects: [textObj], selectedId: 7, activeTool: "text" }),
    ).toEqual({ type: "edit", id: 7, session: { mode: "move", origin: onText, initial: textShape } });
    // 矩形の枠線上でもテキストツールでは掴まない(その位置に文字を置ける)。
    expect(
      decidePointerDown({
        ...decideBase,
        point: { x: 101, y: 125 },
        objects: [rectObj, textObj],
        selectedId: null,
        activeTool: "text",
      }),
    ).toEqual({ type: "ignore" });
  });

  it("図形ツール・ツール未選択でもテキストを掴める", () => {
    for (const activeTool of ["arrow", null] as const) {
      expect(
        decidePointerDown({ ...decideBase, point: { x: 120, y: 60 }, objects: [textObj], selectedId: null, activeTool }),
      ).toMatchObject({ type: "edit", id: 7 });
    }
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
