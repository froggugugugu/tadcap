//! コマンド共通のエラー型。
//!
//! 各 `#[tauri::command]` はこの型を `Result` の `Err` 側に使う(ARCH §3.1
//! Rust コマンド層)。`thiserror` で `Display` を導出し、フロントエンドへは
//! `serde::Serialize` を手動実装してメッセージ文字列として構造化伝達する
//! (`thiserror::Error` は `Serialize` を自動導出しないため)。

use serde::Serialize;
use thiserror::Error;

/// アプリケーション共通のコマンドエラー型。
///
/// 新しい失敗ケースが実際に発生する時点でバリアントを追加する(YAGNI)。
/// T06 時点で `commands::capture_screen` が `capture::RunError` を変換する
/// ために `PermissionDenied` を追加した。
#[derive(Debug, Error)]
pub enum AppError {
    /// 分類の定まっていない一般エラー。メッセージのみをフロントへ伝える。
    #[error("{0}")]
    Internal(String),
    /// 画面収録権限が未許可(NFR-002、`capture::RunError::PermissionDenied` の
    /// 変換先)。フロントエンドが専用の案内導線(T08)へ分岐できるよう、
    /// `Internal` とは別のバリアントにする。`AppError` は文字列として
    /// シリアライズされる(下記 `Serialize` 実装、T02 決定)ため、判別可能な
    /// 固定文字列 `"permission_denied"` をそのまま `Display` の出力にする。
    #[error("permission_denied")]
    PermissionDenied,
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::AppError;

    #[test]
    fn internal_エラーのdisplayはメッセージそのものを返す() {
        let err = AppError::Internal("boom".to_string());
        assert_eq!(err.to_string(), "boom");
    }

    #[test]
    fn internal_エラーはjson文字列としてシリアライズされる() {
        let err = AppError::Internal("boom".to_string());
        let json = serde_json::to_string(&err).expect("シリアライズに失敗した");
        assert_eq!(json, "\"boom\"");
    }

    #[test]
    fn permission_denied_エラーのdisplayは固定文字列を返す() {
        let err = AppError::PermissionDenied;
        assert_eq!(err.to_string(), "permission_denied");
    }

    #[test]
    fn permission_denied_エラーはjson文字列としてシリアライズされる() {
        let err = AppError::PermissionDenied;
        let json = serde_json::to_string(&err).expect("シリアライズに失敗した");
        assert_eq!(json, "\"permission_denied\"");
    }
}
