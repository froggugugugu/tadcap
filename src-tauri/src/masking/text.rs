// 読み取った文字列の包み(`SensitiveText`)、全角→半角の 1 対 1 正規化、バイト位置 → UTF-16 位置の対応
// (ARCH_auto-masking §5.3・§12)。
//
// このファイルには内側のドキュメントコメントを書かない(モジュールの説明は `mod.rs` の `mod text;` に置く)。
// `SensitiveText` のドキュメントテストがこのファイルを `include!` で取り込むため、ここは
// `std` だけに依存し、`super::`・`crate::` を参照しない(テストモジュールを除く)。

use std::fmt;

/// 読み取った文字列(機密の可能性がある)を包む型。
///
/// - `Debug` は中身を出さず `SensitiveText(<redacted>)` を返す。`{:?}` や `assert_eq!` の失敗表示、
///   `#[derive(Debug)]` した構造体の表示から文字列が漏れないようにする(NFR-002)
/// - `Display` は実装しない。`format!("{}")`・`to_string()` で文字列を組み立てられないようにする
/// - 中身が要るとき(検出規則を当てるとき)だけ `as_str()` で借りる。出力・保存・ログには渡さない
///
/// `Debug` は使える(下のテストが通ることで、取り込み方そのものが正しいことも確かめる):
///
/// ```
/// mod text { include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/masking/text.rs")); }
/// fn needs_debug<T: std::fmt::Debug>() {}
/// needs_debug::<text::SensitiveText>();
/// ```
///
/// `Display` は実装していない(コンパイルに失敗することを確かめる):
///
/// ```compile_fail
/// mod text { include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/masking/text.rs")); }
/// fn needs_display<T: std::fmt::Display>() {}
/// needs_display::<text::SensitiveText>();
/// ```
pub(super) struct SensitiveText(String);

impl SensitiveText {
    pub(super) fn new(text: String) -> Self {
        Self(text)
    }

    /// 中身を借りる。戻り値を出力・保存・ログに渡さないこと。
    pub(super) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SensitiveText {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SensitiveText(<redacted>)")
    }
}

/// 全角英数字・全角記号・全角空白・各種ハイフンを、1 文字 → 1 文字で半角へ置き換える(ARCH §5.3)。
///
/// 1 対 1 の置き換えなので文字数は変わらない。置き換えの前後はどちらも基本多言語面(BMP)の文字のため、
/// UTF-16 の位置も変わらない(正規化後の文字列で作った `Utf16Map` の位置を、そのまま Vision の
/// `NSRange` に使える)。UTF-8 のバイト数は変わる(全角 3 バイト → 半角 1 バイト)ことに注意。
pub(super) fn normalize(text: &SensitiveText) -> SensitiveText {
    SensitiveText(text.0.chars().map(normalize_char).collect())
}

/// 1 文字の置き換え。対象外の文字はそのまま返す。
fn normalize_char(c: char) -> char {
    match c {
        // 全角の英数字・記号(U+FF01〜U+FF5E)は ASCII(U+0021〜U+007E)と 0xFEE0 ずれて並ぶ。
        // 全角ハイフンマイナス(U+FF0D)もここで `-` になる
        '\u{ff01}'..='\u{ff5e}' => char::from_u32(c as u32 - 0xfee0).unwrap_or(c),
        // 全角の円記号 → 円記号(U+00A5)。通貨付きの金額の規則(AM-T16)が半角側だけを見られるように
        '\u{ffe5}' => '\u{a5}',
        // 全角空白
        '\u{3000}' => ' ',
        // 長音・ハイフン・マイナス・en ダッシュ・em ダッシュ(電話番号などの区切りとして読まれる)
        '\u{30fc}' | '\u{2010}' | '\u{2212}' | '\u{2013}' | '\u{2014}' => '-',
        _ => c,
    }
}

/// 文字列のバイト位置 → UTF-16 位置の対応表。文字列そのものは持たない。
///
/// Rust の `str` の位置はバイト単位、Vision の `NSRange` は UTF-16 単位なので、検出器が見つけた
/// 範囲は必ずこれで変換する(取り違えると日本語の行で領域がずれる)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Utf16Map {
    /// 各文字の先頭のバイト位置(昇順)。末尾に文字列の長さを足した番兵を置く
    byte_starts: Vec<usize>,
    /// `byte_starts` と同じ添字の UTF-16 位置
    utf16_starts: Vec<usize>,
}

impl Utf16Map {
    pub(super) fn new(text: &str) -> Self {
        let mut byte_starts = Vec::with_capacity(text.len() + 1);
        let mut utf16_starts = Vec::with_capacity(text.len() + 1);
        let mut utf16 = 0;
        for (byte, c) in text.char_indices() {
            byte_starts.push(byte);
            utf16_starts.push(utf16);
            utf16 += c.len_utf16();
        }
        byte_starts.push(text.len());
        utf16_starts.push(utf16);
        Self { byte_starts, utf16_starts }
    }

    /// バイト位置を UTF-16 位置へ変換する。文字の境界でない・範囲外なら `None`。
    /// 文字列の長さちょうど(末尾)は有効な位置として扱う(範囲の終端に使うため)。
    pub(super) fn utf16_offset(&self, byte: usize) -> Option<usize> {
        let index = self.byte_starts.binary_search(&byte).ok()?;
        Some(self.utf16_starts[index])
    }

    /// バイト単位の範囲を UTF-16 単位の範囲へ変換する。どちらかの端が文字の境界でない・
    /// 始点が終点より後ろなら `None`。
    pub(super) fn utf16_range(&self, bytes: std::ops::Range<usize>) -> Option<std::ops::Range<usize>> {
        if bytes.start > bytes.end {
            return None;
        }
        Some(self.utf16_offset(bytes.start)?..self.utf16_offset(bytes.end)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 失敗時に文字列を表示しないよう、文字列の比較は `assert!(a == b, "固定文言")` で行う。

    fn normalized(input: &str) -> SensitiveText {
        normalize(&SensitiveText::new(input.to_string()))
    }

    #[test]
    fn debugは伏せ字で元の文字列を含まない() {
        let secret = SensitiveText::new("hunter2-山田".to_string());
        let shown = format!("{secret:?}");
        assert!(shown == "SensitiveText(<redacted>)", "Debug の表示が伏せ字でない");
        assert!(!shown.contains("hunter2"), "Debug の表示に元の文字列が含まれる");
        assert!(!shown.contains("山田"), "Debug の表示に元の文字列が含まれる");
        // 包んだ構造体を derive(Debug) しても漏れない
        #[derive(Debug)]
        #[allow(dead_code)]
        struct Line {
            text: SensitiveText,
        }
        let line = format!("{:?}", Line { text: secret });
        assert!(!line.contains("hunter2"), "包んだ構造体の Debug に元の文字列が含まれる");
    }

    #[test]
    fn as_strは中身をそのまま返す() {
        let text = SensitiveText::new("abc 日本".to_string());
        assert!(text.as_str() == "abc 日本", "中身が変わっている");
    }

    #[test]
    fn 全角英数字を半角にする() {
        let out = normalized("ＡＢＣｘｙｚ０１２９");
        assert!(out.as_str() == "ABCxyz0129", "全角英数字が半角になっていない");
    }

    #[test]
    fn 全角記号を半角にする() {
        let out = normalized("！＠＃＄％＆（）＋，．／：；＜＝＞？［］＿｛｜｝～");
        assert!(out.as_str() == "!@#$%&()+,./:;<=>?[]_{|}~", "全角記号が半角になっていない");
    }

    #[test]
    fn 全角の円記号を半角にする() {
        let out = normalized("￥１０００");
        assert!(out.as_str() == "\u{a5}1000", "全角の円記号が半角になっていない");
    }

    #[test]
    fn 全角空白を半角空白にする() {
        let out = normalized("山田\u{3000}太郎");
        assert!(out.as_str() == "山田 太郎", "全角空白が半角になっていない");
    }

    #[test]
    fn 各種ハイフンを半角ハイフンにする() {
        // －(全角)・ー(長音)・‐(ハイフン)・−(マイナス)・–(en ダッシュ)・—(em ダッシュ)
        let out = normalized("0\u{ff0d}1\u{30fc}2\u{2010}3\u{2212}4\u{2013}5\u{2014}6");
        assert!(out.as_str() == "0-1-2-3-4-5-6", "各種ハイフンが半角になっていない");
    }

    #[test]
    fn 対象外の文字はそのまま残す() {
        let input = "abc-123 山田太郎様 ｶﾅ 😀 e\u{301}";
        let out = normalized(input);
        assert!(out.as_str() == input, "対象外の文字が変わっている");
    }

    #[test]
    fn 正規化しても文字数とutf16の長さは変わらない() {
        let inputs = [
            "ＴＥＬ：０３－１２３４－５６７８",
            "メール　ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏｍ",
            "￥１，０００　—　〒１００‐０００１",
            "混在 abc ＡＢＣ 😀 ー",
        ];
        for input in inputs {
            let out = normalized(input);
            assert_eq!(out.as_str().chars().count(), input.chars().count());
            assert_eq!(out.as_str().encode_utf16().count(), input.encode_utf16().count());
        }
    }

    #[test]
    fn 正規化は文字ごとに同じ位置で置き換わる() {
        let input = "Ａ－ｂ　１";
        let out = normalized(input);
        let pairs: Vec<(char, char)> = input.chars().zip(out.as_str().chars()).collect();
        assert_eq!(pairs.len(), 5);
        assert!(pairs.iter().map(|p| p.1).collect::<String>() == "A-b 1", "位置がずれている");
    }

    #[test]
    fn asciiだけの行はバイト位置とutf16位置が同じ() {
        let line = "user@example.com";
        let map = Utf16Map::new(line);
        for byte in 0..=line.len() {
            assert_eq!(map.utf16_offset(byte), Some(byte));
        }
        assert_eq!(map.utf16_offset(line.len() + 1), None);
    }

    #[test]
    fn 日本語の行は1文字3バイトが1単位になる() {
        // "電話:03" = 電(3)話(3):(1)0(1)3(1)
        let map = Utf16Map::new("電話:03");
        assert_eq!(map.utf16_offset(0), Some(0));
        assert_eq!(map.utf16_offset(3), Some(1));
        assert_eq!(map.utf16_offset(6), Some(2));
        assert_eq!(map.utf16_offset(7), Some(3));
        assert_eq!(map.utf16_offset(9), Some(5));
        // 文字の途中は None
        assert_eq!(map.utf16_offset(1), None);
        assert_eq!(map.utf16_offset(4), None);
        assert_eq!(map.utf16_range(7..9), Some(3..5));
        assert_eq!(map.utf16_range(0..6), Some(0..2));
        assert_eq!(map.utf16_range(2..7), None);
        // 始点が終点より後ろは None
        #[allow(clippy::reversed_empty_ranges)]
        let reversed = 7..3;
        assert_eq!(map.utf16_range(reversed), None);
    }

    #[test]
    fn 絵文字はサロゲートペアで2単位になる() {
        // "a😀b" = a(1)😀(4)b(1)、UTF-16 では a(1)😀(2)b(1)
        let map = Utf16Map::new("a\u{1f600}b");
        assert_eq!(map.utf16_offset(1), Some(1));
        assert_eq!(map.utf16_offset(5), Some(3));
        assert_eq!(map.utf16_offset(6), Some(4));
        assert_eq!(map.utf16_offset(2), None);
        assert_eq!(map.utf16_range(5..6), Some(3..4));
        // 日本語と絵文字の混在: "様😀03" = 様(3)😀(4)0(1)3(1)
        let map = Utf16Map::new("様\u{1f600}03");
        assert_eq!(map.utf16_range(7..9), Some(3..5));
    }

    #[test]
    fn 結合文字は独立した1単位として数える() {
        // "e\u{301}x" = e(1) ◌́(2) x(1)、UTF-16 では各 1 単位
        let map = Utf16Map::new("e\u{301}x");
        assert_eq!(map.utf16_offset(1), Some(1));
        assert_eq!(map.utf16_offset(3), Some(2));
        assert_eq!(map.utf16_offset(4), Some(3));
        assert_eq!(map.utf16_offset(2), None);
        // 濁点の結合文字: "か\u{3099}1" = か(3) ゛(3) 1(1)
        let map = Utf16Map::new("か\u{3099}1");
        assert_eq!(map.utf16_range(6..7), Some(2..3));
        assert_eq!(map.utf16_range(0..6), Some(0..2));
    }

    #[test]
    fn 空文字列は位置0だけが有効() {
        let map = Utf16Map::new("");
        assert_eq!(map.utf16_offset(0), Some(0));
        assert_eq!(map.utf16_offset(1), None);
        assert_eq!(map.utf16_range(0..0), Some(0..0));
    }

    #[test]
    fn 正規化後の文字列で作った対応表の位置は元の文字列のutf16位置と一致する() {
        let input = "ＴＥＬ：０３－１２３４😀ー５";
        let out = normalized(input);
        let map = Utf16Map::new(out.as_str());
        let original_utf16: Vec<usize> = input
            .chars()
            .scan(0, |acc, c| {
                let start = *acc;
                *acc += c.len_utf16();
                Some(start)
            })
            .collect();
        let normalized_bytes: Vec<usize> = out.as_str().char_indices().map(|(i, _)| i).collect();
        assert_eq!(original_utf16.len(), normalized_bytes.len());
        for (byte, utf16) in normalized_bytes.into_iter().zip(original_utf16) {
            assert_eq!(map.utf16_offset(byte), Some(utf16));
        }
    }
}
