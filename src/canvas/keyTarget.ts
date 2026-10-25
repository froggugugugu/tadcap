//! keydown の `target`(フォーカス中の要素)の判定(レビュー 2026-10-26)。
//!
//! Enter に既定の動作(ボタンの押下・リンク・送信・改行)がある要素にフォーカスがあるとき、アプリ側の Enter の扱い
//! (トリミングの確定 `tools/cropTool.ts`、選択中の注釈の選択解除 `ui/selectionKeys.ts`)はその要素の押下に譲る。
//! 判定は 1 か所に持ち、`canvas/` と `ui/` の両方から読めるよう `canvas/` に置く(`canvas/` → `ui/` の依存を
//! 作らない、ARCH §3.2)。テキスト入力系の判定 `isEditableTarget()` は `ui/shortcutGuards.ts`。

/** keydown の `target` のうち判定に使う部分(`HTMLElement` がそのまま当てはまる。テストでは素のオブジェクト)。 */
export interface KeyTargetLike {
  tagName?: string;
  /** `role` 属性(`Element.role` の反映)。 */
  role?: string | null;
  isContentEditable?: boolean;
}

/** Enter に既定の動作(押下・送信・改行)がある要素のタグ。 */
const ACTIVATABLE_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);

/**
 * フォーカス中の要素が Enter で操作できる要素(`button`・`a`・`input`・`select`・`textarea`・`summary`・
 * `role="button"`・contenteditable)か。`true` なら Enter を扱わず既定の動作(ボタンの押下など)に任せる。
 */
export function isActivatableTarget(target: KeyTargetLike | null | undefined): boolean {
  if (!target) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName?.toUpperCase();
  if (tag !== undefined && ACTIVATABLE_TAGS.has(tag)) {
    return true;
  }
  return target.role?.toLowerCase() === "button";
}
