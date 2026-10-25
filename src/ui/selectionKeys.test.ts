import { afterEach, describe, expect, it } from "vitest";

import { beginScan, discardMaskSession, isMaskSessionActive } from "../canvas/maskSession";
import { MOVE_STEP, MOVE_STEP_SHIFT, selectionKeyAction, selectionMoveDelta } from "./selectionKeys";

const plain = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false };

// v1.2.0: 矢印キーで選択中のオブジェクトを 1px(⇧ で 10px)動かす。移動そのもの(画像の内側に収める・取り消し 1 手)は
// `documentState.test.ts` の `moveSelected`、`window` への結線は E2E `keyboard-shortcuts.spec.ts`。
describe("selectionMoveDelta(矢印キー)", () => {
  it("選択中なら矢印キーの向きに 1px", () => {
    expect(MOVE_STEP).toBe(1);
    expect(selectionMoveDelta({ ...plain, key: "ArrowLeft" }, true, null)).toEqual({ x: -1, y: 0 });
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight" }, true, null)).toEqual({ x: 1, y: 0 });
    expect(selectionMoveDelta({ ...plain, key: "ArrowUp" }, true, null)).toEqual({ x: 0, y: -1 });
    expect(selectionMoveDelta({ ...plain, key: "ArrowDown" }, true, null)).toEqual({ x: 0, y: 1 });
  });

  it("Shift を押しながらなら 10px", () => {
    expect(MOVE_STEP_SHIFT).toBe(10);
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight", shiftKey: true }, true, null)).toEqual({ x: 10, y: 0 });
    expect(selectionMoveDelta({ ...plain, key: "ArrowUp", shiftKey: true }, true, null)).toEqual({ x: 0, y: -10 });
  });

  it("選択が無ければ何もしない(画面のスクロールなど既定動作のまま)", () => {
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight" }, false, null)).toBeNull();
  });

  it("⌘・⌥・⌃ 付きは奪わない(Shift だけは許す)", () => {
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight", metaKey: true }, true, null)).toBeNull();
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight", altKey: true }, true, null)).toBeNull();
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight", ctrlKey: true }, true, null)).toBeNull();
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight", shiftKey: true, metaKey: true }, true, null)).toBeNull();
  });

  it("IME 変換中・入力欄(文字カーソルが動く)では奪わない。文字入力でない input は扱う", () => {
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight", isComposing: true }, true, null)).toBeNull();
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight" }, true, { tagName: "INPUT" })).toBeNull();
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight" }, true, { tagName: "TEXTAREA" })).toBeNull();
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight" }, true, { tagName: "INPUT", type: "color" })).toEqual({
      x: 1,
      y: 0,
    });
  });

  it("自動マスキングの処理中・確認中は扱わない", () => {
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight" }, true, null, true)).toBeNull();
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight" }, true, null, false)).toEqual({ x: 1, y: 0 });
  });

  // SHOULD(リリース前レビュー 2026-10-26): 注釈をドラッグ(描画・移動)している間の矢印キーは扱わない。扱うと
  // `moveSelected()` の 1 手がドラッグの 1 手の間に挟まり、1 回の ⌘Z で戻らなくなる(`colorKeys.ts` の
  // 「描画中は扱わない」と同じ判定。結線は `canvasState.isDrawing` を渡す)。
  it("ドラッグ(描画・移動)中は矢印キーを扱わない", () => {
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight" }, true, null, false, true)).toBeNull();
    expect(selectionMoveDelta({ ...plain, key: "ArrowUp", shiftKey: true }, true, null, false, true)).toBeNull();
    expect(selectionMoveDelta({ ...plain, key: "ArrowRight" }, true, null, false, false)).toEqual({ x: 1, y: 0 });
  });

  it("矢印キー以外は対象外(Enter・Delete は selectionKeyAction の役目)", () => {
    expect(selectionMoveDelta({ ...plain, key: "Enter" }, true, null)).toBeNull();
    expect(selectionMoveDelta({ ...plain, key: "Delete" }, true, null)).toBeNull();
    expect(selectionMoveDelta({ ...plain, key: "a" }, true, null)).toBeNull();
    expect(selectionMoveDelta({ ...plain, key: "Left" }, true, null)).toBeNull();
  });

  it("selectionKeyAction は矢印キーを扱わない(二重に反応しない)", () => {
    expect(selectionKeyAction({ ...plain, key: "ArrowRight" }, true, null)).toBeNull();
  });
});

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

  // SHOULD(リリース前レビュー 2026-10-26): 注釈を選択したまま Tab でボタン(コピー・取り消し・トリミングの帯の
  // 「やめる」「確定」など)にフォーカスして Enter を押しても、選択解除で押下を奪わない(`isActivatableTarget()`、
  // トリミングの Enter と同じ判定)。Esc・Delete の扱いは変えない。
  it("押せる要素(button・a・input・select・textarea・summary・role=button)にフォーカスがあるときの Enter は扱わない", () => {
    const targets = [
      { tagName: "BUTTON" },
      { tagName: "A" },
      { tagName: "INPUT", type: "color" },
      { tagName: "SELECT" },
      { tagName: "SUMMARY" },
      { tagName: "DIV", role: "button" },
    ];
    for (const target of targets) {
      expect(selectionKeyAction({ ...plain, key: "Enter" }, true, target)).toBeNull();
    }
    expect(selectionKeyAction({ ...plain, key: "Enter" }, true, { tagName: "BODY" })).toBe("deselect");
    expect(selectionKeyAction({ ...plain, key: "Enter" }, true, { tagName: "CANVAS" })).toBe("deselect");
  });

  it("ボタンにフォーカスがあっても Esc は選択解除、Delete は削除のまま", () => {
    expect(selectionKeyAction({ ...plain, key: "Escape" }, true, { tagName: "BUTTON" })).toBe("deselect");
    expect(selectionKeyAction({ ...plain, key: "Delete" }, true, { tagName: "BUTTON" })).toBe("delete");
    expect(selectionKeyAction({ ...plain, key: "Backspace" }, true, { tagName: "DIV", role: "button" })).toBe("delete");
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
