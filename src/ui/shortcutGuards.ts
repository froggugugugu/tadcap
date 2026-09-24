//! ショートカット共通ガード(ARCH §5.1・§5.2、T22【新設 2026-09-24】)。
//!
//! `clipboardButton.ts`(FR-005、T12)が持っていた `isEditableTarget()` を抽出し、
//! `Cmd+C`・`Cmd+Z`/`Cmd+Shift+Z`(T29)・テキスト入力欄表示中の判定(T27)が同じ判定を
//! 再利用できるようにする(ARCH §5.1改訂「`clipboardButton.ts`から抽出」)。挙動は変更しない。

export interface EditableTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  /** `<input>`の`type`属性(文字入力でないinputを除外するため、T28)。 */
  type?: string;
}

/**
 * 文字入力を受けない`<input>`の`type`(T28【追加 2026-09-24】)。ツールバーのカラーピッカー
 * (`type="color"`)で色を選んだ後にフォーカスが残っていても、アプリのショートカットを奪わない。
 */
const NON_TEXT_INPUT_TYPES = new Set(["color", "button", "checkbox", "radio", "range", "submit", "reset", "file", "image"]);

/**
 * フォーカス中の要素がテキスト入力系かを判定する純粋関数。trueならアプリの
 * ショートカット(`Cmd+C`/`Cmd+Z`/`Cmd+Shift+Z`等)を奪わない(T12指示「テキスト入力中などは
 * 奪わない」を踏襲。T27でテキストツールの入力欄にも同じ判定を適用する)。
 */
export function isEditableTarget(
  target: EditableTargetLike | null | undefined,
): boolean {
  if (!target) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName?.toUpperCase();
  if (tag === "INPUT") {
    return !NON_TEXT_INPUT_TYPES.has(target.type?.toLowerCase() ?? "text");
  }
  return tag === "TEXTAREA";
}
