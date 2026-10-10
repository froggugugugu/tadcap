import { beforeEach, describe, expect, it } from "vitest";

import type { CaptureResult } from "../ipc/capture";
import {
  canvasImagePixelRatio,
  clearCanvasImage,
  createCanvasState,
  getCanvasState,
  isSameCanvasImage,
  setActiveTool,
  setCanvasImage,
  setDrawing,
  subscribeCanvasState,
  toCanvasPixelRatio,
  toggleActiveTool,
  toggleTool,
  withActiveTool,
  withDrawing,
  withImage,
  withoutImage,
} from "./canvasState";

const capture: CaptureResult = {
  id: "capture-1",
  sourcePath: "/tmp/tadcap-captures/capture-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
  pixelRatio: 2,
};

describe("createCanvasState", () => {
  it("画像なし・ツール未選択・非描画中の初期状態を返す", () => {
    expect(createCanvasState()).toEqual({
      image: null,
      activeTool: null,
      isDrawing: false,
    });
  });
});

describe("withImage", () => {
  it("画像をセットした新しい状態を返す(元の状態は変更しない)", () => {
    const state = createCanvasState();
    const image = { assetUrl: "asset://localhost/x.png", capture };

    const next = withImage(state, image);

    expect(next.image).toEqual(image);
    expect(state.image).toBeNull();
  });
});

describe("withoutImage", () => {
  it("画像をクリアした新しい状態を返す", () => {
    const withImg = withImage(createCanvasState(), {
      assetUrl: "asset://localhost/x.png",
      capture,
    });

    const next = withoutImage(withImg);

    expect(next.image).toBeNull();
  });
});

describe("withActiveTool", () => {
  it("ツールをセットした新しい状態を返す(元の状態は変更しない)", () => {
    const state = createCanvasState();

    const next = withActiveTool(state, "arrow");

    expect(next.activeTool).toBe("arrow");
    expect(state.activeTool).toBeNull();
  });

  it("nullを渡すとツール未選択に戻る", () => {
    const state = withActiveTool(createCanvasState(), "arrow");

    const next = withActiveTool(state, null);

    expect(next.activeTool).toBeNull();
  });
});

describe("toggleTool(ツール状態の切替、T09)", () => {
  it("未選択の状態から矢印を指定すると矢印が選択される", () => {
    const state = createCanvasState();

    const next = toggleTool(state, "arrow");

    expect(next.activeTool).toBe("arrow");
  });

  it("既に選択中の矢印を指定すると選択解除される(トグル)", () => {
    const state = withActiveTool(createCanvasState(), "arrow");

    const next = toggleTool(state, "arrow");

    expect(next.activeTool).toBeNull();
  });

  it("矢印選択中にモザイクを指定すると矢印からモザイクへ切り替わる", () => {
    const state = withActiveTool(createCanvasState(), "arrow");

    const next = toggleTool(state, "mosaic");

    expect(next.activeTool).toBe("mosaic");
  });

  it("画像の状態には影響しない", () => {
    const image = { assetUrl: "asset://localhost/x.png", capture };
    const state = withImage(createCanvasState(), image);

    const next = toggleTool(state, "arrow");

    expect(next.image).toEqual(image);
  });
});

describe("withDrawing", () => {
  it("描画中フラグをセットした新しい状態を返す(元の状態は変更しない)", () => {
    const state = createCanvasState();

    const next = withDrawing(state, true);

    expect(next.isDrawing).toBe(true);
    expect(state.isDrawing).toBe(false);
  });
});

describe("isSameCanvasImage(参照比較、MUST-1: ドラッグ中の非同期Canvas差し替え検知)", () => {
  it("同一の参照はtrueを返す", () => {
    const image = { assetUrl: "asset://localhost/x.png", capture };

    expect(isSameCanvasImage(image, image)).toBe(true);
  });

  it("nullどうしはtrueを返す", () => {
    expect(isSameCanvasImage(null, null)).toBe(true);
  });

  it("フィールドの値が同じでも別オブジェクトならfalseを返す(参照比較、深い等価ではない)", () => {
    const a = { assetUrl: "asset://localhost/x.png", capture };
    const b = { assetUrl: "asset://localhost/x.png", capture };

    expect(isSameCanvasImage(a, b)).toBe(false);
  });

  it("片方がnullならfalseを返す", () => {
    const image = { assetUrl: "asset://localhost/x.png", capture };

    expect(isSameCanvasImage(image, null)).toBe(false);
    expect(isSameCanvasImage(null, image)).toBe(false);
  });

  it("setCanvasImageは呼ぶたびに新しい参照になるため、前後の画像は別物と判定される", () => {
    clearCanvasImage();
    setCanvasImage({ assetUrl: "asset://localhost/a.png", capture });
    const before = getCanvasState().image;

    setCanvasImage({ assetUrl: "asset://localhost/b.png", capture });
    const after = getCanvasState().image;

    expect(isSameCanvasImage(before, after)).toBe(false);
    clearCanvasImage();
  });
});

describe("canvasState ストア(モジュール単位の薄い状態オブジェクト、ARCH §1.3決定#1)", () => {
  beforeEach(() => {
    clearCanvasImage();
    setActiveTool(null);
    setDrawing(false);
  });

  it("初期状態は画像なし", () => {
    expect(getCanvasState().image).toBeNull();
  });

  it("setCanvasImageで状態が更新され、購読者に通知される", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeCanvasState((state) => received.push(state));
    const image = { assetUrl: "asset://localhost/x.png", capture };

    setCanvasImage(image);

    expect(getCanvasState().image).toEqual(image);
    expect(received).toHaveLength(1);
    unsubscribe();
  });

  it("clearCanvasImageで画像がクリアされる", () => {
    setCanvasImage({ assetUrl: "asset://localhost/x.png", capture });

    clearCanvasImage();

    expect(getCanvasState().image).toBeNull();
  });

  it("unsubscribe後は通知されない", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeCanvasState((state) => received.push(state));
    unsubscribe();

    setCanvasImage({ assetUrl: "asset://localhost/x.png", capture });

    expect(received).toHaveLength(0);
  });

  it("初期状態はツール未選択・非描画中", () => {
    expect(getCanvasState().activeTool).toBeNull();
    expect(getCanvasState().isDrawing).toBe(false);
  });

  it("setActiveToolで選択中ツールが更新され、購読者に通知される", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeCanvasState((state) => received.push(state));

    setActiveTool("arrow");

    expect(getCanvasState().activeTool).toBe("arrow");
    expect(received).toHaveLength(1);
    unsubscribe();
  });

  it("toggleActiveToolで同じツールを2回指定すると選択解除される", () => {
    toggleActiveTool("arrow");
    expect(getCanvasState().activeTool).toBe("arrow");

    toggleActiveTool("arrow");
    expect(getCanvasState().activeTool).toBeNull();
  });

  it("setDrawingで描画中フラグが更新され、購読者に通知される", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeCanvasState((state) => received.push(state));

    setDrawing(true);

    expect(getCanvasState().isDrawing).toBe(true);
    expect(received).toHaveLength(1);
    unsubscribe();
  });
});

describe("画像の倍率(QE-T08、ARCH_quick-edits §1.3 #11)", () => {
  it("toCanvasPixelRatio: 撮影結果の倍率 2 は 2、1・不明(null/欠落)は 1", () => {
    expect(toCanvasPixelRatio(2)).toBe(2);
    expect(toCanvasPixelRatio(1)).toBe(1);
    expect(toCanvasPixelRatio(null)).toBe(1);
    expect(toCanvasPixelRatio(undefined)).toBe(1);
  });

  it("canvasImagePixelRatio: 画像の倍率を返し、倍率を持たない画像・画像なしは 1", () => {
    expect(canvasImagePixelRatio({ assetUrl: "blob:x", capture, pixelRatio: 2 })).toBe(2);
    expect(canvasImagePixelRatio({ assetUrl: "blob:x", capture: null, pixelRatio: 1 })).toBe(1);
    expect(canvasImagePixelRatio({ assetUrl: "blob:x", capture: null })).toBe(1);
    expect(canvasImagePixelRatio(null)).toBe(1);
  });

  it("履歴から開き直した画像(capture: null)も倍率を保持する", () => {
    clearCanvasImage();
    setCanvasImage({ assetUrl: "blob:history", capture: null, pixelRatio: 2 });

    expect(canvasImagePixelRatio(getCanvasState().image)).toBe(2);
    clearCanvasImage();
  });
});
