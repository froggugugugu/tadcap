import { describe, expect, it } from "vitest";

import {
  canvasToCssScale,
  computeBaselineY,
  computeFontSizePx,
  computeTextBoundingRect,
  computeTextLineTop,
  createTextSession,
  finishTextSession,
  isImeComposingKey,
  textKeyAction,
  textShadowParams,
} from "./textTool";

describe("computeFontSizePx", () => {
  it("典型サイズ(2000x1000)で小・中・大が昇順の決定論的な値になる", () => {
    const small = computeFontSizePx("small", 2000, 1000);
    const medium = computeFontSizePx("medium", 2000, 1000);
    const large = computeFontSizePx("large", 2000, 1000);
    expect([small, medium, large]).toEqual([36, 54, 81]);
    expect(computeFontSizePx("medium", 2000, 1000)).toBe(medium);
  });

  it("中の実寸は矢印の胴幅(典型30px)より大きい", () => {
    expect(computeFontSizePx("medium", 2000, 1000)).toBeGreaterThan(30);
  });

  it("5K相当では上限でクランプされる", () => {
    expect(computeFontSizePx("medium", 5120, 2880)).toBe(128);
    expect(computeFontSizePx("large", 5120, 2880)).toBe(192);
  });

  it("小さい画像では下限でクランプされる", () => {
    expect(computeFontSizePx("medium", 400, 300)).toBe(18);
    expect(computeFontSizePx("small", 400, 300)).toBe(12);
  });
});

describe("textShadowParams", () => {
  it("フォント実寸に比例し、矢印と同じ色(半透明の黒)を使う", () => {
    expect(textShadowParams(100)).toEqual({ blur: 8, offsetY: 5, color: "rgba(0, 0, 0, 0.35)" });
  });
});

describe("canvasToCssScale", () => {
  it("Canvas実ピクセル2000をCSS1000で表示していれば0.5", () => {
    expect(canvasToCssScale(1000, 2000)).toBe(0.5);
  });

  it("Canvas幅0なら1(防御)", () => {
    expect(canvasToCssScale(100, 0)).toBe(1);
  });
});

describe("computeTextLineTop", () => {
  it("クリック位置が行の縦中央になる", () => {
    expect(computeTextLineTop(500, 60, 1000)).toBe(470);
  });

  it("上端・下端からはみ出さないようクランプする", () => {
    expect(computeTextLineTop(10, 60, 1000)).toBe(0);
    expect(computeTextLineTop(990, 60, 1000)).toBe(940);
  });

  it("行の高さが画像より大きければ0", () => {
    expect(computeTextLineTop(10, 60, 40)).toBe(0);
  });
});

describe("computeBaselineY", () => {
  it("CSSの行ボックス(line-height)と同じ位置にベースラインを置く", () => {
    // half-leading = (60 - (50 + 14)) / 2 = -2 → baseline = top - 2 + 50
    expect(computeBaselineY(100, 60, 50, 14)).toBe(148);
  });
});

describe("computeTextBoundingRect", () => {
  it("描画原点・measureTextの外接値・影の余白から整数矩形を返す", () => {
    const rect = computeTextBoundingRect({
      x: 100,
      baselineY: 200,
      metrics: { left: 0, right: 150, ascent: 40, descent: 10 },
      shadow: { blur: 4, offsetY: 3, color: "x" },
      canvasWidth: 2000,
      canvasHeight: 1000,
    });
    // margin = blur*2 + offsetY + 2 = 13
    expect(rect).toEqual({ x: 87, y: 147, width: 176, height: 76 });
  });

  it("Canvas外へはみ出す分はクリップする", () => {
    const rect = computeTextBoundingRect({
      x: 5,
      baselineY: 20,
      metrics: { left: 0, right: 3000, ascent: 40, descent: 10 },
      shadow: { blur: 4, offsetY: 3, color: "x" },
      canvasWidth: 2000,
      canvasHeight: 1000,
    });
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(rect.x + rect.width).toBe(2000);
  });
});

describe("isImeComposingKey / textKeyAction", () => {
  const base = { key: "Enter", isComposing: false, keyCode: 13 };

  it("変換中でないEnterは確定、Escは取消", () => {
    expect(textKeyAction(base, false)).toBe("commit");
    expect(textKeyAction({ ...base, key: "Escape", keyCode: 27 }, false)).toBe("cancel");
  });

  it("isComposingのEnterでは確定しない", () => {
    expect(isImeComposingKey({ ...base, isComposing: true }, false)).toBe(true);
    expect(textKeyAction({ ...base, isComposing: true }, false)).toBeNull();
  });

  it("keyCode 229(変換確定のEnter、compositionend後に来る実装がある)では確定しない", () => {
    expect(textKeyAction({ ...base, keyCode: 229 }, false)).toBeNull();
  });

  it("compositionstart〜compositionendの間は確定・取消しない", () => {
    expect(textKeyAction(base, true)).toBeNull();
    expect(textKeyAction({ ...base, key: "Escape", keyCode: 27 }, true)).toBeNull();
  });

  it("その他のキーは何もしない", () => {
    expect(textKeyAction({ ...base, key: "a", keyCode: 65 }, false)).toBeNull();
  });
});

describe("createTextSession / finishTextSession", () => {
  it("Enterで文字列を確定する", () => {
    const result = finishTextSession(createTextSession(), "enter", "こんにちは");
    expect(result.action).toEqual({ type: "commit", text: "こんにちは" });
    expect(result.session.done).toBe(true);
  });

  it("blurでも確定する", () => {
    expect(finishTextSession(createTextSession(), "blur", "abc").action).toEqual({
      type: "commit",
      text: "abc",
    });
  });

  it("Escは文字があっても取消", () => {
    expect(finishTextSession(createTextSession(), "escape", "abc").action).toEqual({ type: "cancel" });
  });

  it("空文字・空白のみは何も焼き込まない(取消扱い)", () => {
    expect(finishTextSession(createTextSession(), "enter", "").action).toEqual({ type: "cancel" });
    expect(finishTextSession(createTextSession(), "blur", "   ").action).toEqual({ type: "cancel" });
  });

  it("終了済みのセッションは二度確定しない(Enter後のblur等)", () => {
    const first = finishTextSession(createTextSession(), "enter", "abc");
    const second = finishTextSession(first.session, "blur", "abc");
    expect(second.action).toEqual({ type: "none" });
  });

  it("画像差し替えでは焼き込まずに破棄する", () => {
    expect(finishTextSession(createTextSession(), "imageChanged", "abc").action).toEqual({
      type: "cancel",
    });
  });
});
