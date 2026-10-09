//! キャプチャのショートカット設定(KS-T3)と縮めてコピーの設定(QE-T07)のコマンド・イベントの薄いラッパー。
//!
//! `src/ipc/` は Tauri API(`@tauri-apps/api`)以外に依存しない(ARCH §3.2 依存方向ルール)。
//! ショートカットの失敗は Rust の `AppError` の固定文字列(`shortcut_invalid` など)のまま reject する(縮めてコピーは `ShrinkCopyError`)。

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 既定のキャプチャのショートカット(⌘⇧2)。`global-hotkey` の文字列形式。 */
export const DEFAULT_CAPTURE_ACCELERATOR = "shift+super+Digit2";

/** トレイ・アプリメニューの「設定…」で Rust から届くイベント。 */
export const SETTINGS_OPEN_EVENT = "settings://open";

/** キャプチャのショートカットの現在の状態(Rust `CaptureShortcutInfo` の camelCase JSON)。 */
export interface CaptureShortcutInfo {
  /** `global-hotkey` の文字列形式。例 `"shift+super+Digit2"`。 */
  accelerator: string;
  /** 既定キーと同じか(「既定に戻す」の有効・無効に使う)。 */
  isDefault: boolean;
  /** OS への登録に成功しているか(起動時に登録できなかったことを設定画面で知らせる)。 */
  registered: boolean;
}

/** コマンドの無い環境(結果が`null`)では既定キーとして扱う。 */
function orDefault(info: CaptureShortcutInfo | null, accelerator = DEFAULT_CAPTURE_ACCELERATOR): CaptureShortcutInfo {
  return info ?? { accelerator, isDefault: accelerator === DEFAULT_CAPTURE_ACCELERATOR, registered: true };
}

export async function getCaptureShortcut(): Promise<CaptureShortcutInfo> {
  return orDefault(await invoke<CaptureShortcutInfo | null>("get_capture_shortcut"));
}

export async function setCaptureShortcut(accelerator: string): Promise<CaptureShortcutInfo> {
  return orDefault(await invoke<CaptureShortcutInfo | null>("set_capture_shortcut", { accelerator }), accelerator);
}

export async function resetCaptureShortcut(): Promise<CaptureShortcutInfo> {
  return orDefault(await invoke<CaptureShortcutInfo | null>("reset_capture_shortcut"));
}

/**
 * キーを記録している間は、キャプチャのショートカットを押してもキャプチャしないよう Rust に伝える
 * (設定画面の入力欄のフォーカスで`true`、記録の終了・フォーカスが外れる・閉じるで`false`)。
 */
export async function setShortcutRecording(recording: boolean): Promise<void> {
  await invoke("set_shortcut_recording", { recording });
}

export async function onSettingsOpen(handler: () => void): Promise<UnlistenFn> {
  return listen(SETTINGS_OPEN_EVENT, () => {
    handler();
  });
}

/**
 * 縮めてコピーの設定の保存の失敗の種類(QE-T07、ARCH_quick-edits §5.5)。
 * - `save_failed`: 設定ファイルの保存の失敗(Rust の固定文字列 `settings_save_failed`。設定は元のまま)
 * - `failed`: それ以外の reject(コマンドが無い・通信の例外など)
 * - `invalid_response`: 応答が真偽値でない
 */
export type ShrinkCopyErrorCode = "save_failed" | "failed" | "invalid_response";

/** {@link setShrinkCopy} が reject する例外。 */
export class ShrinkCopyError extends Error {
  constructor(public readonly code: ShrinkCopyErrorCode) {
    super(`縮めてコピーの設定を保存できませんでした(${code})`);
    this.name = "ShrinkCopyError";
  }
}

const SETTINGS_SAVE_FAILED = "settings_save_failed";

/**
 * 縮めてコピーの設定を読む。コマンドが無い環境・失敗・真偽値以外の応答はオフ(`false`)として扱う。
 */
export async function getShrinkCopy(): Promise<boolean> {
  try {
    return (await invoke<unknown>("get_shrink_copy")) === true;
  } catch {
    return false;
  }
}

/**
 * 縮めてコピーの設定を変えて保存し、保存後の値を返す。
 * 失敗は {@link ShrinkCopyError} で reject する(`code` で保存の失敗を区別する)。
 */
export async function setShrinkCopy(enabled: boolean): Promise<boolean> {
  let response: unknown;
  try {
    response = await invoke<unknown>("set_shrink_copy", { enabled });
  } catch (error) {
    throw new ShrinkCopyError(error === SETTINGS_SAVE_FAILED ? "save_failed" : "failed");
  }
  if (typeof response !== "boolean") {
    throw new ShrinkCopyError("invalid_response");
  }
  return response;
}
