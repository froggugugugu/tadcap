import { describe, expect, it } from "vitest";

import { isEditableTarget } from "./shortcutGuards";

// T22【新設 2026-09-24】: `clipboardButton.test.ts` から移設(挙動不変)。
describe("isEditableTarget", () => {
  it("nullはfalseを返す", () => {
    expect(isEditableTarget(null)).toBe(false);
  });

  it("undefinedはfalseを返す", () => {
    expect(isEditableTarget(undefined)).toBe(false);
  });

  it("INPUT要素はtrueを返す(テキスト入力中はショートカットを奪わない)", () => {
    expect(isEditableTarget({ tagName: "input" })).toBe(true);
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
  });

  it("TEXTAREA要素はtrueを返す", () => {
    expect(isEditableTarget({ tagName: "textarea" })).toBe(true);
  });

  it("isContentEditableがtrueの要素はtrueを返す", () => {
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(
      true,
    );
  });

  it("BUTTON等の通常要素はfalseを返す", () => {
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget({ tagName: "CANVAS" })).toBe(false);
  });
});

// T28【追加 2026-09-24】: ツールバーのカラーピッカー(`<input type="color">`)は文字入力欄では
// ないため、色を選んだ後にフォーカスが残っていてもCmd+C/Cmd+Z等を奪わないようにする。
describe("isEditableTarget(文字入力でないinput)", () => {
  it("type=colorのINPUTはfalseを返す", () => {
    expect(isEditableTarget({ tagName: "INPUT", type: "color" })).toBe(false);
  });

  it("type=textのINPUTはtrueのまま", () => {
    expect(isEditableTarget({ tagName: "INPUT", type: "text" })).toBe(true);
  });
});
