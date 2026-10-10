import { describe, expect, it } from "vitest";

import type { Rect } from "../canvas/coords";
import { CROP_BAR_MESSAGES, cropBarView, formatCropSize, type CropBarInput } from "./cropBar";

// トリミングの帯(QE-T22、UI_quick-edits §4.2・§4.3・§6)。DOM の結線(`initCropBar`)は E2E(QE-T23)で確かめる。

const W = 1600;
const H = 900;

function input(rect: Rect | null, overrides: Partial<CropBarInput> = {}): CropBarInput {
  return { activeTool: "crop", rect, canvasWidth: W, canvasHeight: H, dragging: false, ...overrides };
}

describe("formatCropSize(寸法の書式)", () => {
  it("半角の数字で、× の前後に半角空白", () => {
    expect(formatCropSize(1420, 768)).toBe("残す範囲 1420 × 768");
  });
});

describe("cropBarView(帯の表示、UI §4.2・§4.3)", () => {
  it("トリミング以外のツール・ツールなしでは隠す", () => {
    expect(cropBarView(input(null, { activeTool: "arrow" })).hidden).toBe(true);
    expect(cropBarView(input(null, { activeTool: null })).hidden).toBe(true);
  });

  it("ツールを選んだ時点(範囲なし)で出し、案内の文だけ。ボタンは出さない", () => {
    expect(cropBarView(input(null))).toEqual({
      hidden: false,
      status: "ドラッグで残す範囲を囲んでください。",
      hint: "",
      showButtons: false,
      confirmEnabled: false,
      busy: false,
    });
  });

  it("範囲あり: normalizeCropRect 後の整数の寸法 + 補足、確定できる", () => {
    const view = cropBarView(input({ x: 10.4, y: 20.6, width: 1420.2, height: 767.9 }));
    // 左 10・右 1431(1430.6 を四捨五入)→ 幅 1421、上 21・下 789(788.5 → 789)→ 高さ 768
    expect(view.status).toBe("残す範囲 1421 × 768");
    expect(view.hint).toBe("枠やハンドルで調整できます");
    expect(view.showButtons).toBe(true);
    expect(view.confirmEnabled).toBe(true);
    expect(view.hidden).toBe(false);
  });

  it("逆向きのドラッグ(負の幅・高さ)でも正の寸法", () => {
    expect(cropBarView(input({ x: 500, y: 400, width: -100, height: -50 })).status).toBe("残す範囲 100 × 50");
  });

  it("画像全体と同じ範囲: 補足を「画像全体と同じ範囲です」にし、確定は押せない", () => {
    const view = cropBarView(input({ x: 0.2, y: 0.4, width: W - 0.3, height: H }));
    expect(view.status).toBe(`残す範囲 ${W} × ${H}`);
    expect(view.hint).toBe("画像全体と同じ範囲です");
    expect(view.showButtons).toBe(true);
    expect(view.confirmEnabled).toBe(false);
  });

  it("幅か高さが 0(整数にすると 0 を含む)のときは確定を押せない", () => {
    expect(cropBarView(input({ x: 10, y: 10, width: 0, height: 50 })).confirmEnabled).toBe(false);
    const thin = cropBarView(input({ x: 10.1, y: 10, width: 0.3, height: 50 }));
    expect(thin.status).toBe("残す範囲 0 × 50");
    expect(thin.confirmEnabled).toBe(false);
    expect(thin.hint).toBe("枠やハンドルで調整できます");
  });

  it("ドラッグ中は busy(読み上げはポインタを離したときだけ)", () => {
    expect(cropBarView(input({ x: 0, y: 0, width: 10, height: 10 }, { dragging: true })).busy).toBe(true);
    expect(cropBarView(input({ x: 0, y: 0, width: 10, height: 10 })).busy).toBe(false);
  });

  it("文言一覧(UI §6)", () => {
    expect(CROP_BAR_MESSAGES.cancel).toBe("やめる");
    expect(CROP_BAR_MESSAGES.confirm).toBe("確定");
    expect(CROP_BAR_MESSAGES.cropped).toBe("切り抜きました。⌘Z で戻せます。");
  });
});
