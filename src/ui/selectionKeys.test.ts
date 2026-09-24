import { describe, expect, it } from "vitest";

import { selectionKeyAction } from "./selectionKeys";

const plain = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false };

// 【改訂 2026-09-24 T32】T31の「Enter=確定・Esc=破棄」を、オブジェクト化に合わせて
// 「Enter/Esc=選択解除」に変えた(削除はT34のDelete/Backspace、取り消しはCmd+Z)。
describe("selectionKeyAction", () => {
  it("選択中のオブジェクトがあるとき、Enter・Escで選択解除", () => {
    expect(selectionKeyAction({ ...plain, key: "Enter" }, true, null)).toBe("deselect");
    expect(selectionKeyAction({ ...plain, key: "Escape" }, true, null)).toBe("deselect");
  });

  it("選択が無ければ何もしない", () => {
    expect(selectionKeyAction({ ...plain, key: "Enter" }, false, null)).toBeNull();
    expect(selectionKeyAction({ ...plain, key: "Escape" }, false, null)).toBeNull();
  });

  it("修飾キー付き・IME変換中・入力欄では奪わない", () => {
    expect(selectionKeyAction({ ...plain, key: "Enter", metaKey: true }, true, null)).toBeNull();
    expect(selectionKeyAction({ ...plain, key: "Enter", isComposing: true }, true, null)).toBeNull();
    expect(selectionKeyAction({ ...plain, key: "Enter" }, true, { tagName: "INPUT" })).toBeNull();
  });

  it("その他のキーは対象外", () => {
    expect(selectionKeyAction({ ...plain, key: "a" }, true, null)).toBeNull();
  });
});
