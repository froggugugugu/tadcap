import { describe, expect, it } from "vitest";

import {
  clientToCanvasPoint,
  clipRectToCanvas,
  cropSnapshotRect,
  normalizeRect,
  roundRect,
} from "./coords";

describe("clientToCanvasPoint", () => {
  it("表示サイズと画像実サイズが同じ(等倍)ならCSS座標をそのままCanvas座標として返す", () => {
    const point = clientToCanvasPoint({
      clientX: 400,
      clientY: 300,
      rectLeft: 0,
      rectTop: 0,
      rectWidth: 800,
      rectHeight: 600,
      canvasWidth: 800,
      canvasHeight: 600,
    });

    expect(point).toEqual({ x: 400, y: 300 });
  });

  it("表示サイズがCanvas実サイズの半分(縮小表示)なら2倍に拡大して変換する", () => {
    const point = clientToCanvasPoint({
      clientX: 200,
      clientY: 150,
      rectLeft: 0,
      rectTop: 0,
      rectWidth: 400,
      rectHeight: 300,
      canvasWidth: 800,
      canvasHeight: 600,
    });

    expect(point).toEqual({ x: 400, y: 300 });
  });

  it("Canvasがページ原点からオフセットしている場合、rectLeft/rectTopを差し引く", () => {
    const point = clientToCanvasPoint({
      clientX: 450,
      clientY: 320,
      rectLeft: 50,
      rectTop: 20,
      rectWidth: 800,
      rectHeight: 600,
      canvasWidth: 800,
      canvasHeight: 600,
    });

    expect(point).toEqual({ x: 400, y: 300 });
  });

  it("Canvas範囲外(右下方向)に出たポインタ座標は[0, canvasサイズ]にクランプする", () => {
    const point = clientToCanvasPoint({
      clientX: 850,
      clientY: 650,
      rectLeft: 0,
      rectTop: 0,
      rectWidth: 800,
      rectHeight: 600,
      canvasWidth: 800,
      canvasHeight: 600,
    });

    expect(point).toEqual({ x: 800, y: 600 });
  });

  it("Canvas範囲外(左上方向)に出たポインタ座標は0にクランプする", () => {
    const point = clientToCanvasPoint({
      clientX: -50,
      clientY: -20,
      rectLeft: 0,
      rectTop: 0,
      rectWidth: 800,
      rectHeight: 600,
      canvasWidth: 800,
      canvasHeight: 600,
    });

    expect(point).toEqual({ x: 0, y: 0 });
  });

  it("表示サイズが0(未描画・非表示)のときはスケール不能なので{x:0, y:0}を返す", () => {
    const point = clientToCanvasPoint({
      clientX: 100,
      clientY: 100,
      rectLeft: 0,
      rectTop: 0,
      rectWidth: 0,
      rectHeight: 0,
      canvasWidth: 800,
      canvasHeight: 600,
    });

    expect(point).toEqual({ x: 0, y: 0 });
  });
});

// T20【改訂 2026-09-24】: `tools/mosaicTool.test.ts` から移設(挙動不変)。
describe("normalizeRect", () => {
  it("左上→右下への通常ドラッグではそのままの矩形になる", () => {
    expect(normalizeRect({ x: 100, y: 100 }, { x: 500, y: 400 })).toEqual({
      x: 100,
      y: 100,
      width: 400,
      height: 300,
    });
  });

  it("右→左・下→上への逆方向ドラッグでも正しく正規化される", () => {
    expect(normalizeRect({ x: 500, y: 400 }, { x: 100, y: 100 })).toEqual({
      x: 100,
      y: 100,
      width: 400,
      height: 300,
    });
  });

  it("水平方向のみ逆方向のドラッグを正規化する", () => {
    expect(normalizeRect({ x: 500, y: 100 }, { x: 100, y: 400 })).toEqual({
      x: 100,
      y: 100,
      width: 400,
      height: 300,
    });
  });
});

describe("clipRectToCanvas", () => {
  const canvasWidth = 1000;
  const canvasHeight = 800;

  it("Canvas内に完全に収まる矩形はそのまま返す", () => {
    const rect = { x: 100, y: 100, width: 200, height: 150 };
    expect(clipRectToCanvas(rect, canvasWidth, canvasHeight)).toEqual(rect);
  });

  it("右・下にはみ出す矩形は Canvas 境界でクリップする", () => {
    const rect = { x: 900, y: 700, width: 300, height: 300 };
    expect(clipRectToCanvas(rect, canvasWidth, canvasHeight)).toEqual({
      x: 900,
      y: 700,
      width: 100,
      height: 100,
    });
  });

  it("左・上に負の座標ではみ出す矩形は原点にクリップし幅・高さを縮小する", () => {
    const rect = { x: -50, y: -30, width: 200, height: 100 };
    expect(clipRectToCanvas(rect, canvasWidth, canvasHeight)).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 70,
    });
  });

  it("Canvas外に完全にはみ出す矩形は幅・高さ0になる", () => {
    const rect = { x: 1200, y: 900, width: 100, height: 100 };
    expect(clipRectToCanvas(rect, canvasWidth, canvasHeight)).toEqual({
      x: 1000,
      y: 800,
      width: 0,
      height: 0,
    });
  });
});

// T25【改訂 2026-09-24】: `tools/mosaicTool.test.ts` から移設(挙動不変。Rule of Threeで
// `roundRect()`本体を`coords.ts`へ集約したため)。
describe("roundRect", () => {
  it("各フィールドを最も近い整数へ丸める", () => {
    expect(roundRect({ x: 10.4, y: 10.6, width: 5.5, height: 5.49 })).toEqual({
      x: 10,
      y: 11,
      width: 6,
      height: 5,
    });
  });

  it("負値にならないようwidth/heightを0以上にクランプする", () => {
    expect(roundRect({ x: 0, y: 0, width: -1, height: -0.4 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

// T25【改訂 2026-09-24】: `tools/arrowTool.test.ts`/`tools/mosaicTool.test.ts` から移設
// (挙動不変。Rule of Threeで`cropSnapshotRect()`本体を`coords.ts`へ集約したため)。
describe("cropSnapshotRect", () => {
  it("スナップショット全体からrect領域分のピクセルのみを切り出す(追加のgetImageData無しでUndoのbeforeを得る、ARCH §5.2)", () => {
    const width = 4;
    const height = 4;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        data[idx] = y * width + x; // Rチャンネルへ通し番号を書き、切り出し元を識別する
        data[idx + 3] = 255;
      }
    }

    const cropped = cropSnapshotRect(data, width, height, {
      x: 1,
      y: 1,
      width: 2,
      height: 2,
    });

    expect(cropped.width).toBe(2);
    expect(cropped.height).toBe(2);
    // 元画像の(1,1)=5,(2,1)=6,(1,2)=9,(2,2)=10 が切り出し先の(0,0)(1,0)(0,1)(1,1)になる。
    expect(cropped.data[0]).toBe(5);
    expect(cropped.data[4]).toBe(6);
    expect(cropped.data[8]).toBe(9);
    expect(cropped.data[12]).toBe(10);
  });

  it("幅・高さが0のrectでは空データを返す", () => {
    const cropped = cropSnapshotRect(new Uint8ClampedArray(16), 2, 2, {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });

    expect(cropped.width).toBe(0);
    expect(cropped.height).toBe(0);
    expect(cropped.data.length).toBe(0);
  });

  it("入力配列を変更しない(純粋関数であること)", () => {
    const data = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
    const original = Array.from(data);

    cropSnapshotRect(data, 2, 1, { x: 0, y: 0, width: 1, height: 1 });

    expect(Array.from(data)).toEqual(original);
  });
});
