import { afterEach, describe, expect, it } from "vitest";

import { beginScan, discardMaskSession, isMaskSessionActive } from "../canvas/maskSession";
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

  it("選択中のDelete・Backspaceは削除(T34)", () => {
    expect(selectionKeyAction({ ...plain, key: "Delete" }, true, null)).toBe("delete");
    expect(selectionKeyAction({ ...plain, key: "Backspace" }, true, null)).toBe("delete");
    expect(selectionKeyAction({ ...plain, key: "Backspace" }, false, null)).toBeNull();
    expect(selectionKeyAction({ ...plain, key: "Backspace" }, true, { tagName: "INPUT" })).toBeNull();
    expect(selectionKeyAction({ ...plain, key: "Backspace", metaKey: true }, true, null)).toBeNull();
  });

  it("その他のキーは対象外", () => {
    expect(selectionKeyAction({ ...plain, key: "a" }, true, null)).toBeNull();
  });
});

// AM-T13: 自動マスキングの確認中(maskSession が `review`)は選択中のオブジェクトの削除・
// 選択解除を止める(ARCH_auto-masking §15 #4 A 案)。Esc は「やめる」(`ui/autoMask.ts`)に任せる。
describe("selectionKeyAction(確認中)", () => {
  it("確認中は Delete・Backspace で削除しない", () => {
    expect(selectionKeyAction({ ...plain, key: "Delete" }, true, null, true)).toBeNull();
    expect(selectionKeyAction({ ...plain, key: "Backspace" }, true, null, true)).toBeNull();
  });

  it("確認中は Enter・Esc で選択解除しない(Esc は「やめる」に任せる)", () => {
    expect(selectionKeyAction({ ...plain, key: "Enter" }, true, null, true)).toBeNull();
    expect(selectionKeyAction({ ...plain, key: "Escape" }, true, null, true)).toBeNull();
  });

  it("確認が終わる(false)と元どおり", () => {
    expect(selectionKeyAction({ ...plain, key: "Delete" }, true, null, false)).toBe("delete");
    expect(selectionKeyAction({ ...plain, key: "Escape" }, true, null, false)).toBe("deselect");
  });
});

// AM-T25-F1 SHOULD-1: 処理中(`scanning`)も確認中と同じく削除・選択解除を止める
// (`bindSelectionKeys` は `isMaskSessionActive()` を渡す)。
describe("selectionKeyAction(処理中)", () => {
  afterEach(() => {
    discardMaskSession();
  });

  it("処理中は Delete で削除しない", () => {
    beginScan({ assetUrl: "blob:selection", capture: null });
    expect(selectionKeyAction({ ...plain, key: "Delete" }, true, null, isMaskSessionActive())).toBeNull();
  });
});
