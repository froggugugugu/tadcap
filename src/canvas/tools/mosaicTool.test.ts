import { describe, expect, it } from "vitest";

import { computeMosaicRect, mosaicBlockSize, pixelateImageData } from "./mosaicTool";

// T20【改訂 2026-09-24】: `normalizeRect`/`clipRectToCanvas` 自体のテストは
// `../coords.test.ts` へ移設した(定義本体を `coords.ts` へ移設したため)。
// `computeMosaicRect()` は移設後の関数を利用する側としてここに残す。
describe("computeMosaicRect", () => {
  const canvasWidth = 1000;
  const canvasHeight = 800;

  it("逆方向ドラッグを正規化しつつ、はみ出しをクリップした矩形を返す", () => {
    const rect = computeMosaicRect(
      { x: 950, y: 780 },
      { x: 800, y: 700 },
      canvasWidth,
      canvasHeight,
    );
    expect(rect).toEqual({ x: 800, y: 700, width: 150, height: 80 });
  });

  it("ドラッグ距離が最小しきい値(2px)未満のときはnullを返す(誤クリック対策)", () => {
    const rect = computeMosaicRect(
      { x: 100, y: 100 },
      { x: 101, y: 100 },
      canvasWidth,
      canvasHeight,
    );
    expect(rect).toBeNull();
  });

  it("始点と終点が同一のときはnullを返す", () => {
    const rect = computeMosaicRect(
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      canvasWidth,
      canvasHeight,
    );
    expect(rect).toBeNull();
  });
});

describe("mosaicBlockSize", () => {
  it("典型的な画像サイズ(2000x1000)では対角線比率から18pxになる", () => {
    expect(mosaicBlockSize(2000, 1000)).toBe(18);
  });

  it("5K Retina相当(5120x2880)では対角線比率から47pxになる(上限未達)", () => {
    expect(mosaicBlockSize(5120, 2880)).toBe(47);
  });

  it("非常に小さい画像・矩形でも下限(12px)を下回らない(判読不可能性の保証)", () => {
    expect(mosaicBlockSize(50, 50)).toBe(12);
  });

  it("非常に大きい画像では上限(64px)にクランプする", () => {
    expect(mosaicBlockSize(8000, 6000)).toBe(64);
  });
});

describe("pixelateImageData", () => {
  it("単一ブロック(2x2)内のRGBA各チャンネルを平均化する", () => {
    // (0,0)=(10,20,30,255) (1,0)=(20,30,40,255)
    // (0,1)=(30,40,50,255) (1,1)=(40,50,60,255)
    // eslint 非導入のため手計算: R平均=25 G平均=35 B平均=45 A平均=255
    const data = new Uint8ClampedArray([
      10, 20, 30, 255, 20, 30, 40, 255,
      30, 40, 50, 255, 40, 50, 60, 255,
    ]);

    const result = pixelateImageData(data, 2, 2, 2);

    expect(Array.from(result)).toEqual([
      25, 35, 45, 255, 25, 35, 45, 255,
      25, 35, 45, 255, 25, 35, 45, 255,
    ]);
  });

  it("ブロックサイズで割り切れない端数ブロックも正しく平均化する(幅3・ブロック2)", () => {
    // x=[0,1]が1ブロック(平均)、x=[2]が端数の1px単独ブロック(そのまま)
    const data = new Uint8ClampedArray([
      10, 0, 0, 255, 30, 0, 0, 255, 100, 0, 0, 255,
    ]);

    const result = pixelateImageData(data, 3, 1, 2);

    expect(Array.from(result)).toEqual([
      20, 0, 0, 255, 20, 0, 0, 255, 100, 0, 0, 255,
    ]);
  });

  it("単色画像は変化しない", () => {
    const data = new Uint8ClampedArray([
      5, 5, 5, 255, 5, 5, 5, 255, 5, 5, 5, 255, 5, 5, 5, 255,
    ]);

    const result = pixelateImageData(data, 2, 2, 2);

    expect(Array.from(result)).toEqual(Array.from(data));
  });

  it("入力配列を変更しない(純粋関数であること)", () => {
    const data = new Uint8ClampedArray([
      10, 20, 30, 255, 20, 30, 40, 255,
      30, 40, 50, 255, 40, 50, 60, 255,
    ]);
    const original = Array.from(data);

    pixelateImageData(data, 2, 2, 2);

    expect(Array.from(data)).toEqual(original);
  });

  it("ブロックサイズが矩形サイズより大きい場合は矩形全体を1ブロックとして平均化する", () => {
    const data = new Uint8ClampedArray([
      0, 0, 0, 255, 100, 100, 100, 255,
    ]);

    const result = pixelateImageData(data, 2, 1, 50);

    expect(Array.from(result)).toEqual([
      50, 50, 50, 255, 50, 50, 50, 255,
    ]);
  });
});

// T25【改訂 2026-09-24】: `cropSnapshotRect()`/`roundRect()`のテストは`../coords.test.ts`へ
// 移設した(定義本体を`coords.ts`へ移設したため。矩形ツールが3ファイル目の利用者になり
// Rule of Threeで集約、PJM指示)。
