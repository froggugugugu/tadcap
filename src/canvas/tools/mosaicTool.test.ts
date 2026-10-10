import { afterEach, describe, expect, it, vi } from "vitest";

import type { DocumentSurface } from "../documentState";
import { resetDocument, setDocumentSurface } from "../documentState";
import { canUndo } from "../undoStack";
import {
  applyMosaicToBase,
  computeMosaicRect,
  mosaicBlockSize,
  pixelateImageData,
  pixelateRect,
} from "./mosaicTool";

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

// AM-T07【新設 2026-10-09】: 一括モザイク用に既存の`applyMosaic()`を`pixelateRect()`として公開した
// (処理・ブロックサイズの式は変えない)。VitestのNode環境には`ImageData`が無いので偽物を置く。
class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}

/** 1枚のRGBA配列を持つ偽の描画コンテキスト(読み書きした矩形を記録する)。 */
function createFakeContext(canvasWidth: number, canvasHeight: number) {
  const pixels = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
  for (let i = 0; i < pixels.length; i += 1) {
    pixels[i] = (i * 37) % 256;
  }
  const reads: number[][] = [];
  const writes: number[][] = [];
  const ctx = {
    getImageData: (x: number, y: number, width: number, height: number) => {
      reads.push([x, y, width, height]);
      const data = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row += 1) {
        const from = ((y + row) * canvasWidth + x) * 4;
        data.set(pixels.subarray(from, from + width * 4), row * width * 4);
      }
      return new FakeImageData(data, width, height);
    },
    putImageData: (image: FakeImageData, x: number, y: number) => {
      writes.push([x, y, image.width, image.height]);
      for (let row = 0; row < image.height; row += 1) {
        const from = row * image.width * 4;
        pixels.set(image.data.subarray(from, from + image.width * 4), ((y + row) * canvasWidth + x) * 4);
      }
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, pixels, reads, writes };
}


describe("pixelateRect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("矩形を整数化して読み、画像全体の対角線で決まるブロックサイズでピクセル化して書き戻す", () => {
    vi.stubGlobal("ImageData", FakeImageData);
    const W = 64;
    const H = 48;
    const { ctx, pixels, reads, writes } = createFakeContext(W, H);
    const rect = { x: 3.4, y: 5.6, width: 20.4, height: 13.5 };
    const before = createFakeContext(W, H).ctx.getImageData(3, 6, 20, 14) as unknown as FakeImageData;

    pixelateRect(ctx, rect, W, H);

    expect(reads).toEqual([[3, 6, 20, 14]]);
    expect(writes).toEqual([[3, 6, 20, 14]]);
    const expected = pixelateImageData(before.data, 20, 14, mosaicBlockSize(W, H));
    const after = ctx.getImageData(3, 6, 20, 14) as unknown as FakeImageData;
    expect(Array.from(after.data)).toEqual(Array.from(expected));
    // 矩形の外は変えない。
    expect(pixels[0]).toBe(0);
  });

  it("整数化して幅・高さが0になる矩形は読み書きしない", () => {
    vi.stubGlobal("ImageData", FakeImageData);
    const { ctx, reads, writes } = createFakeContext(16, 16);
    pixelateRect(ctx, { x: 1, y: 1, width: 0.4, height: 5 }, 16, 16);
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });
});

// QE-T18【新設】: モザイクの粗さは撮った時点の大きさ(`captureSize`)で決める(ADR-002)。
// トリミング等でベースが小さくなっても、ブロックが細かくならない(隠す強さを落とさない)。
describe("applyMosaicToBase(ベースへのモザイク、粗さは captureSize)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setDocumentSurface(null);
  });

  /** 大きさを後から変えられる偽のサーフェス。`editBase` は偽の描画コンテキストへ描く。 */
  function createResizableSurface(width: number, height: number, ctx: CanvasRenderingContext2D) {
    const size = { width, height };
    const surface: DocumentSurface = {
      size: () => ({ ...size }),
      reset: () => {},
      load: () => {},
      exportBase: () => Promise.resolve(new Blob()),
      burn: () => {},
      editBase: (draw) => draw(ctx),
      render: () => {},
      read: (r) => ({ data: new Uint8ClampedArray(r.width * r.height * 4), width: r.width, height: r.height }),
      write: () => {},
    };
    return { surface, size };
  }

  it("ベースの大きさが変わっても、撮った時点の大きさで決まるブロックでピクセル化する", () => {
    vi.stubGlobal("ImageData", FakeImageData);
    const fake = createFakeContext(64, 48);
    const before = createFakeContext(64, 48).ctx.getImageData(0, 0, 40, 40) as unknown as FakeImageData;
    const { surface, size } = createResizableSurface(2000, 1500, fake.ctx);
    setDocumentSurface(surface);
    resetDocument();
    // 撮った後にベースが小さくなった(トリミング相当)。今の大きさならブロックは下限の 12px。
    size.width = 400;
    size.height = 300;
    expect(mosaicBlockSize(2000, 1500)).toBe(20);
    expect(mosaicBlockSize(400, 300)).toBe(12);

    applyMosaicToBase({ x: 0, y: 0, width: 40, height: 40 });

    const expected = pixelateImageData(before.data, 40, 40, 20);
    const after = fake.ctx.getImageData(0, 0, 40, 40) as unknown as FakeImageData;
    expect(Array.from(after.data)).toEqual(Array.from(expected));
    expect(canUndo()).toBe(true);
  });

  it("大きさが変わっていなければ今と同じ(今の画像の大きさで決まる)", () => {
    vi.stubGlobal("ImageData", FakeImageData);
    const fake = createFakeContext(64, 48);
    const reference = createFakeContext(64, 48);
    const rect = { x: 3.4, y: 5.6, width: 20.4, height: 13.5 };
    setDocumentSurface(createResizableSurface(64, 48, fake.ctx).surface);
    resetDocument();

    applyMosaicToBase(rect);
    pixelateRect(reference.ctx, rect, 64, 48);

    expect(Array.from(fake.pixels)).toEqual(Array.from(reference.pixels));
  });

  it("サーフェスが無ければ何もしない", () => {
    setDocumentSurface(null);
    resetDocument();
    expect(() => applyMosaicToBase({ x: 0, y: 0, width: 10, height: 10 })).not.toThrow();
    expect(canUndo()).toBe(false);
  });
});
