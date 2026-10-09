import { describe, expect, it } from "vitest";

import type { Rect } from "./coords";
import { SPOTLIGHT_SHADE, spotlightShadeRects } from "./spotlight";

/** 2 つの矩形が正の面積で重なるか(辺が接するだけなら重ならない)。 */
function overlaps(a: Rect, b: Rect): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
  );
}

function area(rects: readonly Rect[]): number {
  return rects.reduce((sum, r) => sum + r.width * r.height, 0);
}

function contains(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height;
}

/** 固定シードの擬似乱数(mulberry32)。テストの再現性のため。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("SPOTLIGHT_SHADE", () => {
  it("黒 50% の 1 色(UI §3.1)", () => {
    expect(SPOTLIGHT_SHADE).toBe("rgba(0, 0, 0, 0.5)");
  });
});

describe("spotlightShadeRects", () => {
  it("穴 0 個なら画像全体の 1 矩形を返す", () => {
    expect(spotlightShadeRects([], 200, 100)).toEqual([{ x: 0, y: 0, width: 200, height: 100 }]);
  });

  it("画像の大きさが 0 なら何も返さない", () => {
    expect(spotlightShadeRects([], 0, 100)).toEqual([]);
    expect(spotlightShadeRects([{ x: 0, y: 0, width: 10, height: 10 }], 100, 0)).toEqual([]);
  });

  it("穴 1 個なら補集合(上の帯・左右・下の帯)を返す", () => {
    const rects = spotlightShadeRects([{ x: 20, y: 10, width: 30, height: 40 }], 100, 80);
    expect(rects).toEqual([
      { x: 0, y: 0, width: 100, height: 10 },
      { x: 0, y: 10, width: 20, height: 40 },
      { x: 50, y: 10, width: 50, height: 40 },
      { x: 0, y: 50, width: 100, height: 30 },
    ]);
  });

  it("画像全体を覆う穴なら何も返さない", () => {
    expect(spotlightShadeRects([{ x: 0, y: 0, width: 100, height: 80 }], 100, 80)).toEqual([]);
  });

  it("2 個の穴が重なっても、重なった所は塗らず、返す矩形は互いに重ならない", () => {
    const holes = [
      { x: 10, y: 10, width: 40, height: 40 },
      { x: 30, y: 30, width: 40, height: 40 },
    ];
    const rects = spotlightShadeRects(holes, 100, 100);
    // 穴の和 = 1600 + 1600 − 400(重なり) = 2800
    expect(area(rects)).toBe(100 * 100 - 2800);
    for (const r of rects) {
      for (const h of holes) expect(overlaps(r, h)).toBe(false);
    }
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) expect(overlaps(rects[i], rects[j])).toBe(false);
    }
  });

  it("2 個の穴が接していれば、その間に幅 0 の矩形を出さない", () => {
    const rects = spotlightShadeRects(
      [
        { x: 10, y: 10, width: 20, height: 20 },
        { x: 30, y: 10, width: 20, height: 20 },
      ],
      60,
      40,
    );
    expect(rects).toEqual([
      { x: 0, y: 0, width: 60, height: 10 },
      { x: 0, y: 10, width: 10, height: 20 },
      { x: 50, y: 10, width: 10, height: 20 },
      { x: 0, y: 30, width: 60, height: 10 },
    ]);
  });

  it("2 個の穴が離れていれば、間の暗さを横につないで返す", () => {
    const rects = spotlightShadeRects(
      [
        { x: 10, y: 10, width: 10, height: 10 },
        { x: 40, y: 10, width: 10, height: 10 },
      ],
      60,
      30,
    );
    expect(rects).toEqual([
      { x: 0, y: 0, width: 60, height: 10 },
      { x: 0, y: 10, width: 10, height: 10 },
      { x: 20, y: 10, width: 20, height: 10 },
      { x: 50, y: 10, width: 10, height: 10 },
      { x: 0, y: 20, width: 60, height: 10 },
    ]);
  });

  it("画像の外へはみ出した穴は画像に切り詰める", () => {
    const rects = spotlightShadeRects([{ x: -20, y: 50, width: 60, height: 100 }], 100, 80);
    expect(rects).toEqual([
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 40, y: 50, width: 60, height: 30 },
    ]);
  });

  it("画像の完全に外にある穴・大きさ 0 の穴は無視する", () => {
    const rects = spotlightShadeRects(
      [
        { x: 200, y: 200, width: 10, height: 10 },
        { x: -50, y: 10, width: 20, height: 20 },
        { x: 10, y: 10, width: 0, height: 20 },
      ],
      100,
      80,
    );
    expect(rects).toEqual([{ x: 0, y: 0, width: 100, height: 80 }]);
  });

  it("端数の座標はそのまま区切りに使い、和が補集合の面積と一致する", () => {
    const hole = { x: 10.25, y: 5.5, width: 20.5, height: 10.75 };
    const rects = spotlightShadeRects([hole], 50.5, 30.25);
    expect(rects).toEqual([
      { x: 0, y: 0, width: 50.5, height: 5.5 },
      { x: 0, y: 5.5, width: 10.25, height: 10.75 },
      { x: 30.75, y: 5.5, width: 19.75, height: 10.75 },
      { x: 0, y: 16.25, width: 50.5, height: 14 },
    ]);
    expect(area(rects)).toBeCloseTo(50.5 * 30.25 - 20.5 * 10.75, 9);
  });

  it("同じ入力なら同じ順序で返す(決定論的。上の帯から、帯の中は左から)", () => {
    const holes = [
      { x: 40, y: 40, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 },
    ];
    const a = spotlightShadeRects(holes, 60, 60);
    const b = spotlightShadeRects([...holes].reverse(), 60, 60);
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i += 1) {
      const prev = a[i - 1];
      const cur = a[i];
      expect(cur.y > prev.y || (cur.y === prev.y && cur.x >= prev.x + prev.width)).toBe(true);
    }
  });

  describe("性質テスト(固定シードの乱数の穴 1〜50 個)", () => {
    const W = 120;
    const H = 90;

    function randomHoles(rand: () => number, count: number): Rect[] {
      const holes: Rect[] = [];
      for (let i = 0; i < count; i += 1) {
        // 画像の外へのはみ出しも混ぜる(-20〜W+20)
        const x = Math.floor(rand() * (W + 40)) - 20;
        const y = Math.floor(rand() * (H + 40)) - 20;
        const width = Math.floor(rand() * 50);
        const height = Math.floor(rand() * 40);
        holes.push({ x, y, width, height });
      }
      return holes;
    }

    for (let count = 1; count <= 50; count += 1) {
      it(`穴 ${count} 個: 画素ごとに「穴の中なら 0 個・外なら 1 個」の矩形が覆う`, () => {
        const rand = mulberry32(0x5eed + count);
        const holes = randomHoles(rand, count);
        const rects = spotlightShadeRects(holes, W, H);

        // 互いに重ならない
        for (let i = 0; i < rects.length; i += 1) {
          for (let j = i + 1; j < rects.length; j += 1) expect(overlaps(rects[i], rects[j])).toBe(false);
        }
        // どの穴とも重ならず、画像の中に収まり、大きさが正
        for (const r of rects) {
          expect(r.width).toBeGreaterThan(0);
          expect(r.height).toBeGreaterThan(0);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.width).toBeLessThanOrEqual(W);
          expect(r.y + r.height).toBeLessThanOrEqual(H);
          for (const h of holes) expect(overlaps(r, h)).toBe(false);
        }
        // 面積の和 = 画像 − 穴の和(画素の中心で数える独立の計算)
        let outside = 0;
        for (let py = 0; py < H; py += 1) {
          for (let px = 0; px < W; px += 1) {
            const cx = px + 0.5;
            const cy = py + 0.5;
            const inHole = holes.some((h) => contains(h, cx, cy));
            const covering = rects.filter((r) => contains(r, cx, cy)).length;
            expect(covering).toBe(inHole ? 0 : 1);
            if (!inHole) outside += 1;
          }
        }
        expect(area(rects)).toBe(outside);
        // 矩形の数の上限
        expect(rects.length).toBeLessThanOrEqual((2 * count + 1) ** 2);
      });
    }
  });
});
