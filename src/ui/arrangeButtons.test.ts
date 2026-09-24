import { describe, expect, it } from "vitest";

import { arrangeShortcutCommand } from "./arrangeButtons";

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
