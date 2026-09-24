//! 注釈色の選択UI(プリセット6色 + macOS標準カラーピッカー、PRD FR-013、T28【新設 2026-09-24】)。
//!
//! 選択結果は `canvas/toolSettings.ts::setColor()` へ反映し、選択状態は `subscribeToolSettings()`
//! の購読で表示する(ツールバーの他のボタンと同じ「状態ストア → 表示」の一方向)。
//! T19方針どおり説明文は置かず、色の名前は `aria-label`/`title` で保持する。
//!
//! 色の変更は以後に描く注釈にのみ反映する(FR-013)。編集中の図形(T31)は描き始めた時点の
//! 色で固定され、ここでの変更は反映しない(【仮定】T31由来。`shapeEdit.ts`の図形が色を持つ)。
//!
//! 定義・変換は純粋関数としてユニットテストし、DOM生成・結線(`initColorPicker`)はE2Eで検証する
//! (`toolbar.ts`と同じ方針、project-config.md §11)。

import {
  DEFAULT_COLOR,
  getToolSettings,
  isValidColorCode,
  setColor,
  subscribeToolSettings,
} from "../canvas/toolSettings";

export interface ColorPreset {
  label: string;
  /** `#RRGGBB` 形式。 */
  color: string;
}

/**
 * プリセット色見本(PRD §10決定#11で「ピンク以外は実装時に確定」)。プリセット色の定義は
 * ここ1か所のみ。ピンク以外はmacOSのシステムカラー(ライト外観)に揃え、既定のピンクと
 * 並べても彩度・明度が近く、白地・スクリーンショット上でどれも埋もれにくい組み合わせにした。
 */
export const COLOR_PRESETS: readonly ColorPreset[] = [
  { label: "ピンク", color: DEFAULT_COLOR },
  { label: "赤", color: "#FF3B30" },
  { label: "橙", color: "#FF9500" },
  { label: "黄", color: "#FFCC00" },
  { label: "緑", color: "#34C759" },
  { label: "青", color: "#007AFF" },
];

/** プリセットのインデックスから色コードを返す。範囲外・非整数は`null`。 */
export function colorAtPresetIndex(index: number): string | null {
  if (!Number.isInteger(index)) {
    return null;
  }
  return COLOR_PRESETS[index]?.color ?? null;
}

/**
 * 色コードに一致するプリセットのインデックスを返す(大文字・小文字は区別しない)。
 * プリセット外(カラーピッカーで選んだ色)は`-1`。
 */
export function presetIndexOfColor(color: string): number {
  const target = color.toUpperCase();
  return COLOR_PRESETS.findIndex((preset) => preset.color.toUpperCase() === target);
}

/**
 * `<input type="color">`の`value`形式(小文字の`#rrggbb`)へ変換する。不正な色コードは
 * 既定色にフォールバックする(`value`へ不正値を入れると黒になるため)。
 */
export function toColorInputValue(color: string): string {
  return (isValidColorCode(color) ? color : DEFAULT_COLOR).toLowerCase();
}

/**
 * 色見本ボタンとカラーピッカーを `mount` 配下に構築し、`toolSettings` と結線する。
 */
export function initColorPicker(mount: HTMLElement): void {
  const presetButtons = COLOR_PRESETS.map((preset, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-swatch";
    button.style.setProperty("--swatch-color", preset.color);
    button.setAttribute("aria-label", preset.label);
    button.title = preset.label;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      const color = colorAtPresetIndex(index);
      if (color) {
        setColor(color);
      }
    });
    mount.appendChild(button);
    return button;
  });

  // macOS標準のカラーピッカー。見た目は丸いスウォッチ(虹色の輪)にし、透明の`<input>`を
  // 上に重ねてクリックでOSのカラーパネルを開く。`input`イベントで選択中も即時反映する。
  const custom = document.createElement("span");
  custom.className = "color-swatch color-swatch--custom";
  custom.title = "その他の色";
  const input = document.createElement("input");
  input.type = "color";
  input.className = "color-swatch__input";
  input.setAttribute("aria-label", "その他の色");
  input.addEventListener("input", () => {
    if (isValidColorCode(input.value)) {
      setColor(input.value.toUpperCase());
    }
  });
  custom.appendChild(input);
  mount.appendChild(custom);

  const render = (): void => {
    const { color } = getToolSettings();
    const selectedIndex = presetIndexOfColor(color);
    presetButtons.forEach((button, index) => {
      button.setAttribute("aria-pressed", String(index === selectedIndex));
    });
    const isCustom = selectedIndex === -1;
    custom.classList.toggle("color-swatch--selected", isCustom);
    custom.style.setProperty("--swatch-color", isCustom ? color : "transparent");
    // ピッカーを開いたときの初期値を現在色に合わせる(操作中の値は上書きしない)。
    if (document.activeElement !== input) {
      input.value = toColorInputValue(color);
    }
  };

  subscribeToolSettings(render);
  render();
}
