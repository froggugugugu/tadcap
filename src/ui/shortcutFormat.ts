//! キャプチャのショートカットの表記・入力の純粋関数(KS-T2)。
//!
//! キーは `global-hotkey`(Rust)の文字列形式で受け渡す。例 `"shift+super+Digit2"`。修飾キーは
//! `shift` → `control` → `alt` → `super` の順、最後がキー(`KeyboardEvent.code` と同じ名前)。
//! 押したキーは `event.code` で読む(⌥ を押すと `event.key` が特殊文字に変わるため)。
//!
//! 使えるキーの規則は Rust 側(`shortcuts.rs::validate_shortcut`)と同じで、最終判定は Rust 側が行う。
//! ここでは、送る前に分かる誤りをすぐ伝えるために同じ判定をする。

export { DEFAULT_CAPTURE_ACCELERATOR } from "../ipc/settings";

/** 使えないキーの理由(Rust 側のエラー文字列と同じ)。 */
export type ShortcutRejectReason = "shortcut_invalid" | "shortcut_cmd_only" | "shortcut_reserved";

export interface ShortcutKeyEvent {
  code: string;
  metaKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

export interface ShortcutModifiers {
  shift: boolean;
  control: boolean;
  alt: boolean;
  super: boolean;
}

export type KeyEventResult =
  | { kind: "wait" }
  | { kind: "ok"; accelerator: string }
  | { kind: "error"; reason: ShortcutRejectReason };

/** 修飾キー自体の`code`(押しただけでは記録を終えず、続くキーを待つ)。 */
const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "CapsLock",
  "Fn",
  "FnLock",
]);

/** macOS のスクリーンショット(⌘⇧3/4/5。⌃ を足すとクリップボードへ)が使うキー。 */
const SCREENSHOT_CODES = new Set(["Digit3", "Digit4", "Digit5"]);

/**
 * 修飾キーとキーの組み合わせを検査する。使えるなら`null`、使えなければ理由を返す。
 * - ⌘・⌥・⌃ のどれも無い(⇧ だけも含む): `shortcut_invalid`
 * - ⌘ と 1 キーだけ(⌘C・⌘Q など、全アプリの基本操作とぶつかる): `shortcut_cmd_only`
 * - ⌘⇧3/4/5(macOS のスクリーンショット): `shortcut_reserved`
 */
export function validateShortcut(mods: ShortcutModifiers, code: string): ShortcutRejectReason | null {
  if (!mods.super && !mods.alt && !mods.control) {
    return "shortcut_invalid";
  }
  if (mods.super && mods.shift && SCREENSHOT_CODES.has(code)) {
    return "shortcut_reserved";
  }
  if (mods.super && !mods.shift && !mods.alt && !mods.control) {
    return "shortcut_cmd_only";
  }
  return null;
}

/** 修飾キーとキーから`global-hotkey`の文字列を組み立てる。 */
function formatAccelerator(mods: ShortcutModifiers, code: string): string {
  const parts: string[] = [];
  if (mods.shift) parts.push("shift");
  if (mods.control) parts.push("control");
  if (mods.alt) parts.push("alt");
  if (mods.super) parts.push("super");
  parts.push(code);
  return parts.join("+");
}

/** 設定画面で押されたキーを、記録を続ける/確定する/断る、のどれかに分ける。 */
export function acceleratorFromKeyEvent(event: ShortcutKeyEvent): KeyEventResult {
  if (MODIFIER_CODES.has(event.code)) {
    return { kind: "wait" };
  }
  const mods: ShortcutModifiers = {
    shift: event.shiftKey,
    control: event.ctrlKey,
    alt: event.altKey,
    super: event.metaKey,
  };
  const reason = validateShortcut(mods, event.code);
  if (reason) {
    return { kind: "error", reason };
  }
  return { kind: "ok", accelerator: formatAccelerator(mods, event.code) };
}

/** `code`ごとの表示(`KeyA`・`Digit1`・`F1` 以外)。 */
const KEY_LABELS: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↩",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Space: "Space",
  Home: "↖",
  End: "↘",
  PageUp: "⇞",
  PageDown: "⇟",
};

function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return `Num${code.slice(6)}`;
  }
  return KEY_LABELS[code] ?? code;
}

/**
 * `global-hotkey`の文字列を表示用の記号表記にする(例 `"shift+super+Digit2"` → `"⌘⇧2"`)。
 * 記号はアプリ内の他の表記(⌘⇧F など)に合わせて ⌘ → ⌥ → ⌃ → ⇧ → キーの順に並べる。
 */
export function shortcutLabel(accelerator: string): string {
  const mods: ShortcutModifiers = { shift: false, control: false, alt: false, super: false };
  let code = "";
  for (const token of accelerator.split("+").map((t) => t.trim())) {
    switch (token.toLowerCase()) {
      case "shift":
        mods.shift = true;
        break;
      case "control":
      case "ctrl":
        mods.control = true;
        break;
      case "alt":
      case "option":
        mods.alt = true;
        break;
      case "super":
      case "cmd":
      case "command":
        mods.super = true;
        break;
      default:
        code = token;
    }
  }
  return `${mods.super ? "⌘" : ""}${mods.alt ? "⌥" : ""}${mods.control ? "⌃" : ""}${mods.shift ? "⇧" : ""}${keyLabel(code)}`;
}

/** 設定画面に出すエラー文言(Rust のエラー文字列・画面側の検査結果から)。 */
export function shortcutErrorMessage(error: unknown): string {
  switch (error) {
    case "shortcut_invalid":
      return "⌘・⌥・⌃ のどれかと一緒に押してください。";
    case "shortcut_cmd_only":
      return "⌘ を使うときは ⇧・⌥・⌃ のどれかも一緒に押してください(⌘C などとぶつかるため)。";
    case "shortcut_reserved":
      return "このキーは macOS のスクリーンショットが使っています。";
    case "shortcut_register_failed":
      return "このキーは使えませんでした。ほかのアプリが使っている可能性があります。元のキーのままです。";
    case "settings_save_failed":
      return "設定を保存できませんでした。元のキーのままです。";
    default:
      return "キーを変更できませんでした。元のキーのままです。";
  }
}

/**
 * 使えるが注意が要るキーの説明(無ければ`null`)。⌥ と文字だけ(⌘・⌃ なし)にすると、どのアプリでも
 * その組み合わせで入力する記号(⌥K の ˚ など)を打てなくなる(禁止はしない【仮定】)。
 */
export function shortcutNotice(accelerator: string): string | null {
  const tokens = accelerator.toLowerCase().split("+");
  const has = (name: string): boolean => tokens.includes(name);
  if (has("alt") && !has("super") && !has("control")) {
    return "⌥ と文字の組み合わせにすると、ほかのアプリでその記号を入力できなくなります。";
  }
  return null;
}

/** キャプチャボタンのツールチップ・`aria-label`(例 `キャプチャ(⌘⇧2)`)。 */
export function captureButtonLabel(accelerator: string): string {
  return `キャプチャ(${shortcutLabel(accelerator)})`;
}
