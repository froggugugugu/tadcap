import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTURE_ACCELERATOR,
  acceleratorFromKeyEvent,
  captureButtonLabel,
  shortcutErrorMessage,
  shortcutLabel,
  shortcutNotice,
  validateShortcut,
  type ShortcutKeyEvent,
} from "./shortcutFormat";

function key(code: string, mods: Partial<Omit<ShortcutKeyEvent, "code">> = {}): ShortcutKeyEvent {
  return { code, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...mods };
}

describe("acceleratorFromKeyEvent(押したキー → global-hotkey の文字列)", () => {
  it("⌘⇧2 は既定キーと同じ文字列になる", () => {
    expect(acceleratorFromKeyEvent(key("Digit2", { metaKey: true, shiftKey: true }))).toEqual({
      kind: "ok",
      accelerator: "shift+super+Digit2",
    });
    expect(DEFAULT_CAPTURE_ACCELERATOR).toBe("shift+super+Digit2");
  });

  it("修飾キーは shift → control → alt → super の順に並べる(Rust 側の表記と同じ)", () => {
    expect(
      acceleratorFromKeyEvent(key("KeyK", { metaKey: true, altKey: true, ctrlKey: true, shiftKey: true })),
    ).toEqual({ kind: "ok", accelerator: "shift+control+alt+super+KeyK" });
  });

  it("⌥ を押して文字が変わっても(key が特殊文字でも)code で判定する", () => {
    expect(acceleratorFromKeyEvent({ ...key("KeyK", { altKey: true, metaKey: true }) })).toEqual({
      kind: "ok",
      accelerator: "alt+super+KeyK",
    });
  });

  it("修飾キーだけの押下は続きを待つ", () => {
    expect(acceleratorFromKeyEvent(key("MetaLeft", { metaKey: true }))).toEqual({ kind: "wait" });
    expect(acceleratorFromKeyEvent(key("ShiftRight", { shiftKey: true }))).toEqual({ kind: "wait" });
    expect(acceleratorFromKeyEvent(key("AltLeft", { altKey: true }))).toEqual({ kind: "wait" });
    expect(acceleratorFromKeyEvent(key("ControlLeft", { ctrlKey: true }))).toEqual({ kind: "wait" });
  });

  it("⌘・⌥・⌃ のどれも無ければ shortcut_invalid(⇧ だけも不可)", () => {
    expect(acceleratorFromKeyEvent(key("KeyK"))).toEqual({ kind: "error", reason: "shortcut_invalid" });
    expect(acceleratorFromKeyEvent(key("KeyK", { shiftKey: true }))).toEqual({
      kind: "error",
      reason: "shortcut_invalid",
    });
  });

  it("⌘ と 1 キーだけ(⌘C・⌘Q など)は shortcut_cmd_only", () => {
    expect(acceleratorFromKeyEvent(key("KeyC", { metaKey: true }))).toEqual({
      kind: "error",
      reason: "shortcut_cmd_only",
    });
  });

  it("macOS のスクリーンショット(⌘⇧3/4/5、⌃ 付きも)は shortcut_reserved", () => {
    for (const code of ["Digit3", "Digit4", "Digit5"]) {
      expect(acceleratorFromKeyEvent(key(code, { metaKey: true, shiftKey: true }))).toEqual({
        kind: "error",
        reason: "shortcut_reserved",
      });
      expect(acceleratorFromKeyEvent(key(code, { metaKey: true, shiftKey: true, ctrlKey: true }))).toEqual({
        kind: "error",
        reason: "shortcut_reserved",
      });
    }
  });

  it("⌥ や ⌃ と 1 キー、ファンクションキー、記号キーは使える", () => {
    expect(acceleratorFromKeyEvent(key("KeyK", { altKey: true }))).toEqual({ kind: "ok", accelerator: "alt+KeyK" });
    expect(acceleratorFromKeyEvent(key("F5", { ctrlKey: true }))).toEqual({ kind: "ok", accelerator: "control+F5" });
    expect(acceleratorFromKeyEvent(key("Slash", { metaKey: true, shiftKey: true }))).toEqual({
      kind: "ok",
      accelerator: "shift+super+Slash",
    });
  });
});

describe("validateShortcut", () => {
  it("⌘⇧6 は使える", () => {
    expect(validateShortcut({ shift: true, control: false, alt: false, super: true }, "Digit6")).toBeNull();
  });
});

describe("shortcutLabel(表示用の記号表記)", () => {
  it("既定キーは今の表記 ⌘⇧2 と同じ", () => {
    expect(shortcutLabel(DEFAULT_CAPTURE_ACCELERATOR)).toBe("⌘⇧2");
  });

  it("記号は ⌘ → ⌥ → ⌃ → ⇧ → キーの順に並べる", () => {
    expect(shortcutLabel("shift+control+alt+super+KeyK")).toBe("⌘⌥⌃⇧K");
  });

  it("記号キー・ファンクションキー・矢印・特殊キーを読みやすくする", () => {
    expect(shortcutLabel("super+shift+Slash")).toBe("⌘⇧/");
    expect(shortcutLabel("control+F12")).toBe("⌃F12");
    expect(shortcutLabel("alt+ArrowLeft")).toBe("⌥←");
    expect(shortcutLabel("control+Space")).toBe("⌃Space");
    expect(shortcutLabel("alt+Backquote")).toBe("⌥`");
  });

  it("修飾キーの別名(cmd / option / ctrl)と大文字小文字の違いも読める", () => {
    expect(shortcutLabel("CMD+Option+Ctrl+KeyA")).toBe("⌘⌥⌃A");
  });
});

describe("shortcutErrorMessage(設定画面に出す文言)", () => {
  it("Rust・画面側のエラー文字列ごとに理由と、元のキーのままかを伝える", () => {
    expect(shortcutErrorMessage("shortcut_invalid")).toBe("⌘・⌥・⌃ のどれかと一緒に押してください。");
    expect(shortcutErrorMessage("shortcut_cmd_only")).toBe(
      "⌘ を使うときは ⇧・⌥・⌃ のどれかも一緒に押してください(⌘C などとぶつかるため)。",
    );
    expect(shortcutErrorMessage("shortcut_reserved")).toBe("このキーは macOS のスクリーンショットが使っています。");
    expect(shortcutErrorMessage("shortcut_register_failed")).toBe(
      "このキーは使えませんでした。ほかのアプリが使っている可能性があります。元のキーのままです。",
    );
    expect(shortcutErrorMessage("settings_save_failed")).toBe("設定を保存できませんでした。元のキーのままです。");
  });

  it("知らないエラーは一般的な文言にする", () => {
    expect(shortcutErrorMessage(new Error("boom"))).toBe("キーを変更できませんでした。元のキーのままです。");
  });
});

describe("shortcutNotice(使えるが注意が要るキー)", () => {
  it("⌥ と文字だけ(⌘・⌃ なし)は、その記号を入力できなくなると伝える", () => {
    expect(shortcutNotice("alt+KeyK")).toBe(
      "⌥ と文字の組み合わせにすると、ほかのアプリでその記号を入力できなくなります。",
    );
    expect(shortcutNotice("shift+alt+KeyK")).not.toBeNull();
  });

  it("⌘ や ⌃ を含むなら注意は無い", () => {
    expect(shortcutNotice("alt+super+KeyK")).toBeNull();
    expect(shortcutNotice("control+alt+KeyK")).toBeNull();
    expect(shortcutNotice(DEFAULT_CAPTURE_ACCELERATOR)).toBeNull();
  });
});

describe("captureButtonLabel", () => {
  it("キャプチャボタンのツールチップ・aria-labelの文言", () => {
    expect(captureButtonLabel("shift+super+Digit2")).toBe("キャプチャ(⌘⇧2)");
    expect(captureButtonLabel("alt+super+KeyK")).toBe("キャプチャ(⌘⌥K)");
  });
});
