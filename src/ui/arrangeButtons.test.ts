import { afterEach, describe, expect, it } from "vitest";

import { beginScan, discardMaskSession } from "../canvas/maskSession";
import { arrangeEnabled, arrangeShortcutCommand, currentArrangeContext } from "./arrangeButtons";

const key = (k: string, mods: Partial<{ metaKey: boolean; shiftKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

describe("arrangeShortcutCommand(Keynote・Pages・フリーボードと同じ ⇧⌘F / ⇧⌘B)", () => {
  it("⇧⌘Fで最前面、⇧⌘Bで最背面(Shiftで大文字になっても判定する)", () => {
    expect(arrangeShortcutCommand(key("F", { metaKey: true, shiftKey: true }), null)).toBe("front");
    expect(arrangeShortcutCommand(key("b", { metaKey: true, shiftKey: true }), null)).toBe("back");
  });

  it("Shiftなし・⌘なし・Ctrl/Option併用・他のキーは対象外", () => {
    expect(arrangeShortcutCommand(key("f", { metaKey: true }), null)).toBeNull();
    expect(arrangeShortcutCommand(key("F", { shiftKey: true }), null)).toBeNull();
    expect(arrangeShortcutCommand(key("F", { metaKey: true, shiftKey: true, altKey: true }), null)).toBeNull();
    expect(arrangeShortcutCommand(key("F", { metaKey: true, shiftKey: true, ctrlKey: true }), null)).toBeNull();
    expect(arrangeShortcutCommand(key("G", { metaKey: true, shiftKey: true }), null)).toBeNull();
  });

  it("テキスト入力欄にフォーカスがあるときは奪わない", () => {
    expect(arrangeShortcutCommand(key("F", { metaKey: true, shiftKey: true }), { tagName: "INPUT" })).toBeNull();
  });
});

// AM-T13: 自動マスキングの確認中(maskSession が `review`)は重ね順の変更を止める
// (ARCH_auto-masking §15 #4 A 案)。ボタンと ⇧⌘F / ⇧⌘B の両方がこの判定に従う。
describe("arrangeEnabled", () => {
  const base = { hasSelection: true, isDrawing: false, isMasking: false };

  it("選択中でドラッグ中でも確認中でもなければ有効", () => {
    expect(arrangeEnabled(base)).toBe(true);
  });

  it("選択が無い・ドラッグ中は無効(既存どおり)", () => {
    expect(arrangeEnabled({ ...base, hasSelection: false })).toBe(false);
    expect(arrangeEnabled({ ...base, isDrawing: true })).toBe(false);
  });

  it("確認中は無効、確認が終わると元どおり", () => {
    expect(arrangeEnabled({ ...base, isMasking: true })).toBe(false);
    expect(arrangeEnabled({ ...base, isMasking: false })).toBe(true);
  });
});

// AM-T25-F1 SHOULD-1: 処理中(`scanning`)も確認中と同じく重ね順の変更を止める。
describe("currentArrangeContext(ストアから組み立てる文脈)", () => {
  afterEach(() => {
    discardMaskSession();
  });

  it("idle では isMasking: false", () => {
    expect(currentArrangeContext().isMasking).toBe(false);
  });

  it("処理中は isMasking: true になり、選択中でも無効", () => {
    beginScan({ assetUrl: "blob:arrange", capture: null });
    const context = { ...currentArrangeContext(), hasSelection: true };
    expect(context.isMasking).toBe(true);
    expect(arrangeEnabled(context)).toBe(false);
  });
});
