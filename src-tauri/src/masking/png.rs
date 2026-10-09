//! PNG の署名と IHDR(幅・高さ)の検証(ARCH_auto-masking §7.2)。
//!
//! Vision へ渡す前に、入力が PNG の形をしていて大きすぎないことだけを確かめる。画像は展開しない。
//! チャンクの並び(長さ・種類)をたどって途中で切れていないかも見るが、CRC は確かめない
//! (壊れた本文は Vision 側の失敗として `ScanError` になる)。

use super::ScanError;

/// 幅・高さの上限(各辺、ピクセル)【仮定: ARCH §7.2 の例示値】。
pub(super) const MAX_DIMENSION: u32 = 16_384;

/// 本文(PNG のバイト列全体)のサイズ上限【仮定: ARCH §7.2 の例示値。128MB】。
pub(super) const MAX_PNG_BYTES: usize = 128 * 1024 * 1024;

/// IHDR から読んだ画像の大きさ(ピクセル)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ImageSize {
    pub(super) width: u32,
    pub(super) height: u32,
}

/// PNG の形と大きさを確かめ、IHDR の幅・高さを返す。
pub(super) fn validate(bytes: &[u8]) -> Result<ImageSize, ScanError> {
    validate_with_limit(bytes, MAX_PNG_BYTES)
}

/// `validate` の本体。本文のサイズ上限を引数で受け取る(テストで巨大なバイト列を作らずに済ませるため)。
fn validate_with_limit(bytes: &[u8], max_bytes: usize) -> Result<ImageSize, ScanError> {
    if bytes.len() > max_bytes {
        return Err(ScanError::ImageTooLarge);
    }
    let body = bytes.strip_prefix(&SIGNATURE).ok_or(ScanError::InvalidPng)?;

    // 先頭のチャンクは長さ 13 の IHDR(PNG の仕様)。幅・高さはその先頭 8 バイト(ビッグエンディアン)。
    let (kind, data, _) = next_chunk(body).ok_or(ScanError::InvalidPng)?;
    if kind != *b"IHDR" || data.len() != IHDR_LEN {
        return Err(ScanError::InvalidPng);
    }
    let width = read_u32(&data[0..4]);
    let height = read_u32(&data[4..8]);
    if width == 0 || height == 0 {
        return Err(ScanError::InvalidPng);
    }
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(ScanError::ImageTooLarge);
    }

    // 途中で切れていないか: チャンクの並びをたどり、本文の内側で IEND に届くこと。
    let mut rest = body;
    loop {
        let (kind, _, next) = next_chunk(rest).ok_or(ScanError::InvalidPng)?;
        if kind == *b"IEND" {
            return Ok(ImageSize { width, height });
        }
        rest = next;
    }
}

/// PNG の署名(8 バイト)。
const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// IHDR の本文の長さ(バイト)。
const IHDR_LEN: usize = 13;

/// 先頭のチャンクを読み、(種類, 本文, 残り)を返す。長さ(4)・種類(4)・本文・CRC(4)が
/// `bytes` の内側に収まらなければ `None`。
fn next_chunk(bytes: &[u8]) -> Option<([u8; 4], &[u8], &[u8])> {
    let len = usize::try_from(read_u32(bytes.get(0..4)?)).ok()?;
    let kind: [u8; 4] = bytes.get(4..8)?.try_into().ok()?;
    let data_end = 8usize.checked_add(len)?;
    let chunk_end = data_end.checked_add(4)?;
    let data = bytes.get(8..data_end)?;
    let rest = bytes.get(chunk_end..)?;
    Some((kind, data, rest))
}

/// 4 バイトをビッグエンディアンの `u32` として読む。呼び出し側が長さ 4 を保証する。
fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Python の zlib で作った正しい 1×1 の PNG(RGBA・CRC も正しい)。
    const PNG_1X1: [u8; 68] = [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60,
        0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01, 0x7a, 0x5e, 0xab, 0x3f, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    /// チャンク 1 つ(長さ・種類・本文・CRC)。検証は CRC を見ないので 0 を入れる。
    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&[0, 0, 0, 0]);
        out
    }

    /// 署名 + IHDR(幅・高さ指定)+ 空でない IDAT + IEND の PNG の形をしたバイト列。
    fn png_with_size(width: u32, height: u32) -> Vec<u8> {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&width.to_be_bytes());
        ihdr.extend_from_slice(&height.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut out = PNG_1X1[..8].to_vec();
        out.extend(chunk(b"IHDR", &ihdr));
        out.extend(chunk(b"IDAT", &[0x78, 0x9c, 0x03, 0x00]));
        out.extend(chunk(b"IEND", &[]));
        out
    }

    #[test]
    fn 正しい1x1のpngは大きさを返す() {
        assert_eq!(validate(&PNG_1X1), Ok(ImageSize { width: 1, height: 1 }));
    }

    #[test]
    fn 幅が上限ちょうどのpngは通る() {
        let png = png_with_size(16_384, 1);
        assert_eq!(validate(&png), Ok(ImageSize { width: 16_384, height: 1 }));
    }

    #[test]
    fn 高さが上限ちょうどのpngは通る() {
        let png = png_with_size(1, 16_384);
        assert_eq!(validate(&png), Ok(ImageSize { width: 1, height: 16_384 }));
    }

    #[test]
    fn 署名が違うと不正() {
        let mut png = PNG_1X1;
        png[1] = b'Q';
        assert_eq!(validate(&png), Err(ScanError::InvalidPng));
    }

    #[test]
    fn 空のバイト列は不正() {
        assert_eq!(validate(&[]), Err(ScanError::InvalidPng));
    }

    #[test]
    fn 幅が0は不正() {
        assert_eq!(validate(&png_with_size(0, 1)), Err(ScanError::InvalidPng));
    }

    #[test]
    fn 高さが0は不正() {
        assert_eq!(validate(&png_with_size(1, 0)), Err(ScanError::InvalidPng));
    }

    #[test]
    fn 幅が16385pxは大きすぎる() {
        assert_eq!(validate(&png_with_size(16_385, 1)), Err(ScanError::ImageTooLarge));
    }

    #[test]
    fn 高さが16385pxは大きすぎる() {
        assert_eq!(validate(&png_with_size(1, 16_385)), Err(ScanError::ImageTooLarge));
    }

    #[test]
    fn 本文が上限ちょうどなら通り上限を超えると大きすぎる() {
        let len = PNG_1X1.len();
        assert_eq!(validate_with_limit(&PNG_1X1, len), Ok(ImageSize { width: 1, height: 1 }));
        assert_eq!(validate_with_limit(&PNG_1X1, len - 1), Err(ScanError::ImageTooLarge));
    }

    #[test]
    fn 本文の上限は128mb() {
        assert_eq!(MAX_PNG_BYTES, 134_217_728);
        assert_eq!(MAX_DIMENSION, 16_384);
    }

    #[test]
    fn 途中で切れたバイト列は不正() {
        // 署名の途中・IHDR の途中・IDAT の途中・IEND の手前、のどこで切れても不正
        for len in [4, 8, 20, 33, 45, PNG_1X1.len() - 12, PNG_1X1.len() - 1] {
            assert_eq!(validate(&PNG_1X1[..len]), Err(ScanError::InvalidPng), "len={len}");
        }
    }

    #[test]
    fn 最初のチャンクがihdrでないと不正() {
        let mut png = PNG_1X1;
        png[12..16].copy_from_slice(b"IDAT");
        assert_eq!(validate(&png), Err(ScanError::InvalidPng));
    }

    #[test]
    fn ihdrの長さが13でないと不正() {
        let mut png = PNG_1X1;
        png[11] = 12;
        assert_eq!(validate(&png), Err(ScanError::InvalidPng));
    }

    #[test]
    fn チャンクの長さが本文の残りを超えると不正() {
        let mut png = png_with_size(1, 1);
        // IDAT の長さ(IHDR の後 = 8 + 25 バイト目から)を極端に大きくする
        png[33..37].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(validate(&png), Err(ScanError::InvalidPng));
    }
}
