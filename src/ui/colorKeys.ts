//! 色のプリセットの数字キー(1〜6、v1.2.0、UI_quick-edits §7)。
//!
//! 修飾キーなしの `Digit1`〜`Digit6`(`event.code`)で、プリセットの 1〜6 番目の色に切り替える。色見本のボタンを
//! 押したときと同じ経路(`colorPicker.ts::applyPresetColor()`: 以後に描く色が変わり、選択中の注釈があればその色も
//! 変わって取り消せる)。キーとプリセットの対応・ツールチップは `colorPicker.ts` の 1 か所に持つ。
//!
//! 扱わない条件はツールの 1 キー切替(`toolKeys.ts`)と同じ: 修飾キー付き・押しっぱなし(`repeat`)・IME の変換中・
//! 入力欄への入力(`isPlainShortcutKey()` を共有)、画像なし・ドラッグ描画中・自動マスキングの処理中/確認中
//! (`ColorKeyContext`。`main.ts` がツールボタンと同じ `currentToolButtonContext()` を渡す)。設定画面の間は
//! `settingsDialog.ts` がキーを `window` へ伝えないので、ここでは判定を持たない。
//!
//! 判定は純粋関数(`colorPresetKeyIndex`)、`window` への結線は `bindColorKeys`(`bindToolKeys()` の直後に登録)。

import { applyPresetColor, colorPresetIndexOfCode } from "./colorPicker";
import { isPlainShortcutKey, toToolKeyEvent, type ToolKeyEvent } from "./toolKeys";

/** 押せるかどうかの文脈(`toolbar.ts::ToolButtonContext` の部分。ツールボタンと同じ条件で無効にする)。 */
export interface ColorKeyContext {
  /** 画像を表示しているか(`canvasState.image !== null`)。 */
  hasImage: boolean;
  /** ドラッグ描画中か。 */
  isDrawing: boolean;
  /** 自動マスキングの処理中・確認中(`maskSession` が `idle` 以外)。 */
  isMasking: boolean;
}

/**
 * keydown が選ぶプリセットのインデックス(`Digit2` → `1`)。扱わないときは `null`。
 */
export function colorPresetKeyIndex(event: ToolKeyEvent, context: ColorKeyContext): number | null {
  if (!isPlainShortcutKey(event) || !context.hasImage || context.isDrawing || context.isMasking) {
    return null;
  }
  return colorPresetIndexOfCode(event.code);
}

/**
 * `window` の keydown に数字キーの色切替を結線する。`bindToolKeys()` の直後に登録する(数字キーだけを扱い、
 * 文字キー・Enter / Esc / Delete・矢印キーは扱わない)。戻り値は解除関数。
 */
export function bindColorKeys(currentContext: () => ColorKeyContext): () => void {
  const handleKeydown = (event: KeyboardEvent): void => {
    const index = colorPresetKeyIndex(toToolKeyEvent(event), currentContext());
    if (index === null) {
      return;
    }
    event.preventDefault();
    applyPresetColor(index);
  };
  window.addEventListener("keydown", handleKeydown);
  return () => window.removeEventListener("keydown", handleKeydown);
}
