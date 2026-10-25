import { describe, expect, it } from "vitest";

import { colorPresetKeyIndex, type ColorKeyContext } from "./colorKeys";
import { COLOR_PRESETS } from "./colorPicker";
import type { ToolKeyEvent } from "./toolKeys";

// 数字キー 1〜6 で色のプリセットを切り替える判定(v1.2.0、UI_quick-edits §7)。扱わない条件はツールの 1 キー切替
// (`toolKeys.ts::isPlainShortcutKey`)と同じ。`window` への結線(`bindColorKeys`)は E2E `keyboard-shortcuts.spec.ts`。

function keyEvent(code: string, overrides: Partial<ToolKeyEvent> = {}): ToolKeyEvent {
  return {
    code,
    key: code.startsWith("Digit") ? code.slice(5) : code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    target: null,
    ...overrides,
  };
}

const ready: ColorKeyContext = { hasImage: true, isDrawing: false, isMasking: false };

describe("colorPresetKeyIndex", () => {
  it.each([
    ["Digit1", 0],
    ["Digit2", 1],
    ["Digit3", 2],
    ["Digit4", 3],
    ["Digit5", 4],
    ["Digit6", 5],
  ])("%s はプリセット %i 番目", (code, index) => {
    expect(colorPresetKeyIndex(keyEvent(code), ready)).toBe(index);
  });

  it("キーの数はプリセットの数(6)と同じで、1 番目のプリセットが Digit1", () => {
    COLOR_PRESETS.forEach((_preset, index) => {
      expect(colorPresetKeyIndex(keyEvent(`Digit${index + 1}`), ready)).toBe(index);
    });
    expect(colorPresetKeyIndex(keyEvent(`Digit${COLOR_PRESETS.length + 1}`), ready)).toBeNull();
  });

  it("Digit7 以降・Digit0・テンキー・英字キーは扱わない", () => {
    for (const code of ["Digit7", "Digit8", "Digit9", "Digit0", "Numpad1", "Numpad2", "KeyA", "Minus"]) {
      expect(colorPresetKeyIndex(keyEvent(code), ready)).toBeNull();
    }
  });

  it.each([
    ["⌘1", keyEvent("Digit1", { metaKey: true })],
    ["⌥1", keyEvent("Digit1", { altKey: true })],
    ["⌃1", keyEvent("Digit1", { ctrlKey: true })],
    ["⇧1", keyEvent("Digit1", { shiftKey: true, key: "!" })],
    ["⌘⇧2", keyEvent("Digit2", { metaKey: true, shiftKey: true })],
  ])("修飾キー付き(%s)は奪わない", (_name, event) => {
    expect(colorPresetKeyIndex(event, ready)).toBeNull();
  });

  it("押しっぱなしの繰り返し(repeat)は扱わない", () => {
    expect(colorPresetKeyIndex(keyEvent("Digit1", { repeat: true }), ready)).toBeNull();
  });

  it("ほかの処理が preventDefault したイベントは扱わない", () => {
    expect(colorPresetKeyIndex(keyEvent("Digit1", { defaultPrevented: true }), ready)).toBeNull();
  });

  it("IME の変換中(isComposing・keyCode 229)は扱わない", () => {
    expect(colorPresetKeyIndex(keyEvent("Digit1", { isComposing: true }), ready)).toBeNull();
    expect(colorPresetKeyIndex(keyEvent("Digit1", { keyCode: 229, key: "Process" }), ready)).toBeNull();
  });

  it("入力欄・contenteditable が対象なら扱わない(文字が入る)", () => {
    expect(colorPresetKeyIndex(keyEvent("Digit2", { target: { tagName: "INPUT", type: "text" } }), ready)).toBeNull();
    expect(colorPresetKeyIndex(keyEvent("Digit2", { target: { tagName: "TEXTAREA" } }), ready)).toBeNull();
    expect(
      colorPresetKeyIndex(keyEvent("Digit2", { target: { tagName: "DIV", isContentEditable: true } }), ready),
    ).toBeNull();
  });

  it("文字入力でない input(カラーピッカー)にフォーカスが残っていても切り替える", () => {
    expect(colorPresetKeyIndex(keyEvent("Digit2", { target: { tagName: "INPUT", type: "color" } }), ready)).toBe(1);
  });

  it("画像が無いときは扱わない", () => {
    expect(colorPresetKeyIndex(keyEvent("Digit1"), { ...ready, hasImage: false })).toBeNull();
  });

  it("ドラッグ描画中は扱わない", () => {
    expect(colorPresetKeyIndex(keyEvent("Digit1"), { ...ready, isDrawing: true })).toBeNull();
  });

  it("自動マスキングの処理中・確認中は扱わない", () => {
    expect(colorPresetKeyIndex(keyEvent("Digit1"), { ...ready, isMasking: true })).toBeNull();
  });

  it("event.key が日本語入力の全角数字でも event.code で引ける", () => {
    expect(colorPresetKeyIndex(keyEvent("Digit3", { key: "３" }), ready)).toBe(2);
  });
});
