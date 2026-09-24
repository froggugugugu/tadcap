//! テキストのフォントサイズ選択UI(小・中・大、PRD FR-013・FR-012、T28【新設 2026-09-24】)。
//!
//! 選択結果は `canvas/toolSettings.ts::setFontSize()` へ反映し、選択状態は購読で表示する。
//! テキストツール専用の設定だが常時表示・常時操作可能とする(他ツール選択中の変更も副作用なし、
//! PRD §6)。T19方針どおりアイコンのみで、意味は `aria-label`/`title` で保持する。
//!
//! アイコンは「A」の字形で、大きさの比を `textTool.ts::FONT_SIZE_MULTIPLIER`(実際の焼き込み
//! サイズの比)に合わせる。定義・算出は純粋関数としてユニットテストし、DOM結線はE2Eで検証する。

import {
  getToolSettings,
  setFontSize,
  subscribeToolSettings,
  type FontSize,
} from "../canvas/toolSettings";
import { FONT_SIZE_MULTIPLIER } from "../canvas/tools/textTool";

export interface FontSizeOption {
  size: FontSize;
  label: string;
}

export const FONT_SIZE_OPTIONS: readonly FontSizeOption[] = [
  { size: "small", label: "文字サイズ 小" },
  { size: "medium", label: "文字サイズ 中" },
  { size: "large", label: "文字サイズ 大" },
];

/** 「大」のアイコン字形の高さ(`viewBox="0 0 20 20"`内の単位)。 */
export const FONT_SIZE_GLYPH_MAX = 17;

/** アイコンの字形の高さ。「大」を[`FONT_SIZE_GLYPH_MAX`]とし、焼き込みサイズと同じ比で縮める。 */
export function fontSizeGlyphHeight(size: FontSize): number {
  return (FONT_SIZE_GLYPH_MAX * FONT_SIZE_MULTIPLIER[size]) / FONT_SIZE_MULTIPLIER.large;
}

/** 下端(y=18.5)をそろえた「A」のSVG。線の太さは段階によらず一定(`non-scaling-stroke`)。 */
function glyphIcon(size: FontSize): string {
  const h = fontSizeGlyphHeight(size);
  const scale = h / 14;
  const tx = 10 - 7 * scale;
  const ty = 18.5 - 14 * scale;
  return (
    '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
    `<path transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(4)})" ` +
    'd="M1 14 7 0l6 14M3.4 9h7.2" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
    "</svg>"
  );
}

/** フォントサイズボタン群を `mount` 配下に構築し、`toolSettings` と結線する。 */
export function initFontSizePicker(mount: HTMLElement): void {
  const buttons = FONT_SIZE_OPTIONS.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button";
    button.innerHTML = glyphIcon(option.size);
    button.setAttribute("aria-label", option.label);
    button.title = option.label;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      setFontSize(option.size);
    });
    mount.appendChild(button);
    return { size: option.size, button };
  });

  const render = (): void => {
    const { fontSize } = getToolSettings();
    for (const { size, button } of buttons) {
      button.setAttribute("aria-pressed", String(size === fontSize));
    }
  };

  subscribeToolSettings(render);
  render();
}
