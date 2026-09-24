//! 画面収録権限の確認・システム設定を開くコマンド呼び出しの薄いラッパー
//! (ARCH §3.1 フロントエンド IPC 層、§4 `src/ipc/permissions.ts`、NFR-002、T08)。
//!
//! `src/ipc/` は Tauri API(`@tauri-apps/api`)以外に依存しない
//! (ARCH §3.2 依存方向ルール)。

import { invoke } from "@tauri-apps/api/core";

/**
 * 画面収録権限の状態(フロントエンド側、3値。ARCH §6.1 `permissionState`)。
 *
 * Rust側(`capture::ScreenRecordingPermission`)は `Granted`/`NotGranted` の
 * 2値のみを持つ(PJM決定 2026-09-23、判断根拠は `commands.rs` のdocコメント
 * 参照)。起動直後、まだ一度も確認していない状態を表す `"unconfirmed"` は
 * フロントエンドのみが持つ。
 */
export type PermissionState = "unconfirmed" | "granted" | "notGranted";

/**
 * `check_screen_recording_permission` コマンドの戻り値
 * (Rust `ScreenRecordingPermission` の camelCase JSON表現)。
 */
type RustPermissionState = "granted" | "notGranted";

/**
 * 画面収録権限を確認するコマンドを呼び出す(NFR-002)。
 *
 * 未許可の場合、Rust側の `capture::ensure_screen_recording_access()` が
 * `request_screen_recording_access()` を1回呼び、OSの許可ダイアログ表示と
 * システム設定「画面収録」一覧へのアプリ登録を行う(呼ばないと一覧に現れず
 * ユーザーが許可を与える手段が無くなる恐れがあるため。PJM決定 2026-09-23)。
 */
export async function checkScreenRecordingPermission(): Promise<PermissionState> {
  return invoke<RustPermissionState>("check_screen_recording_permission");
}

/**
 * システム設定の「プライバシーとセキュリティ→画面収録」を開くコマンドを
 * 呼び出す(NFR-002)。開くURLはRust側に固定されており、フロントエンドから
 * URLを渡すことはできない(ARCH §12「システム設定を開く導線の安全性」)。
 */
export async function openScreenRecordingSettings(): Promise<void> {
  await invoke("open_screen_recording_settings");
}

/**
 * `invoke()` のreject値・`capture://error` イベントのpayloadが画面収録権限
 * 未許可を表すかを判定する純粋関数。
 *
 * Rust `AppError::PermissionDenied` は文字列としてシリアライズされ、固定文字列
 * `"permission_denied"` になる(`error.rs` 参照)。フロントの3つの入口
 * (ボタンの `invoke` reject、トレイ/ショートカット起点の `capture://error`
 * イベント payload)はいずれもこの文字列との完全一致で判定する(T08)。
 */
export function isPermissionDeniedError(value: unknown): boolean {
  return value === "permission_denied";
}
