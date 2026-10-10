import { afterEach, describe, expect, it } from "vitest";

import { beginCrop, cancelCrop } from "../canvas/cropSession";
import { beginScan, discardMaskSession } from "../canvas/maskSession";
import {
  currentUndoContext,
  resolveUndoCommand,
  undoAvailability,
  undoShortcutCommand,
  type UndoContext,
} from "./undoButton";

const key = (k: string, mods: Partial<{ metaKey: boolean; shiftKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

// 【改訂 2026-09-24 T32】編集中の図形(T31)が無くなったため`hasPendingShape`を文脈から外した。
const idle: UndoContext = { canUndo: false, canRedo: false, isDrawing: false };

describe("undoShortcutCommand", () => {
  it("Cmd+Zは取り消し、Cmd+Shift+Zはやり直し(Shiftで大文字になっても判定する)", () => {
    expect(undoShortcutCommand(key("z", { metaKey: true }), null)).toBe("undo");
    expect(undoShortcutCommand(key("Z", { metaKey: true, shiftKey: true }), null)).toBe("redo");
    expect(undoShortcutCommand(key("z", { metaKey: true, shiftKey: true }), null)).toBe("redo");
  });

  it("⌘なし・Ctrl/Option併用・他のキーは対象外", () => {
    expect(undoShortcutCommand(key("z"), null)).toBeNull();
    expect(undoShortcutCommand(key("z", { ctrlKey: true }), null)).toBeNull();
    expect(undoShortcutCommand(key("z", { metaKey: true, altKey: true }), null)).toBeNull();
    expect(undoShortcutCommand(key("y", { metaKey: true }), null)).toBeNull();
  });

  it("テキスト入力欄にフォーカスがあるときは発火しない(入力欄自身の取り消しに任せる)", () => {
    expect(undoShortcutCommand(key("z", { metaKey: true }), { tagName: "INPUT" })).toBeNull();
    expect(
      undoShortcutCommand(key("Z", { metaKey: true, shiftKey: true }), { tagName: "TEXTAREA" }),
    ).toBeNull();
  });

  it("カラーピッカー(type=color)にフォーカスがあっても発火する", () => {
    expect(undoShortcutCommand(key("z", { metaKey: true }), { tagName: "INPUT", type: "color" })).toBe(
      "undo",
    );
  });
});

describe("undoAvailability", () => {
  it("何もなければ両方無効", () => {
    expect(undoAvailability(idle)).toEqual({ undo: false, redo: false });
  });

  it("canUndo/canRedoに従う", () => {
    expect(undoAvailability({ ...idle, canUndo: true })).toEqual({ undo: true, redo: false });
    expect(undoAvailability({ ...idle, canRedo: true })).toEqual({ undo: false, redo: true });
  });

  it("ドラッグ中は両方無効", () => {
    expect(
      undoAvailability({ canUndo: true, canRedo: true, isDrawing: true }),
    ).toEqual({ undo: false, redo: false });
  });
});

describe("resolveUndoCommand", () => {
  it("取り消し・やり直し: 各スタックにコマンドがあるときだけ", () => {
    expect(resolveUndoCommand("undo", { ...idle, canUndo: true })).toBe("undo");
    expect(resolveUndoCommand("undo", idle)).toBeNull();
    expect(resolveUndoCommand("redo", { ...idle, canRedo: true })).toBe("redo");
    expect(resolveUndoCommand("redo", idle)).toBeNull();
  });

  it("ドラッグ中は何もしない", () => {
    expect(resolveUndoCommand("undo", { ...idle, canUndo: true, isDrawing: true })).toBeNull();
    expect(resolveUndoCommand("redo", { ...idle, canRedo: true, isDrawing: true })).toBeNull();
  });
});

// AM-T13: 自動マスキングの確認中(maskSession が `review`)は取り消し・やり直しを止める
// (ARCH_auto-masking §15 #4 A 案、FR-012)。⌘Z の判定自体は変えず(WebView 既定へ流さない)、
// 実行する操作を `null` にする。
describe("確認中(isMasking)の取り消し・やり直し", () => {
  const ready: UndoContext = { canUndo: true, canRedo: true, isDrawing: false };

  it("確認中は Cmd+Z・Cmd+Shift+Z で何もしない", () => {
    expect(resolveUndoCommand("undo", { ...ready, isMasking: true })).toBeNull();
    expect(resolveUndoCommand("redo", { ...ready, isMasking: true })).toBeNull();
  });

  it("確認中はボタンを両方無効にする", () => {
    expect(undoAvailability({ ...ready, isMasking: true })).toEqual({ undo: false, redo: false });
  });

  it("確認が終わる(isMasking: false)と元どおり", () => {
    expect(resolveUndoCommand("undo", { ...ready, isMasking: false })).toBe("undo");
    expect(resolveUndoCommand("redo", { ...ready, isMasking: false })).toBe("redo");
    expect(undoAvailability({ ...ready, isMasking: false })).toEqual({ undo: true, redo: true });
  });
});

// AM-T25-F1 SHOULD-1: 処理中(`scanning`)も確認中と同じく取り消し・やり直しを止める。
describe("currentUndoContext(ストアから組み立てる文脈)", () => {
  afterEach(() => {
    discardMaskSession();
  });

  it("idle では isMasking: false", () => {
    expect(currentUndoContext().isMasking).toBe(false);
  });

  it("処理中は isMasking: true になり、取り消し・やり直しとも何もしない", () => {
    beginScan({ assetUrl: "blob:undo", capture: null });
    const context = { ...currentUndoContext(), canUndo: true, canRedo: true };
    expect(context.isMasking).toBe(true);
    expect(resolveUndoCommand("undo", context)).toBeNull();
    expect(resolveUndoCommand("redo", context)).toBeNull();
    expect(undoAvailability(context)).toEqual({ undo: false, redo: false });
  });
});

// QE-T22: トリミングの範囲の指定中の ⌘Z / ⇧⌘Z とボタンは、指定をやめるだけ(ARCH_quick-edits §15 #4 A 案、
// UI_quick-edits §4.2・§7)。範囲が無ければ今どおり取り消し・やり直し。
describe("範囲の指定中(isCropping)の取り消し・やり直し", () => {
  const ready: UndoContext = { canUndo: true, canRedo: true, isDrawing: false };

  afterEach(() => {
    cancelCrop();
  });

  it("指定中は ⌘Z・⇧⌘Z とも cancelCrop(取り消しスタックは使わない)", () => {
    expect(resolveUndoCommand("undo", { ...ready, isCropping: true })).toBe("cancelCrop");
    expect(resolveUndoCommand("redo", { ...ready, isCropping: true })).toBe("cancelCrop");
  });

  it("取り消す手が無くても、指定中なら cancelCrop でボタンは両方有効", () => {
    expect(resolveUndoCommand("undo", { ...idle, isCropping: true })).toBe("cancelCrop");
    expect(undoAvailability({ ...idle, isCropping: true })).toEqual({ undo: true, redo: true });
  });

  it("ドラッグ中は何もしない(指定中でも)", () => {
    expect(resolveUndoCommand("undo", { ...ready, isCropping: true, isDrawing: true })).toBeNull();
  });

  it("指定なし(isCropping: false)は今どおり", () => {
    expect(resolveUndoCommand("undo", { ...ready, isCropping: false })).toBe("undo");
    expect(resolveUndoCommand("redo", { ...ready, isCropping: false })).toBe("redo");
    expect(undoAvailability({ ...idle, isCropping: false })).toEqual({ undo: false, redo: false });
  });

  it("currentUndoContext は範囲の有無を isCropping に入れる", () => {
    expect(currentUndoContext().isCropping).toBe(false);
    beginCrop({ x: 0, y: 0, width: 10, height: 10 }, 100, 100);
    expect(currentUndoContext().isCropping).toBe(true);
    cancelCrop();
    expect(currentUndoContext().isCropping).toBe(false);
  });
});
