import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginCrop,
  cancelCrop,
  clampCropRect,
  getCropSession,
  subscribeCropSession,
  updateCropRect,
} from "./cropSession";

// 確定前のトリミング範囲(QE-T21、ARCH_quick-edits §5.1・§6.1・§6.3)。取り消しの対象ではなく、
// メモリだけに持つ。範囲は画像のピクセル座標で、画像の内側に収める。

const W = 400;
const H = 300;

afterEach(() => {
  cancelCrop();
});

describe("clampCropRect", () => {
  it("画像の内側の範囲はそのまま(小数も丸めない。整数化は確定時の normalizeCropRect)", () => {
    expect(clampCropRect({ x: 10.5, y: 20, width: 100, height: 50.25 }, W, H)).toEqual({
      x: 10.5,
      y: 20,
      width: 100,
      height: 50.25,
    });
  });

  it("負の幅・高さ(逆向きのドラッグ)は向きをそろえる", () => {
    expect(clampCropRect({ x: 110, y: 70, width: -100, height: -50 }, W, H)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it("画像の外へ出た分は切り詰める", () => {
    expect(clampCropRect({ x: -20, y: 250, width: 100, height: 100 }, W, H)).toEqual({
      x: 0,
      y: 250,
      width: 80,
      height: 50,
    });
  });

  it("完全に外なら幅・高さ 0 の範囲(画像の辺の上)", () => {
    expect(clampCropRect({ x: 500, y: -50, width: 10, height: 10 }, W, H)).toEqual({
      x: 400,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("cropSession", () => {
  it("初めは範囲なし(null)", () => {
    expect(getCropSession()).toBeNull();
  });

  it("beginCrop で範囲ができ、画像の内側に収める", () => {
    beginCrop({ x: -10, y: 10, width: 50, height: 20 }, W, H);
    expect(getCropSession()).toEqual({ rect: { x: 0, y: 10, width: 40, height: 20 } });
  });

  it("updateCropRect で範囲を変える(画像の内側に収める)", () => {
    beginCrop({ x: 10, y: 10, width: 0, height: 0 }, W, H);
    updateCropRect({ x: 10, y: 10, width: 500, height: 100 }, W, H);
    expect(getCropSession()).toEqual({ rect: { x: 10, y: 10, width: 390, height: 100 } });
  });

  it("範囲が無いときの updateCropRect は何もしない(範囲を作らない)", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCropSession(listener);
    updateCropRect({ x: 10, y: 10, width: 50, height: 50 }, W, H);
    unsubscribe();
    expect(getCropSession()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it("cancelCrop で範囲なしに戻る", () => {
    beginCrop({ x: 10, y: 10, width: 50, height: 50 }, W, H);
    cancelCrop();
    expect(getCropSession()).toBeNull();
  });

  it("変化のたびに購読者へ通知し、変わらなければ通知しない", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCropSession(listener);
    beginCrop({ x: 10, y: 10, width: 50, height: 50 }, W, H);
    updateCropRect({ x: 10, y: 10, width: 60, height: 50 }, W, H);
    updateCropRect({ x: 10, y: 10, width: 60, height: 50 }, W, H);
    cancelCrop();
    cancelCrop();
    unsubscribe();
    expect(listener.mock.calls).toEqual([
      [{ rect: { x: 10, y: 10, width: 50, height: 50 } }],
      [{ rect: { x: 10, y: 10, width: 60, height: 50 } }],
      [null],
    ]);
  });

  it("購読を解除したら通知しない", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCropSession(listener);
    unsubscribe();
    beginCrop({ x: 10, y: 10, width: 50, height: 50 }, W, H);
    expect(listener).not.toHaveBeenCalled();
  });

  it("範囲は呼び出し側の値を共有しない(渡した矩形を後で変えても影響しない)", () => {
    const rect = { x: 10, y: 10, width: 50, height: 50 };
    beginCrop(rect, W, H);
    rect.width = 999;
    expect(getCropSession()?.rect.width).toBe(50);
  });
});
