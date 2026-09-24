//! 画面収録権限(TCC)の確認・要求(ARCH §15 決定#1)。
//!
//! macOS 標準の `CoreGraphics` フレームワークが提供する
//! `CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess` を
//! `extern "C"` 宣言で直接呼び出す。第三者プラグインは使わない
//! (ゲート2決定 2026-09-23)。`unsafe` はこの2関数の呼び出しのみに閉じ込め、
//! 公開関数はすべて安全なラッパーとする。
//!
//! 実際の権限状態は OS(TCC)に依存するため自動テストの対象外とし、
//! 手動確認チェックリストへ回す(T04 受け入れ条件)。テスト可能な戻り値変換
//! (`to_permission`)のみを純粋関数として切り出しユニットテストする。

use std::ffi::c_uchar;

use serde::Serialize;

// SAFETY: この extern block はシンボル・リンク先フレームワークの宣言のみを
// 行い、宣言自体に副作用はない。CoreGraphics は macOS 標準フレームワークの
// ため追加クレート(objc2 等)は不要(ARCH §2)。両関数とも引数を取らず、
// 戻り値は C の `Boolean`(`unsigned char`)である(Rust の `bool` と表現が
// 異なるため `c_uchar` で受け、`to_permission` で 0 / 非0 に正規化する)。
// 本アプリは macOS 専用(`screencapture` CLI 前提、ARCH §1)のため
// `target_os = "macos"` でのみ宣言する。
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    /// 画面収録権限が既に許可されているかを、ユーザーへダイアログを出さずに
    /// 確認する。
    fn CGPreflightScreenCaptureAccess() -> c_uchar;

    /// 画面収録権限が無い場合、OSの許可ダイアログを表示して要求する
    /// (既に許可・拒否済みの場合はダイアログを出さずその状態を返す)。
    ///
    /// T08(画面収録権限未許可時の案内UI)から `capture::ensure_screen_recording_access()`
    /// 経由で使用される(`commands::check_screen_recording_permission`)。
    fn CGRequestScreenCaptureAccess() -> c_uchar;
}

/// 画面収録権限の確認結果。
///
/// CoreGraphics が返すのは許可 / 非許可の2値のみであり、「未確認」等の
/// フロントエンド側の初期表示状態はこの型の責務ではない(フロントエンドは
/// `"unconfirmed" | "granted" | "notGranted"` の3値を持つ。PJM決定 2026-09-23、
/// `src/ipc/permissions.ts` 参照)。
///
/// `Serialize` は `commands::check_screen_recording_permission` の戻り値として
/// フロントエンドへそのまま伝達するために導出する(`camelCase` にリネームし
/// `"granted"`/`"notGranted"` 文字列になる)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenRecordingPermission {
    /// 画面収録権限が許可されている。
    Granted,
    /// 画面収録権限が許可されていない(未リクエスト・拒否済みの両方を含む)。
    NotGranted,
}

/// C の `Boolean`(0 = false、非0 = true)を [`ScreenRecordingPermission`] へ
/// 変換する純粋関数。FFI 呼び出しを含まないためユニットテスト可能。
fn to_permission(raw: c_uchar) -> ScreenRecordingPermission {
    if raw != 0 {
        ScreenRecordingPermission::Granted
    } else {
        ScreenRecordingPermission::NotGranted
    }
}

/// 画面収録権限が既に許可されているかを、ユーザーへダイアログを出さずに
/// 確認する(`CGPreflightScreenCaptureAccess` の安全なラッパー)。
#[cfg(target_os = "macos")]
pub fn preflight_screen_recording_access() -> ScreenRecordingPermission {
    // SAFETY: `CGPreflightScreenCaptureAccess` は引数を取らない読み取り専用の
    // 問い合わせ関数で、ポインタ操作を伴わない。戻り値はどのようなビット
    // パターンであっても `to_permission` が 0 / 非0 の2値に正規化するため、
    // 呼び出し側に未定義動作は生じない。
    let raw = unsafe { CGPreflightScreenCaptureAccess() };
    to_permission(raw)
}

/// 画面収録権限が無い場合、OSの許可ダイアログを表示して要求する
/// (`CGRequestScreenCaptureAccess` の安全なラッパー)。既に許可・拒否済みの
/// 場合はダイアログを出さずその時点の状態を返す。
///
/// ARCH §15決定#1により、`commands::capture_screen`(T06)は事前確認のみで
/// この関数を呼ばない。呼ぶのは `capture::ensure_screen_recording_access()`
/// (T08)のみで、未許可を検知した場合に限りOSの許可ダイアログを表示し、
/// システム設定「プライバシーとセキュリティ→画面収録」の一覧にアプリを
/// 登録する(呼ばないと一覧に現れず、ユーザーが許可を与える手段が無くなる。
/// PJM決定 2026-09-23)。
#[cfg(target_os = "macos")]
pub fn request_screen_recording_access() -> ScreenRecordingPermission {
    // SAFETY: 上記 `preflight_screen_recording_access` と同様、引数なし・
    // ポインタ操作なしの呼び出しであり未定義動作は生じない。ダイアログ表示は
    // OS側のUIスレッド処理でありこの呼び出し自体はブロッキングI/Oを伴わない。
    let raw = unsafe { CGRequestScreenCaptureAccess() };
    to_permission(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_permission_は非ゼロをgrantedに変換する() {
        assert_eq!(to_permission(1), ScreenRecordingPermission::Granted);
        assert_eq!(to_permission(255), ScreenRecordingPermission::Granted);
    }

    #[test]
    fn to_permission_はゼロをnot_grantedに変換する() {
        assert_eq!(to_permission(0), ScreenRecordingPermission::NotGranted);
    }

    /// `commands::check_screen_recording_permission`(T08)の戻り値としてそのまま
    /// フロントエンドへ渡されるため、JSON表現がcamelCase文字列であることを
    /// 固定する(`src/ipc/permissions.ts` の型定義と一致させる)。
    #[test]
    fn screen_recording_permission_のgrantedはcamel_case文字列にシリアライズされる() {
        let json = serde_json::to_string(&ScreenRecordingPermission::Granted)
            .expect("シリアライズに失敗した");
        assert_eq!(json, "\"granted\"");
    }

    #[test]
    fn screen_recording_permission_のnot_grantedはcamel_case文字列にシリアライズされる() {
        let json = serde_json::to_string(&ScreenRecordingPermission::NotGranted)
            .expect("シリアライズに失敗した");
        assert_eq!(json, "\"notGranted\"");
    }
}
