//! 撮った PNG の解像度の情報(pHYs チャンク)から画面の倍率を読む(ARCH_quick-edits §1.3 #10・§7.1 R-2)。
//!
//! 署名を確かめ、IDAT に着くまでチャンクの見出し(長さ・種類)を順にたどり、pHYs の 9 バイトだけを読む。
//! 画像は展開しない。読めない・壊れている・想定外の値はすべて `None`(縮めない側に倒す)。
//! 自動マスキングの PNG の検証と処理は似ているが共有しない(ARCH_quick-edits §3.2)。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// PNG の署名(8 バイト)。
const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// チャンクの本文の長さの上限(PNG の仕様: 2³¹−1)。
const MAX_CHUNK_LEN: u32 = 0x7fff_ffff;

/// pHYs の本文の長さ(横 4 + 縦 4 + 単位 1)。
const PHYS_LEN: usize = 9;

/// pHYs の単位「メートル」。0 は「単位不明(縦横比だけ)」で、倍率には使えない。
const UNIT_METER: u8 = 1;

/// 倍率 1 / 2 とみなす解像度(dpi)と許容幅(±%)。
///
/// 【仮定】許容幅 ±2%(TASK_quick-edits QE-T01/T04 の基準): OS が書く値は 72dpi・144dpi を
/// ピクセル/メートルへ換算して整数に丸めたもの(2835・5669。QE-T01 の実機確認で 5669)で、
/// 丸めの誤差は 0.02% 未満。一方、隣の倍率(1.5 倍 = 108dpi、3 倍 = 216dpi)とは 25% 以上離れている。
/// ±2% は丸めの誤差を十分に含み、別の倍率を取り違えない幅として選んだ。
const RATIO_DPI: [(u8, u64); 2] = [(1, 72), (2, 144)];
const TOLERANCE_PERCENT: u64 = 2;

/// PNG のバイト列から画面の倍率(`Some(1)` / `Some(2)`)を返す。分からなければ `None`。
///
/// アプリ本体は [`read_pixel_ratio`](ファイル版)だけを使う。バイト列版はテストと
/// 将来の別の撮影方式のための純粋な入口(ARCH_quick-edits §5.1)。
#[cfg_attr(not(test), allow(dead_code))]
pub fn pixel_ratio_from_png(bytes: &[u8]) -> Option<u8> {
    let total_len = u64::try_from(bytes.len()).ok()?;
    pixel_ratio_from_reader(&mut std::io::Cursor::new(bytes), total_len)
}

/// PNG ファイルの先頭(IDAT まで)だけを読み、画面の倍率を返す。開けない・読めなければ `None`。
pub fn read_pixel_ratio(path: &Path) -> Option<u8> {
    let mut file = File::open(path).ok()?;
    let total_len = file.metadata().ok()?.len();
    pixel_ratio_from_reader(&mut file, total_len)
}

/// 署名を確かめ、IDAT に着くまでチャンクの見出しをたどって pHYs を探す。
///
/// 各チャンクは「本文 + CRC」が残りの長さに収まることを、読み飛ばす前に確かめる
/// (途中で切れたファイル・長さを偽ったチャンクで先へ進まない)。CRC は確かめない。
fn pixel_ratio_from_reader<R: Read + Seek>(reader: &mut R, total_len: u64) -> Option<u8> {
    let mut signature = [0u8; 8];
    reader.read_exact(&mut signature).ok()?;
    if signature != SIGNATURE {
        return None;
    }
    let mut pos: u64 = 8;
    loop {
        let mut header = [0u8; 8];
        reader.read_exact(&mut header).ok()?;
        pos += 8;
        let len = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
        if len > MAX_CHUNK_LEN {
            return None;
        }
        // 本文 + CRC(4 バイト)
        let chunk_rest = u64::from(len) + 4;
        if chunk_rest > total_len.saturating_sub(pos) {
            return None;
        }
        match &header[4..8] {
            // 画像の本体より後の pHYs は見ない(仕様では IDAT より前に置く)
            b"IDAT" | b"IEND" => return None,
            b"pHYs" => {
                if usize::try_from(len).ok()? != PHYS_LEN {
                    return None;
                }
                let mut data = [0u8; PHYS_LEN];
                reader.read_exact(&mut data).ok()?;
                return ratio_from_phys(&data);
            }
            _ => {
                reader
                    .seek(SeekFrom::Current(i64::try_from(chunk_rest).ok()?))
                    .ok()?;
                pos += chunk_rest;
            }
        }
    }
}

/// pHYs の本文(9 バイト)を倍率にする。単位がメートルで縦横が同じときだけ判定する。
fn ratio_from_phys(data: &[u8; PHYS_LEN]) -> Option<u8> {
    let x = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
    let y = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
    if data[8] != UNIT_METER || x != y {
        return None;
    }
    // dpi = ppm × 0.0254。浮動小数点を避け、両辺を 10000 × 100 倍した整数で比べる
    // (ppm × 254 × 100 が dpi × 10000 × (100 ± 許容幅) の内側か)。u32 の最大でも u64 に収まる。
    let scaled = u64::from(x) * 254 * 100;
    RATIO_DPI.iter().find_map(|&(ratio, dpi)| {
        let target = dpi * 10_000;
        let low = target * (100 - TOLERANCE_PERCENT);
        let high = target * (100 + TOLERANCE_PERCENT);
        (low..=high).contains(&scaled).then_some(ratio)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// チャンク 1 つ(長さ・種類・本文・CRC)。読み取りは CRC を見ないので 0 を入れる。
    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&[0, 0, 0, 0]);
        out
    }

    /// pHYs の本文(横・縦のピクセル/単位、単位)。
    fn phys(x: u32, y: u32, unit: u8) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&x.to_be_bytes());
        out.extend_from_slice(&y.to_be_bytes());
        out.push(unit);
        out
    }

    fn ihdr() -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&1u32.to_be_bytes());
        data.extend_from_slice(&1u32.to_be_bytes());
        data.extend_from_slice(&[8, 6, 0, 0, 0]);
        chunk(b"IHDR", &data)
    }

    /// 署名 + IHDR + 指定のチャンク群 + IDAT + IEND。
    fn png_with(before_idat: &[Vec<u8>]) -> Vec<u8> {
        let mut out = SIGNATURE.to_vec();
        out.extend(ihdr());
        for c in before_idat {
            out.extend_from_slice(c);
        }
        out.extend(chunk(b"IDAT", &[0x78, 0x9c, 0x03, 0x00]));
        out.extend(chunk(b"IEND", &[]));
        out
    }

    /// 縦横同じ ppm・単位メートルの pHYs を IDAT の前に持つ PNG。
    fn png_with_ppm(ppm: u32) -> Vec<u8> {
        png_with(&[chunk(b"pHYs", &phys(ppm, ppm, 1))])
    }

    #[test]
    fn 実機と同じ5669ppmは倍率2() {
        // QE-T01 の実機確認: 内蔵の高精細画面の全画面で 5669 px/m(≒144dpi)
        assert_eq!(pixel_ratio_from_png(&png_with_ppm(5669)), Some(2));
    }

    #[test]
    fn dpi72相当の2835ppmは倍率1() {
        assert_eq!(pixel_ratio_from_png(&png_with_ppm(2835)), Some(1));
    }

    #[test]
    fn dpi72の2パーセントの内側は倍率1で外側は不明() {
        // 72dpi ±2% = 70.56〜73.44dpi = 2777.95〜2891.34 px/m
        assert_eq!(pixel_ratio_from_png(&png_with_ppm(2778)), Some(1));
        assert_eq!(pixel_ratio_from_png(&png_with_ppm(2891)), Some(1));
        assert_eq!(pixel_ratio_from_png(&png_with_ppm(2777)), None);
        assert_eq!(pixel_ratio_from_png(&png_with_ppm(2892)), None);
    }

    #[test]
    fn dpi144の2パーセントの内側は倍率2で外側は不明() {
        // 144dpi ±2% = 141.12〜146.88dpi = 5555.91〜5782.68 px/m
        assert_eq!(pixel_ratio_from_png(&png_with_ppm(5556)), Some(2));
        assert_eq!(pixel_ratio_from_png(&png_with_ppm(5782)), Some(2));
        assert_eq!(pixel_ratio_from_png(&png_with_ppm(5555)), None);
        assert_eq!(pixel_ratio_from_png(&png_with_ppm(5783)), None);
    }

    #[test]
    fn 倍率1と2以外の解像度は不明() {
        // 108dpi(1.5 倍)・216dpi(3 倍)・0
        for ppm in [4252, 8504, 0, u32::MAX] {
            assert_eq!(pixel_ratio_from_png(&png_with_ppm(ppm)), None, "ppm={ppm}");
        }
    }

    #[test]
    fn phys無しは不明() {
        assert_eq!(pixel_ratio_from_png(&png_with(&[])), None);
    }

    #[test]
    fn 単位が不明の0なら不明() {
        let png = png_with(&[chunk(b"pHYs", &phys(5669, 5669, 0))]);
        assert_eq!(pixel_ratio_from_png(&png), None);
    }

    #[test]
    fn 単位が1でも0でもなければ不明() {
        let png = png_with(&[chunk(b"pHYs", &phys(5669, 5669, 2))]);
        assert_eq!(pixel_ratio_from_png(&png), None);
    }

    #[test]
    fn 縦横が違うと不明() {
        let png = png_with(&[chunk(b"pHYs", &phys(5669, 2835, 1))]);
        assert_eq!(pixel_ratio_from_png(&png), None);
    }

    #[test]
    fn physの長さが9でないと不明() {
        let mut data = phys(5669, 5669, 1);
        data.push(0);
        let png = png_with(&[chunk(b"pHYs", &data)]);
        assert_eq!(pixel_ratio_from_png(&png), None);
    }

    #[test]
    fn 署名が違うと不明() {
        let mut png = png_with_ppm(5669);
        png[1] = b'Q';
        assert_eq!(pixel_ratio_from_png(&png), None);
    }

    #[test]
    fn 空のバイト列は不明() {
        assert_eq!(pixel_ratio_from_png(&[]), None);
    }

    #[test]
    fn 他のチャンクを読み飛ばしてphysを読む() {
        let png = png_with(&[
            chunk(b"sRGB", &[0]),
            chunk(b"iCCP", &[1; 300]),
            chunk(b"pHYs", &phys(5669, 5669, 1)),
        ]);
        assert_eq!(pixel_ratio_from_png(&png), Some(2));
    }

    #[test]
    fn idatより後のphysは見ない() {
        let mut png = SIGNATURE.to_vec();
        png.extend(ihdr());
        png.extend(chunk(b"IDAT", &[0x78, 0x9c, 0x03, 0x00]));
        png.extend(chunk(b"pHYs", &phys(5669, 5669, 1)));
        png.extend(chunk(b"IEND", &[]));
        assert_eq!(pixel_ratio_from_png(&png), None);
    }

    #[test]
    fn チャンクの長さがファイルの残りを超えると不明() {
        // IHDR の後に、残りより長い長さを名乗る sRGB を置く(pHYs はその後ろ)
        let mut png = SIGNATURE.to_vec();
        png.extend(ihdr());
        let mut bogus = chunk(b"sRGB", &[0]);
        bogus[0..4].copy_from_slice(&1_000_000u32.to_be_bytes());
        png.extend(bogus);
        png.extend(chunk(b"pHYs", &phys(5669, 5669, 1)));
        png.extend(chunk(b"IDAT", &[0x78, 0x9c, 0x03, 0x00]));
        assert_eq!(pixel_ratio_from_png(&png), None);
    }

    #[test]
    fn チャンクの長さが2の31乗引く1を超えると不明() {
        for len in [0x8000_0000u32, u32::MAX] {
            let mut png = SIGNATURE.to_vec();
            png.extend(ihdr());
            let mut bogus = chunk(b"sRGB", &[0]);
            bogus[0..4].copy_from_slice(&len.to_be_bytes());
            png.extend(bogus);
            assert_eq!(pixel_ratio_from_png(&png), None, "len={len:#x}");
        }
    }

    #[test]
    fn physの長さが残りを超えると不明() {
        let mut png = SIGNATURE.to_vec();
        png.extend(ihdr());
        let mut c = chunk(b"pHYs", &phys(5669, 5669, 1));
        c[0..4].copy_from_slice(&u32::MAX.to_be_bytes());
        png.extend(c);
        assert_eq!(pixel_ratio_from_png(&png), None);
    }

    #[test]
    fn 途中で切れたバイト列は不明() {
        let png = png_with_ppm(5669);
        // IHDR の後に pHYs が来る: 署名 8 + IHDR 25 = 33 から pHYs(長さ 4・種類 4・本文 9・CRC 4)
        for len in [0, 4, 8, 12, 20, 33, 36, 40, 45, 49] {
            assert_eq!(pixel_ratio_from_png(&png[..len]), None, "len={len}");
        }
    }

    #[test]
    fn physのcrcの途中で切れていると不明() {
        // pHYs の本文の直後(CRC の途中)で切れる: チャンクが完結していないので信じない
        let png = png_with_ppm(5669);
        assert_eq!(pixel_ratio_from_png(&png[..33 + 8 + 9 + 2]), None);
    }

    #[test]
    fn read_pixel_ratioはファイルの先頭から倍率を読む() {
        let path = std::env::temp_dir().join(format!(
            "tadcap-pixel-ratio-test-{}.png",
            std::process::id()
        ));
        std::fs::write(&path, png_with_ppm(5669)).expect("テスト用ファイルを書けるはず");
        let ratio = read_pixel_ratio(&path);
        std::fs::remove_file(&path).expect("テスト用ファイルを消せるはず");
        assert_eq!(ratio, Some(2));
    }

    #[test]
    fn read_pixel_ratioは存在しないファイルなら不明() {
        let path = std::env::temp_dir().join("tadcap-pixel-ratio-test-missing.png");
        assert_eq!(read_pixel_ratio(&path), None);
    }
}
