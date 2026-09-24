//! クリップボード書込のRustフォールバック(ARCH §3.1 Rust clipboard層、§4
//! `src-tauri/src/clipboard/`、FR-005、T12)。
//!
//! `@tauri-apps/plugin-clipboard-manager` の `writeImage()`(主経路)が失敗した
//! 場合のみ `commands::write_image_fallback` から呼ばれる。`arboard::Clipboard::set_image`
//! はPNG/ICO等のデコードを行わず、生のRGBA8ピクセル列(`width * height * 4` バイト、
//! 行優先。docs.rs `arboard::ImageData` 参照)を要求する。フロントエンドはCanvasの
//! `getImageData()` 由来のRGBAをそのまま渡す設計にした(PNGバイト列をデコードする
//! クレート(`image`/`png`等)を追加しないための判断。ARCH §2・§15決定#3は `arboard`
//! のみをフォールバックの追加依存として承認しており、デコード用クレートの追加は
//! 範囲外と判断した。詳細はT12実装報告・project-config.md §11参照)。

use std::borrow::Cow;

use arboard::{Clipboard, ImageData};
use thiserror::Error;

/// 画像の1辺(width/height)ごとの上限ピクセル数(セキュリティHIGH対応、Phase5指摘)。
///
/// `write_image_fallback`/[`validate_rgba`] はフロントエンドから渡された `width`/
/// `height` をそのまま `width * height * 4` の掛け算に使う。上限を設けないと
/// 巨大な値(バグ・悪意のいずれでも)で桁あふれや過大メモリ確保を招きうる。実運用で
/// 想定される最大画面(8K相当、7680x4320)を余裕を持って上回る値として16384px
/// (16K)を採用する。上限値はこの定数1か所にのみ定義し、
/// `commands::parse_image_dimensions` からもこの値を参照する(重複回避)。
pub const MAX_IMAGE_DIMENSION: usize = 16_384;

/// RGBA8バイト列(`width * height * 4`)の総バイト数の上限(セキュリティHIGH対応、
/// Phase5指摘)。
///
/// [`MAX_IMAGE_DIMENSION`] 同士の掛け算(16384 x 16384 x 4 ≈ 1GiB)は正方形に近い
/// 巨大画像まで許してしまうため、実運用で想定される最大サイズ(8K相当、約127MB。
/// `commands.rs` 既存コメントの「5K Retina全画面キャプチャ相当」も参照)に余裕を
/// 持たせた256MiBを総バイト数の上限として別途設ける。
pub const MAX_IMAGE_BYTES: usize = 256 * 1024 * 1024;

/// フォールバック書込の失敗。
///
/// [`validate_rgba`] による入力検証はOS権限・実クリップボードに依存しないため
/// ユニットテスト可能(T12指示「Rust側の入力検証(空・不正バイト列)」)。実際の
/// クリップボード書込(`Clipboard::new`/`set_image`)はOS依存のため自動テスト対象外
/// とし、手動確認チェックリスト#5(実クリップボードへの貼付確認)へ回す。
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ClipboardFallbackError {
    /// `width`/`height` のいずれかが0(画像として成立しない)。
    #[error("画像サイズが不正です(width/heightは1以上である必要がある)")]
    InvalidDimensions,
    /// `width`/`height` が [`MAX_IMAGE_DIMENSION`] を超える、総バイト数が
    /// [`MAX_IMAGE_BYTES`] を超える、または `width * height * 4` の乗算が
    /// 桁あふれする場合(セキュリティHIGH対応、Phase5指摘)。
    #[error("画像サイズが上限を超えています(width={width}, height={height})")]
    DimensionTooLarge { width: usize, height: usize },
    /// RGBAバイト列の長さが `width * height * 4` と一致しない(空バイト列を含む)。
    #[error(
        "RGBAバイト列の長さがwidth*height*4と一致しません(expected={expected}, actual={actual})"
    )]
    LengthMismatch { expected: usize, actual: usize },
    /// `arboard` によるOSクリップボードへの実書込失敗(OS依存、手動確認へ回す)。
    #[error("クリップボードへの書き込みに失敗しました: {0}")]
    Clipboard(String),
}

/// `width * height * 4` を桁あふれ検出付きで計算する純粋関数(セキュリティHIGH対応、
/// Phase5指摘)。
///
/// [`MAX_IMAGE_DIMENSION`]/[`MAX_IMAGE_BYTES`] による実用上限チェックとは独立に、
/// `checked_mul` で乗算そのものの桁あふれも検出する(防御多層化。上限チェックの
/// 実装が将来変わっても安全側に倒れるようにするための保険)。
fn checked_rgba_byte_len(width: usize, height: usize) -> Option<usize> {
    width.checked_mul(height)?.checked_mul(4)
}

/// `width`/`height`/`bytes`(RGBA8、行優先)の整合性を検証する純粋関数。
///
/// `width`/`height` が0、[`MAX_IMAGE_DIMENSION`] を超える、`width * height * 4` が
/// [`MAX_IMAGE_BYTES`] を超える(または乗算が桁あふれする)、あるいは
/// `bytes.len()` が `width * height * 4` と一致しない(空バイト列を含む)場合は
/// エラーを返す。Tauri・OSクリップボードに依存しないため `cargo test` で直接
/// 検証できる。
pub fn validate_rgba(
    width: usize,
    height: usize,
    bytes: &[u8],
) -> Result<(), ClipboardFallbackError> {
    if width == 0 || height == 0 {
        return Err(ClipboardFallbackError::InvalidDimensions);
    }
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(ClipboardFallbackError::DimensionTooLarge { width, height });
    }
    let expected = checked_rgba_byte_len(width, height)
        .ok_or(ClipboardFallbackError::DimensionTooLarge { width, height })?;
    if expected > MAX_IMAGE_BYTES {
        return Err(ClipboardFallbackError::DimensionTooLarge { width, height });
    }
    if bytes.len() != expected {
        return Err(ClipboardFallbackError::LengthMismatch {
            expected,
            actual: bytes.len(),
        });
    }
    Ok(())
}

/// RGBA8ピクセル列をOSクリップボードへ書き込む(`commands::write_image_fallback`
/// から呼ばれる)。
///
/// [`validate_rgba`] で入力を検証してから `arboard::Clipboard` を初期化し書き込む。
/// 実際のOS呼び出し(`Clipboard::new`/`set_image`)は自動テスト対象外(手動確認
/// チェックリスト#5)。
pub fn write_image_fallback(
    width: usize,
    height: usize,
    bytes: Vec<u8>,
) -> Result<(), ClipboardFallbackError> {
    validate_rgba(width, height, &bytes)?;
    let mut clipboard =
        Clipboard::new().map_err(|e| ClipboardFallbackError::Clipboard(e.to_string()))?;
    clipboard
        .set_image(ImageData {
            width,
            height,
            bytes: Cow::from(bytes),
        })
        .map_err(|e| ClipboardFallbackError::Clipboard(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rgba_は幅がゼロなら不正サイズエラーを返す() {
        let err = validate_rgba(0, 10, &[]).unwrap_err();
        assert_eq!(err, ClipboardFallbackError::InvalidDimensions);
    }

    #[test]
    fn validate_rgba_は高さがゼロなら不正サイズエラーを返す() {
        let err = validate_rgba(10, 0, &[]).unwrap_err();
        assert_eq!(err, ClipboardFallbackError::InvalidDimensions);
    }

    #[test]
    fn validate_rgba_は空バイト列なら長さ不一致エラーを返す() {
        let err = validate_rgba(2, 1, &[]).unwrap_err();
        assert_eq!(
            err,
            ClipboardFallbackError::LengthMismatch {
                expected: 8,
                actual: 0,
            }
        );
    }

    #[test]
    fn validate_rgba_は長さが一致しないバイト列を拒否する() {
        let bytes = vec![0u8; 7];
        let err = validate_rgba(2, 1, &bytes).unwrap_err();
        assert_eq!(
            err,
            ClipboardFallbackError::LengthMismatch {
                expected: 8,
                actual: 7,
            }
        );
    }

    #[test]
    fn validate_rgba_は正しい長さのバイト列を受理する() {
        let bytes = vec![0u8; 8];
        assert!(validate_rgba(2, 1, &bytes).is_ok());
    }

    #[test]
    fn clipboard_fallback_errorのdisplayはバリアントごとに異なるメッセージを返す() {
        assert_eq!(
            ClipboardFallbackError::InvalidDimensions.to_string(),
            "画像サイズが不正です(width/heightは1以上である必要がある)"
        );
        assert_eq!(
            ClipboardFallbackError::DimensionTooLarge {
                width: 99_999,
                height: 1
            }
            .to_string(),
            "画像サイズが上限を超えています(width=99999, height=1)"
        );
        assert_eq!(
            ClipboardFallbackError::LengthMismatch {
                expected: 4,
                actual: 3
            }
            .to_string(),
            "RGBAバイト列の長さがwidth*height*4と一致しません(expected=4, actual=3)"
        );
        assert_eq!(
            ClipboardFallbackError::Clipboard("boom".to_string()).to_string(),
            "クリップボードへの書き込みに失敗しました: boom"
        );
    }

    /// [`checked_rgba_byte_len`](セキュリティHIGH対応、Phase5指摘)のテスト。
    #[test]
    fn checked_rgba_byte_lenは通常サイズを正しく計算する() {
        assert_eq!(checked_rgba_byte_len(2, 1), Some(8));
    }

    #[test]
    fn checked_rgba_byte_lenは乗算オーバーフローでnoneを返す() {
        assert_eq!(checked_rgba_byte_len(usize::MAX, 2), None);
        assert_eq!(checked_rgba_byte_len(usize::MAX / 3, 4), None);
    }

    /// `validate_rgba` の上限チェック(セキュリティHIGH対応、Phase5指摘)。
    #[test]
    fn validate_rgba_はwidthが上限を超えると拒否する() {
        let width = MAX_IMAGE_DIMENSION + 1;
        let err = validate_rgba(width, 1, &[]).unwrap_err();
        assert_eq!(
            err,
            ClipboardFallbackError::DimensionTooLarge { width, height: 1 }
        );
    }

    #[test]
    fn validate_rgba_はheightが上限を超えると拒否する() {
        let height = MAX_IMAGE_DIMENSION + 1;
        let err = validate_rgba(1, height, &[]).unwrap_err();
        assert_eq!(
            err,
            ClipboardFallbackError::DimensionTooLarge { width: 1, height }
        );
    }

    #[test]
    fn validate_rgba_は各辺の上限ちょうどの値を受理する() {
        let bytes = vec![0u8; MAX_IMAGE_DIMENSION * 4];
        assert!(validate_rgba(MAX_IMAGE_DIMENSION, 1, &bytes).is_ok());
    }

    #[test]
    fn validate_rgba_は各辺の上限以内でも総バイト数が上限を超えると拒否する() {
        let err =
            validate_rgba(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, &[]).unwrap_err();
        assert_eq!(
            err,
            ClipboardFallbackError::DimensionTooLarge {
                width: MAX_IMAGE_DIMENSION,
                height: MAX_IMAGE_DIMENSION,
            }
        );
    }

    #[test]
    fn validate_rgba_は総バイト数がちょうど上限のとき受理する() {
        let width = 8_192;
        let height = 8_192;
        let expected = width * height * 4;
        assert_eq!(expected, MAX_IMAGE_BYTES);
        let bytes = vec![0u8; expected];
        assert!(validate_rgba(width, height, &bytes).is_ok());
    }

    #[test]
    fn validate_rgba_は巨大な数値2の32乗を上限超過として拒否する() {
        let huge = 4_294_967_296usize; // 2^32
        let err = validate_rgba(huge, 1, &[]).unwrap_err();
        assert_eq!(
            err,
            ClipboardFallbackError::DimensionTooLarge {
                width: huge,
                height: 1
            }
        );
    }
}
