import { describe, expect, it } from "vitest";

import { DEFAULT_COLOR, isValidColorCode } from "../canvas/toolSettings";
import {
  COLOR_PRESETS,
  colorAtPresetIndex,
  presetIndexOfColor,
  toColorInputValue,
} from "./colorPicker";

describe("COLOR_PRESETS", () => {
  it("6色で、先頭が既定のピンク(#FF5C8A)", () => {
    expect(COLOR_PRESETS).toHaveLength(6);
    expect(COLOR_PRESETS[0]!.color).toBe(DEFAULT_COLOR);
    expect(COLOR_PRESETS.map((p) => p.label)).toEqual(["ピンク", "赤", "橙", "黄", "緑", "青"]);
  });

  it("全て#RRGGBB形式で重複がない", () => {
    for (const preset of COLOR_PRESETS) {
      expect(isValidColorCode(preset.color)).toBe(true);
    }
    const upper = COLOR_PRESETS.map((p) => p.color.toUpperCase());
    expect(new Set(upper).size).toBe(upper.length);
  });
});

describe("colorAtPresetIndex", () => {
  it("インデックスから色コードを返す", () => {
    expect(colorAtPresetIndex(0)).toBe(DEFAULT_COLOR);
    expect(colorAtPresetIndex(5)).toBe(COLOR_PRESETS[5]!.color);
  });

  it("範囲外・非整数はnull", () => {
    expect(colorAtPresetIndex(-1)).toBeNull();
    expect(colorAtPresetIndex(6)).toBeNull();
    expect(colorAtPresetIndex(1.5)).toBeNull();
  });
});

describe("presetIndexOfColor", () => {
  it("プリセット色のインデックスを大文字・小文字を区別せずに返す", () => {
    expect(presetIndexOfColor("#FF5C8A")).toBe(0);
    expect(presetIndexOfColor("#ff5c8a")).toBe(0);
    expect(presetIndexOfColor(COLOR_PRESETS[3]!.color.toLowerCase())).toBe(3);
  });

  it("プリセット外の色(カラーピッカーで選んだ色)は-1", () => {
    expect(presetIndexOfColor("#123456")).toBe(-1);
  });
});

describe("toColorInputValue", () => {
  it("<input type=color>のvalue形式(小文字#rrggbb)へ変換する", () => {
    expect(toColorInputValue("#FF5C8A")).toBe("#ff5c8a");
  });

  it("不正な色コードは既定色にフォールバックする", () => {
    expect(toColorInputValue("red")).toBe("#ff5c8a");
  });
});
