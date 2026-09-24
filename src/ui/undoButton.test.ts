import { describe, expect, it } from "vitest";

import {
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
