import { describe, expect, it } from "vitest";

import { pendingShapeKeyAction } from "./pendingShapeKeys";

const plain = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false };

describe("pendingShapeKeyAction", () => {
  it("編集中の図形があるとき、Enterで確定・Escで破棄", () => {
    expect(pendingShapeKeyAction({ ...plain, key: "Enter" }, true, null)).toBe("commit");
    expect(pendingShapeKeyAction({ ...plain, key: "Escape" }, true, null)).toBe("discard");
  });

  it("編集中の図形が無ければ何もしない", () => {
    expect(pendingShapeKeyAction({ ...plain, key: "Enter" }, false, null)).toBeNull();
    expect(pendingShapeKeyAction({ ...plain, key: "Escape" }, false, null)).toBeNull();
  });

  it("修飾キー付き・IME変換中・入力欄では奪わない", () => {
    expect(pendingShapeKeyAction({ ...plain, key: "Enter", metaKey: true }, true, null)).toBeNull();
    expect(pendingShapeKeyAction({ ...plain, key: "Enter", isComposing: true }, true, null)).toBeNull();
    expect(pendingShapeKeyAction({ ...plain, key: "Enter" }, true, { tagName: "INPUT" })).toBeNull();
  });

  it("その他のキーは対象外", () => {
    expect(pendingShapeKeyAction({ ...plain, key: "a" }, true, null)).toBeNull();
  });
});
