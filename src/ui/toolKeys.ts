//! ツールの 1 キー切替(QE-T02、ARCH_quick-edits §7.1 手順 K・§9.1、UI_quick-edits §1.3、FR-013)。
//!
//! キーとツールの対応は `TOOL_KEYS` の 1 か所だけに持ち、ツールボタンの名前(`矢印(A)`)・
//! `aria-keyshortcuts`(`toolbar.ts`)と、`window` の keydown の判定の両方がここを読む。
//! 判定は `event.code`(物理キー)で引くので、日本語入力がオンでも同じキーで切り替わる。
//!
//! 押せるかどうかはツールボタンと同じ `toolButtonState()`(`toolbar.ts`)で決める。`toolbar.ts` が
//! 本モジュールの `toolLabel()` を読むため、循環を避けて可否の判定は `bindToolKeys()` の引数で
//! 受け取る(`main.ts` が `toolButtonState()` を渡す)。
//!
//! 新しいツール(トリミング `KeyC`)は、ツールを追加するタスクで `TOOL_KEYS` に 1 行足す
//! (PRD_quick-edits §9 Phase 1)。それまでそのキーは何もしない。スタンプ `KeyN` は QE-T13、
//! スポットライト `KeyS` は QE-T16 で足した。

import { getCanvasState, toggleActiveTool, type ToolId } from "../canvas/canvasState";
import { isEditableTarget, type EditableTargetLike } from "./shortcutGuards";

export interface ToolKeyEntry {
  tool: ToolId;
  /** `KeyboardEvent.code`(物理キー)。 */
  code: string;
  /** ツールの名前(キーを付ける前)。 */
  label: string;
}

/** キーとツールの対応(UI_quick-edits §1.3 の表と同じ並び)。 */
export const TOOL_KEYS: ReadonlyArray<ToolKeyEntry> = [
  { tool: "arrow", code: "KeyA", label: "矢印" },
  { tool: "rectangle", code: "KeyR", label: "矩形" },
  { tool: "ellipse", code: "KeyO", label: "円" },
  { tool: "text", code: "KeyT", label: "テキスト" },
  { tool: "stamp", code: "KeyN", label: "スタンプ" },
  { tool: "mosaic", code: "KeyM", label: "モザイク" },
  { tool: "spotlight", code: "KeyS", label: "スポットライト" },
];

function entryOf(id: ToolId): ToolKeyEntry {
  const entry = TOOL_KEYS.find((candidate) => candidate.tool === id);
  if (!entry) {
    throw new Error(`TOOL_KEYS has no entry for tool: ${id}`);
  }
  return entry;
}

/** `aria-keyshortcuts` に入れるキー(`KeyA` → `A`)。 */
export function toolShortcutKey(id: ToolId): string {
  return entryOf(id).code.replace(/^Key/, "");
}

/** ツールボタンの `aria-label`・`title`(`矢印(A)`。既存の `取り消し(⌘Z)` と同じく半角かっこ・空白なし)。 */
export function toolLabel(id: ToolId): string {
  return `${entryOf(id).label}(${toolShortcutKey(id)})`;
}

/** 判定に使う `KeyboardEvent` の部分(テストで組み立てられるように)。 */
export interface ToolKeyEvent {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  keyCode: number;
  defaultPrevented: boolean;
  target: EditableTargetLike | null;
}

export interface ToolKeyContext {
  /** 画像を表示しているか。無いときは切り替えない。 */
  hasImage: boolean;
  /** ツールボタンが無効か(`toolButtonState(id, context).disabled`。描画中・自動マスキングの処理中/確認中)。 */
  isToolDisabled: (id: ToolId) => boolean;
}

/** IME の変換中に届く keydown の `keyCode`。 */
const IME_PROCESS_KEY_CODE = 229;

/**
 * keydown が切り替えるツール。扱わないときは `null`(ARCH_quick-edits §7.1 手順 K)。
 * 修飾キー付き(⌘C・⌘Z など)・押しっぱなし・IME の変換中・入力欄への入力は奪わない。
 */
export function toolKeyTarget(event: ToolKeyEvent, context: ToolKeyContext): ToolId | null {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.isComposing ||
    event.keyCode === IME_PROCESS_KEY_CODE ||
    isEditableTarget(event.target)
  ) {
    return null;
  }
  const entry = TOOL_KEYS.find((candidate) => candidate.code === event.code);
  if (!entry || !context.hasImage || context.isToolDisabled(entry.tool)) {
    return null;
  }
  return entry.tool;
}

/**
 * `window` の keydown にツールの 1 キー切替を結線する。`bindSelectionKeys()` の後に登録する
 * (ARCH_quick-edits §11。文字キーだけを扱い、Enter / Esc / Delete は扱わない)。戻り値は解除関数。
 */
export function bindToolKeys(isToolDisabled: (id: ToolId) => boolean): () => void {
  const handleKeydown = (event: KeyboardEvent): void => {
    const tool = toolKeyTarget(
      {
        code: event.code,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
        defaultPrevented: event.defaultPrevented,
        target: event.target as EditableTargetLike | null,
      },
      { hasImage: getCanvasState().image !== null, isToolDisabled },
    );
    if (!tool) {
      return;
    }
    event.preventDefault();
    // ボタンと同じ。選んでいるツールのキーをもう一度押すと選択が外れる。
    toggleActiveTool(tool);
  };
  window.addEventListener("keydown", handleKeydown);
  return () => window.removeEventListener("keydown", handleKeydown);
}
