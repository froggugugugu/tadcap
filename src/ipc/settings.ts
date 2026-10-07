//! キャプチャのショートカット設定のコマンド・イベントの薄いラッパー(KS-T3)。
//!
//! `src/ipc/` は Tauri API(`@tauri-apps/api`)以外に依存しない(ARCH §3.2 依存方向ルール)。
//! 失敗は Rust の `AppError` の固定文字列(`shortcut_invalid` など)のまま reject する。

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
