import { afterEach, describe, expect, it } from "vitest";

import { addShapeObject, getDocumentState, resetDocument, setDocumentSurface } from "../canvas/documentState";
import { DEFAULT_COLOR, getToolSettings, isValidColorCode, setColor } from "../canvas/toolSettings";
import { getUndoStackState } from "../canvas/undoStack";
import {
  COLOR_PRESETS,
  applyPresetColor,
  colorAtPresetIndex,
  colorPresetIndexOfCode,
  colorPresetLabel,
  colorPresetShortcutKey,
  presetIndexOfColor,
  toColorInputValue,
} from "./colorPicker";

// v1.2.0: 数字キー 1〜6 のための純粋関数(キー ↔ プリセットの対応・ツールチップ)と、ボタンとキーが共有する経路。
describe("colorPresetShortcutKey / colorPresetLabel(数字キー、v1.2.0)", () => {
  it("先頭のプリセットが 1、6 番目が 6", () => {
    expect(colorPresetShortcutKey(0)).toBe("1");
    expect(colorPresetShortcutKey(5)).toBe("6");
  });

  it("範囲外・非整数は null", () => {
    expect(colorPresetShortcutKey(-1)).toBeNull();
    expect(colorPresetShortcutKey(6)).toBeNull();
    expect(colorPresetShortcutKey(0.5)).toBeNull();
    expect(colorPresetLabel(6)).toBeNull();
  });

  it("ツールチップはツールボタンと同じ「名前(キー)」の形(半角かっこ・空白なし)", () => {
    expect(colorPresetLabel(0)).toBe("ピンク(1)");
    expect(colorPresetLabel(1)).toBe("赤(2)");
    expect(colorPresetLabel(5)).toBe("青(6)");
    COLOR_PRESETS.forEach((_preset, index) => {
      expect(colorPresetLabel(index)).toMatch(/^[^\s()]+\([1-6]\)$/);
    });
  });
});

describe("colorPresetIndexOfCode(数字キー、v1.2.0)", () => {
  it("Digit1〜Digit6 をプリセットのインデックスにする", () => {
    expect(colorPresetIndexOfCode("Digit1")).toBe(0);
    expect(colorPresetIndexOfCode("Digit3")).toBe(2);
    expect(colorPresetIndexOfCode("Digit6")).toBe(5);
  });

  it("プリセットの数を超えるキー・Digit0・テンキー・英字は null", () => {
    for (const code of ["Digit7", "Digit9", "Digit0", "Numpad1", "KeyA", ""]) {
      expect(colorPresetIndexOfCode(code)).toBeNull();
    }
  });
});

describe("applyPresetColor(ボタンと数字キーの共通の経路、v1.2.0)", () => {
  afterEach(() => {
    setColor(DEFAULT_COLOR);
    setDocumentSurface(null);
    resetDocument();
  });

  it("以後に描く色を変えて true。範囲外は何もせず false", () => {
    expect(applyPresetColor(1)).toBe(true);
    expect(getToolSettings().color).toBe(COLOR_PRESETS[1]!.color);
    expect(applyPresetColor(6)).toBe(false);
    expect(getToolSettings().color).toBe(COLOR_PRESETS[1]!.color);
  });

  it("オブジェクトを選択中ならその色も変え、取り消せる 1 手になる(ボタンと同じ `setSelectedColor` の経路)", () => {
    const object = addShapeObject({ kind: "rectangle", rect: { x: 10, y: 10, width: 20, height: 20 }, color: DEFAULT_COLOR });
    expect(object).not.toBeNull();
    const depth = getUndoStackState().undo.length;
    expect(applyPresetColor(5)).toBe(true);
    const shape = getDocumentState().objects[0]!.shape;
    expect("color" in shape ? shape.color : undefined).toBe(COLOR_PRESETS[5]!.color);
    // 取り消しそのもの(サーフェスが要る)は `documentState.test.ts` の `setSelectedColor` で確かめる。
    expect(getUndoStackState().undo.length).toBe(depth + 1);
  });
});

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
