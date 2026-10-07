//! キャプチャのショートカットの表記を、選んだキーへ追従させる(KS-T5)。
//!
//! 対象はキャプチャボタンのツールチップ・`aria-label`(`#capture-button`)と、空状態の
//! 「⌘⇧2 でキャプチャ」(`#empty-state kbd`)。`index.html`には既定キーの表記を書いてあり、
//! 現在のキーを取得できるまで(取得できない環境でも)はそのまま表示される。
//! DOM 操作のため Vitest(Node)の対象外とし、文言は`shortcutFormat.ts`の純粋関数でテストする。

import { captureButtonLabel, shortcutLabel } from "./shortcutFormat";

export function applyCaptureShortcutLabel(accelerator: string): void {
  const button = document.querySelector<HTMLElement>("#capture-button");
  if (button) {
    const text = captureButtonLabel(accelerator);
    button.title = text;
    button.setAttribute("aria-label", text);
  }
  const kbd = document.querySelector<HTMLElement>("#empty-state kbd");
  if (kbd) {
    kbd.textContent = shortcutLabel(accelerator);
  }
}
