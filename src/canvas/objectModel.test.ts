import { describe, expect, it } from "vitest";

import {
  OBJECT_LIMIT,
  findObject,
  hitTestObjectOutline,
  insertObject,
  moveObjectToIndex,
  pickObjectAt,
  removeObject,
  replaceObjectShape,
  type AnnotationObject,
} from "./objectModel";
import type { ArrowShape, BoxShape } from "./shapeEdit";

const W = 400;
const H = 300;
const COLOR = "#FF5C8A";

const rect: BoxShape = { kind: "rectangle", rect: { x: 100, y: 100, width: 100, height: 60 }, color: COLOR };
const ellipse: BoxShape = { ...rect, kind: "ellipse" };
const arrow: ArrowShape = { kind: "arrow", start: { x: 50, y: 250 }, end: { x: 250, y: 250 }, color: COLOR };

const obj = (id: number, shape: AnnotationObject["shape"]): AnnotationObject => ({ id, shape });

describe("OBJECT_LIMIT", () => {
  it("1画像あたりのオブジェクト上限は50個", () => {
    expect(OBJECT_LIMIT).toBe(50);
  });
});

describe("insertObject / removeObject / replaceObjectShape / findObject", () => {
  const a = obj(1, rect);
  const b = obj(2, ellipse);

  it("指定位置へ挿入する(元の配列は変えない)", () => {
    const objects = [a];
    expect(insertObject(objects, b, 0)).toEqual([b, a]);
    expect(insertObject(objects, b, 1)).toEqual([a, b]);
    expect(objects).toEqual([a]);
  });

  it("範囲外の位置は末尾・先頭へ丸める", () => {
    expect(insertObject([a], b, 99)).toEqual([a, b]);
    expect(insertObject([a], b, -1)).toEqual([b, a]);
  });

  it("idで除去・形の置き換え・検索ができ、無いidは何もしない", () => {
    expect(removeObject([a, b], 1)).toEqual([b]);
    expect(removeObject([a, b], 9)).toEqual([a, b]);
    expect(replaceObjectShape([a, b], 2, arrow)).toEqual([a, obj(2, arrow)]);
    expect(replaceObjectShape([a], 9, arrow)).toEqual([a]);
    expect(findObject([a, b], 2)).toBe(b);
    expect(findObject([a, b], 9)).toBeUndefined();
  });
});

describe("moveObjectToIndex(重ね順の変更、T34)", () => {
  const a = obj(1, rect);
  const b = obj(2, ellipse);
  const c = obj(3, arrow);
  it("指定位置へ移し、範囲外は先頭・末尾へ丸める。無いidは何もしない", () => {
    expect(moveObjectToIndex([a, b, c], 1, 2)).toEqual([b, c, a]);
    expect(moveObjectToIndex([a, b, c], 3, 0)).toEqual([c, a, b]);
    expect(moveObjectToIndex([a, b, c], 2, 99)).toEqual([a, c, b]);
    expect(moveObjectToIndex([a, b, c], 9, 0)).toEqual([a, b, c]);
  });
});

describe("hitTestObjectOutline(未選択オブジェクトの掴める範囲)", () => {
  it("矩形は枠線の付近だけ当たり、内側の中央は当たらない(大きな枠の中に新しい図形を描けるように)", () => {
    expect(hitTestObjectOutline(rect, { x: 102, y: 130 }, 6, W, H)).toBe(true);
    expect(hitTestObjectOutline(rect, { x: 150, y: 158 }, 6, W, H)).toBe(true);
    expect(hitTestObjectOutline(rect, { x: 150, y: 130 }, 6, W, H)).toBe(false);
    expect(hitTestObjectOutline(rect, { x: 60, y: 130 }, 6, W, H)).toBe(false);
  });

  it("矩形は角丸なので、外接矩形の角の外側(丸めた線から離れた所)は当たらない", () => {
    // rect(100,100,100,60)・線幅2px → 角の半径 min(2×2.5, 60/4)=5。掴める幅 = 線幅2 + 許容6 = 8。
    // 角の円弧の中心は(105,105)。(93,93)は円弧から約12px離れる(角丸でなければ掴めた位置)。
    expect(hitTestObjectOutline(rect, { x: 93, y: 93 }, 6, W, H)).toBe(false);
    // 円弧上(45°)とその少し外側は当たる。
    expect(hitTestObjectOutline(rect, { x: 101.5, y: 101.5 }, 6, W, H)).toBe(true);
    expect(hitTestObjectOutline(rect, { x: 97, y: 97 }, 6, W, H)).toBe(true);
    // 右下の角も同じ(対称)。
    expect(hitTestObjectOutline(rect, { x: 207, y: 167 }, 6, W, H)).toBe(false);
    expect(hitTestObjectOutline(rect, { x: 198.5, y: 158.5 }, 6, W, H)).toBe(true);
  });

  it("円は楕円の線の付近だけ当たる", () => {
    // 中心(150,130)、半径(50,30)。右端(200,130)・上端(150,100)は線上。
    expect(hitTestObjectOutline(ellipse, { x: 199, y: 130 }, 6, W, H)).toBe(true);
    expect(hitTestObjectOutline(ellipse, { x: 150, y: 101 }, 6, W, H)).toBe(true);
    expect(hitTestObjectOutline(ellipse, { x: 150, y: 130 }, 6, W, H)).toBe(false);
    // 外接矩形の角は楕円から離れているので当たらない。
    expect(hitTestObjectOutline(ellipse, { x: 101, y: 101 }, 6, W, H)).toBe(false);
  });

  it("矢印は胴体(始点→終点の線分)の付近で当たる", () => {
    expect(hitTestObjectOutline(arrow, { x: 150, y: 252 }, 6, W, H)).toBe(true);
    expect(hitTestObjectOutline(arrow, { x: 150, y: 200 }, 6, W, H)).toBe(false);
  });
});

describe("hitTestObjectOutline(テキスト、T33)", () => {
  it("テキストは行ボックス全体で掴める(文字の間の隙間でも)", () => {
    const text = {
      kind: "text" as const,
      text: "Hi",
      x: 100,
      top: 50,
      fontSize: "medium" as const,
      color: COLOR,
      metrics: { width: 40, left: 0, right: 38, ascent: 13, descent: 1, fontAscent: 17, fontDescent: 4 },
    };
    expect(hitTestObjectOutline(text, { x: 120, y: 60 }, 4, W, H)).toBe(true);
    expect(hitTestObjectOutline(text, { x: 200, y: 60 }, 4, W, H)).toBe(false);
  });
});

describe("pickObjectAt(最前面から当たり判定)", () => {
  it("重なっていれば後から描いた(配列の後ろの)オブジェクトを返す", () => {
    const lower = obj(1, rect);
    const upper = obj(2, { ...rect, rect: { x: 100, y: 100, width: 50, height: 40 } });
    expect(pickObjectAt([lower, upper], { x: 101, y: 120 }, 6, W, H)).toBe(upper);
    expect(pickObjectAt([upper, lower], { x: 101, y: 120 }, 6, W, H)).toBe(lower);
  });

  it("どれにも当たらなければnull", () => {
    expect(pickObjectAt([obj(1, rect), obj(2, arrow)], { x: 350, y: 20 }, 6, W, H)).toBeNull();
    expect(pickObjectAt([], { x: 0, y: 0 }, 6, W, H)).toBeNull();
  });
});
