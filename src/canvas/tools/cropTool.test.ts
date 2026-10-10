import { afterEach, describe, expect, it, vi } from "vitest";

import { getCanvasState, setActiveTool, setDrawing, type CanvasImage } from "../canvasState";
import { beginCrop, cancelCrop, getCropSession } from "../cropSession";
import { beginScan, discardMaskSession } from "../maskSession";
import { setDraft } from "../documentState";
import {
  CROP_SHADE,
  bindCropCancelConditions,
  confirmCrop,
  cropCursor,
  cropHandles,
  cropKeyAction,
  cropShadeRects,
  hitTestCrop,
  moveCropRect,
  resizeCropRect,
  shouldCancelCrop,
  type CropKeyEvent,
  type CropWatch,
} from "./cropTool";

// トリミングツールの判定(QE-T21、ARCH_quick-edits §5.1・§7.1 C-1〜2・C-6、UI_quick-edits §4.1)。
// ポインタ・オーバーレイの描画(DOM)は E2E(QE-T23)で確かめる。

const W = 400;
const H = 300;
const rect = { x: 100, y: 50, width: 200, height: 100 };

afterEach(() => {
  cancelCrop();
  discardMaskSession();
  setActiveTool(null);
  setDrawing(false);
});

describe("CROP_SHADE", () => {
  it("範囲の外の暗さは黒 60%(UI_quick-edits §4.1)", () => {
    expect(CROP_SHADE).toBe("rgba(0, 0, 0, 0.6)");
  });
});

describe("cropHandles", () => {
  it("四隅と四辺の中央の 8 つ", () => {
    expect(cropHandles(rect)).toEqual([
      { id: "nw", point: { x: 100, y: 50 } },
      { id: "n", point: { x: 200, y: 50 } },
      { id: "ne", point: { x: 300, y: 50 } },
      { id: "e", point: { x: 300, y: 100 } },
      { id: "se", point: { x: 300, y: 150 } },
      { id: "s", point: { x: 200, y: 150 } },
      { id: "sw", point: { x: 100, y: 150 } },
      { id: "w", point: { x: 100, y: 100 } },
    ]);
  });
});

describe("hitTestCrop", () => {
  it.each([
    [{ x: 100, y: 50 }, "nw"],
    [{ x: 307, y: 45 }, "ne"],
    [{ x: 300, y: 150 }, "se"],
    [{ x: 95, y: 155 }, "sw"],
    [{ x: 200, y: 52 }, "n"],
    [{ x: 305, y: 100 }, "e"],
    [{ x: 200, y: 150 }, "s"],
    [{ x: 100, y: 100 }, "w"],
  ] as const)("%o はハンドル %s", (point, handle) => {
    expect(hitTestCrop(rect, point, 10)).toEqual({ type: "handle", handle });
  });

  it("ハンドルから外れた内側は移動(inside)", () => {
    expect(hitTestCrop(rect, { x: 150, y: 80 }, 10)).toEqual({ type: "inside" });
    // 辺の上でもハンドルから離れていれば内側。
    expect(hitTestCrop(rect, { x: 150, y: 50 }, 10)).toEqual({ type: "inside" });
  });

  it("外側は null(新しい範囲を描く)", () => {
    expect(hitTestCrop(rect, { x: 50, y: 20 }, 10)).toBeNull();
    expect(hitTestCrop(rect, { x: 350, y: 100 }, 10)).toBeNull();
  });

  it("範囲が小さくハンドルが重なるときは四隅を優先する", () => {
    const tiny = { x: 100, y: 100, width: 6, height: 6 };
    expect(hitTestCrop(tiny, { x: 103, y: 100 }, 10)).toEqual({ type: "handle", handle: "nw" });
  });
});

describe("cropCursor", () => {
  it("隅・辺・内側・外側のカーソル(UI_quick-edits §4.1)", () => {
    expect(cropCursor({ type: "handle", handle: "nw" })).toBe("nwse-resize");
    expect(cropCursor({ type: "handle", handle: "se" })).toBe("nwse-resize");
    expect(cropCursor({ type: "handle", handle: "ne" })).toBe("nesw-resize");
    expect(cropCursor({ type: "handle", handle: "sw" })).toBe("nesw-resize");
    expect(cropCursor({ type: "handle", handle: "n" })).toBe("ns-resize");
    expect(cropCursor({ type: "handle", handle: "s" })).toBe("ns-resize");
    expect(cropCursor({ type: "handle", handle: "e" })).toBe("ew-resize");
    expect(cropCursor({ type: "handle", handle: "w" })).toBe("ew-resize");
    expect(cropCursor({ type: "inside" })).toBe("move");
    expect(cropCursor(null)).toBe("crosshair");
  });
});

describe("resizeCropRect", () => {
  it("四隅は 2 辺を動かす", () => {
    expect(resizeCropRect(rect, "nw", { x: 80, y: 40 }, W, H)).toEqual({ x: 80, y: 40, width: 220, height: 110 });
    expect(resizeCropRect(rect, "se", { x: 350, y: 200 }, W, H)).toEqual({ x: 100, y: 50, width: 250, height: 150 });
    expect(resizeCropRect(rect, "ne", { x: 320, y: 60 }, W, H)).toEqual({ x: 100, y: 60, width: 220, height: 90 });
    expect(resizeCropRect(rect, "sw", { x: 120, y: 170 }, W, H)).toEqual({ x: 120, y: 50, width: 180, height: 120 });
  });

  it("辺の中央は 1 辺だけを動かす(もう一方の向きは変えない)", () => {
    expect(resizeCropRect(rect, "n", { x: 0, y: 20 }, W, H)).toEqual({ x: 100, y: 20, width: 200, height: 130 });
    expect(resizeCropRect(rect, "s", { x: 999, y: 120 }, W, H)).toEqual({ x: 100, y: 50, width: 200, height: 70 });
    expect(resizeCropRect(rect, "e", { x: 250, y: 0 }, W, H)).toEqual({ x: 100, y: 50, width: 150, height: 100 });
    expect(resizeCropRect(rect, "w", { x: 10, y: 299 }, W, H)).toEqual({ x: 10, y: 50, width: 290, height: 100 });
  });

  it("反対の辺を越えても逆転しない(幅・高さ 0 で止まる)", () => {
    expect(resizeCropRect(rect, "w", { x: 380, y: 100 }, W, H)).toEqual({ x: 300, y: 50, width: 0, height: 100 });
    expect(resizeCropRect(rect, "se", { x: 20, y: 10 }, W, H)).toEqual({ x: 100, y: 50, width: 0, height: 0 });
  });

  it("画像の外へは出ない", () => {
    expect(resizeCropRect(rect, "nw", { x: -50, y: -50 }, W, H)).toEqual({ x: 0, y: 0, width: 300, height: 150 });
    expect(resizeCropRect(rect, "se", { x: 999, y: 999 }, W, H)).toEqual({ x: 100, y: 50, width: 300, height: 250 });
  });
});

describe("moveCropRect", () => {
  it("大きさを保って動かす", () => {
    expect(moveCropRect(rect, { x: 30, y: -20 }, W, H)).toEqual({ x: 130, y: 30, width: 200, height: 100 });
  });

  it("画像の端で止まる(大きさは変えない)", () => {
    expect(moveCropRect(rect, { x: 999, y: 999 }, W, H)).toEqual({ x: 200, y: 200, width: 200, height: 100 });
    expect(moveCropRect(rect, { x: -999, y: -999 }, W, H)).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });
});

describe("cropShadeRects", () => {
  it("範囲の外を上・下・左・右の重ならない 4 つで覆う", () => {
    expect(cropShadeRects(rect, W, H)).toEqual([
      { x: 0, y: 0, width: 400, height: 50 },
      { x: 0, y: 150, width: 400, height: 150 },
      { x: 0, y: 50, width: 100, height: 100 },
      { x: 300, y: 50, width: 100, height: 100 },
    ]);
  });

  it("面積 0 の帯は含めない(画像全体と同じなら空)", () => {
    expect(cropShadeRects({ x: 0, y: 0, width: W, height: H }, W, H)).toEqual([]);
    expect(cropShadeRects({ x: 0, y: 0, width: 100, height: H }, W, H)).toEqual([
      { x: 100, y: 0, width: 300, height: 300 },
    ]);
  });
});

function key(keyName: string, overrides: Partial<CropKeyEvent> = {}): CropKeyEvent {
  return {
    key: keyName,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    defaultPrevented: false,
    ...overrides,
  };
}

describe("cropKeyAction", () => {
  const active = { activeTool: "crop", hasRange: true, dragging: false } as const;

  it("範囲があるとき Enter は確定、Esc はやめる", () => {
    expect(cropKeyAction(key("Enter"), active)).toBe("apply");
    expect(cropKeyAction(key("Escape"), active)).toBe("cancel");
  });

  it("範囲が無いときの Enter / Esc は何もしない(選択の解除などへ渡す)", () => {
    expect(cropKeyAction(key("Enter"), { ...active, hasRange: false })).toBeNull();
    expect(cropKeyAction(key("Escape"), { ...active, hasRange: false })).toBeNull();
  });

  it("トリミングツール以外では扱わない", () => {
    expect(cropKeyAction(key("Enter"), { ...active, activeTool: "arrow" })).toBeNull();
    expect(cropKeyAction(key("Escape"), { ...active, activeTool: null })).toBeNull();
  });

  it("ドラッグ中の Esc はやめる、Enter は扱わない", () => {
    expect(cropKeyAction(key("Escape"), { ...active, dragging: true })).toBe("cancel");
    expect(cropKeyAction(key("Enter"), { ...active, dragging: true })).toBeNull();
  });

  it("修飾キー付き・IME の変換中・処理済みのイベントは扱わない", () => {
    expect(cropKeyAction(key("Enter", { metaKey: true }), active)).toBeNull();
    expect(cropKeyAction(key("Enter", { shiftKey: true }), active)).toBeNull();
    expect(cropKeyAction(key("Enter", { isComposing: true }), active)).toBeNull();
    expect(cropKeyAction(key("Escape", { defaultPrevented: true }), active)).toBeNull();
  });

  it("ほかのキーは扱わない", () => {
    expect(cropKeyAction(key("a"), active)).toBeNull();
    expect(cropKeyAction(key("Delete"), active)).toBeNull();
  });
});

describe("confirmCrop", () => {
  it("範囲があれば applyCrop に渡し、切り詰めたら範囲を消して onCropped を 1 回呼ぶ", () => {
    beginCrop(rect, W, H);
    const apply = vi.fn(() => true);
    const onCropped = vi.fn();
    expect(confirmCrop(onCropped, apply)).toBe(true);
    expect(apply).toHaveBeenCalledWith(rect);
    expect(getCropSession()).toBeNull();
    expect(onCropped).toHaveBeenCalledTimes(1);
  });

  it("何もしない範囲(applyCrop が false)なら範囲を残し、通知しない", () => {
    beginCrop({ x: 0, y: 0, width: W, height: H }, W, H);
    const onCropped = vi.fn();
    expect(confirmCrop(onCropped, () => false)).toBe(false);
    expect(getCropSession()).not.toBeNull();
    expect(onCropped).not.toHaveBeenCalled();
  });

  it("範囲が無ければ何もしない", () => {
    const apply = vi.fn(() => true);
    expect(confirmCrop(undefined, apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("shouldCancelCrop(やめる条件、ARCH_quick-edits §7.1 C-6)", () => {
  const base: CropWatch = { activeTool: "crop", masking: false, width: W, height: H };

  it("ツールが変わったらやめる", () => {
    expect(shouldCancelCrop(base, { ...base, activeTool: "arrow" })).toBe(true);
    expect(shouldCancelCrop(base, { ...base, activeTool: null })).toBe(true);
  });

  it("自動マスキングが始まったらやめる", () => {
    expect(shouldCancelCrop(base, { ...base, masking: true })).toBe(true);
  });

  it("ドキュメントの大きさが変わったらやめる", () => {
    expect(shouldCancelCrop(base, { ...base, width: 200 })).toBe(true);
    expect(shouldCancelCrop(base, { ...base, height: 100 })).toBe(true);
  });

  it("どれも変わらなければやめない", () => {
    expect(shouldCancelCrop(base, { ...base })).toBe(false);
  });
});

describe("bindCropCancelConditions(購読でやめる)", () => {
  const image: CanvasImage = { assetUrl: "blob:test", capture: null };

  function bind(size = { width: W, height: H }): { size: typeof size; unbind: () => void } {
    const unbind = bindCropCancelConditions(() => size);
    return { size, unbind };
  }

  it("ツールの切替で範囲を捨てる", () => {
    setActiveTool("crop");
    const { unbind } = bind();
    beginCrop(rect, W, H);
    setActiveTool("arrow");
    expect(getCropSession()).toBeNull();
    unbind();
  });

  it("描画中フラグの変化など、ツール以外の変化では捨てない", () => {
    setActiveTool("crop");
    const { unbind } = bind();
    beginCrop(rect, W, H);
    setDrawing(true);
    expect(getCanvasState().activeTool).toBe("crop");
    expect(getCropSession()).not.toBeNull();
    unbind();
  });

  it("自動マスキングの開始で範囲を捨てる", () => {
    setActiveTool("crop");
    const { unbind } = bind();
    beginCrop(rect, W, H);
    expect(beginScan(image)).not.toBeNull();
    expect(getCropSession()).toBeNull();
    unbind();
  });

  it("ドキュメントの大きさの変化(購読の通知)で範囲を捨てる。大きさが同じ通知では捨てない", () => {
    setActiveTool("crop");
    const { size, unbind } = bind();
    beginCrop(rect, W, H);
    setDraft(null);
    expect(getCropSession()).not.toBeNull();
    size.width = 200;
    setDraft(null);
    expect(getCropSession()).toBeNull();
    unbind();
  });

  it("解除した後は捨てない", () => {
    setActiveTool("crop");
    const { unbind } = bind();
    unbind();
    beginCrop(rect, W, H);
    setActiveTool("arrow");
    expect(getCropSession()).not.toBeNull();
  });
});
