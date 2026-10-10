//! スタンプの種類の切替(番号・✓・×・!・?、QE-T13、UI_quick-edits §2.1・§2.2、FR-004)。
//!
//! 文字サイズの 3 ボタン(`fontSizePicker.ts`)と同じ作り。選んだ種類は `toolSettings.ts` の
//! `setStampKind()` へ渡し、押下状態は購読で表示する。種類は「これから置くスタンプ」の設定で、
//! **選択中のスタンプは変えない**(取り消しの対象外なので、置いたものを変えると取り消せない変更に
//! なるため、UI §2.1)。
//!
//! スタンプツールを選んでいる間だけ出す(`hidden`)。重ね順の後ろに置き、出し入れしても既存の
//! ボタンが動かないようにする(`index.html`)。表示条件・名前・アイコンは純粋関数にしてユニット
//! テストし、DOM の結線は E2E `stamp.spec.ts` で確かめる(jsdom は入れない。既存方針)。

import { getCanvasState, subscribeCanvasState, type ToolId } from "../canvas/canvasState";
import { getToolSettings, setStampKind, subscribeToolSettings } from "../canvas/toolSettings";
import type { StampGlyph } from "../canvas/tools/stampShape";

export interface StampKindOption {
  glyph: StampGlyph;
  /** `aria-label` / `title`(`文字サイズ 小` と同じ「対象 + 値」の形)。 */
  label: string;
}

/** 種類の並びと名前(UI §2.1 の表)。 */
export const STAMP_KIND_OPTIONS: readonly StampKindOption[] = [
  { glyph: "number", label: "スタンプ 番号" },
  { glyph: "check", label: "スタンプ チェック" },
  { glyph: "cross", label: "スタンプ バツ" },
  { glyph: "exclamation", label: "スタンプ 注意" },
  { glyph: "question", label: "スタンプ 質問" },
];

/** 種類のボタンの名前。 */
export function stampKindLabel(glyph: StampGlyph): string {
  const option = STAMP_KIND_OPTIONS.find((candidate) => candidate.glyph === glyph);
  if (!option) {
    throw new Error(`STAMP_KIND_OPTIONS has no entry for glyph: ${glyph}`);
  }
  return option.label;
}

/** 種類の切替を出すか。スタンプツールを選んでいる間だけ(UI §2.1)。 */
export function isStampKindPickerVisible(activeTool: ToolId | null): boolean {
  return activeTool === "stamp";
}

/** 記号の線の共通属性(地の色で抜く。「最背面へ」のアイコンと同じ書き方)。 */
const GLYPH_STROKE =
  'fill="none" style="stroke: var(--surface-color)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
/** 「!」「?」の点(地の色の小さい丸)。 */
const glyphDot = (cy: number): string =>
  `<circle cx="10" cy="${cy}" r="1.05" style="fill: var(--surface-color)"/>`;

/** 種類ごとの記号(UI §2.2)。 */
const GLYPH_MARKUP: Record<StampGlyph, string> = {
  number: `<path d="M8.6 7.7 10.5 6.4V13.6" ${GLYPH_STROKE}/>`,
  check: `<path d="M6.7 10.2 8.9 12.4 13.3 7.7" ${GLYPH_STROKE}/>`,
  cross: `<path d="M7.4 7.4 12.6 12.6M12.6 7.4 7.4 12.6" ${GLYPH_STROKE}/>`,
  exclamation: `<path d="M10 6.2V10.9" ${GLYPH_STROKE}/>${glyphDot(13.7)}`,
  question: `<path d="M7.9 8.1A2.1 2.1 0 1 1 10.9 10C10.3 10.3 10 10.7 10 11.3" ${GLYPH_STROKE}/>${glyphDot(13.8)}`,
};

/**
 * 種類のアイコン: 塗りの丸 + 地の色で抜いた記号(置かれるスタンプと同じ見え方、UI §2.2)。
 * ツールのアイコン(輪郭)と見分けられる。押下中は丸がアクセント色になる(`currentColor`)。
 */
export function stampKindIcon(glyph: StampGlyph): string {
  return (
    '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
    '<circle cx="10" cy="10" r="7.5" fill="currentColor"/>' +
    GLYPH_MARKUP[glyph] +
    "</svg>"
  );
}

/**
 * 種類のボタン群を `mount` 配下に作り、`toolSettings`・`canvasState` と結線する。
 * `divider` は前に置く区切り線で、切替と一緒に出し入れする。
 */
export function initStampKindPicker(mount: HTMLElement, divider: HTMLElement | null = null): void {
  const buttons = STAMP_KIND_OPTIONS.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button";
    button.innerHTML = stampKindIcon(option.glyph);
    button.setAttribute("aria-label", option.label);
    button.title = option.label;
    button.setAttribute("aria-pressed", "false");
    // 選択中のスタンプは変えない(`setSelected*` を呼ばない。UI §2.1)。
    button.addEventListener("click", () => setStampKind(option.glyph));
    mount.appendChild(button);
    return { glyph: option.glyph, button };
  });

  const renderPressed = (): void => {
    const { stampKind } = getToolSettings();
    for (const { glyph, button } of buttons) {
      button.setAttribute("aria-pressed", String(glyph === stampKind));
    }
  };

  const renderVisibility = (): void => {
    const hidden = !isStampKindPickerVisible(getCanvasState().activeTool);
    mount.hidden = hidden;
    if (divider) {
      divider.hidden = hidden;
    }
  };

  subscribeToolSettings(renderPressed);
  subscribeCanvasState(renderVisibility);
  renderPressed();
  renderVisibility();
}
