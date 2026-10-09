//! ①連絡先: メール・電話番号・住所(FR-003・FR-007)。メール・電話番号・郵便番号は AM-T11、都道府県で始まる住所は AM-T22 で実装する。

//!
//! 正規化(全角→半角)後の文字列に規則を当てる。正規表現は線形時間の `regex` クレートだけを使い、
//! 電話番号は数字の組を左から読む手書きの走査(1 つの開始位置につき読む長さに上限がある)で判定する。

use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use super::super::{Match, MatchDetail, RecognizedPage};
use super::lexicon::{ELEVEN_DIGIT_PHONE_PREFIXES, JP_COUNTRY_CODE, POSTAL_MARK};
use super::Line;

/// メール。`@` と `.` の前後に読み取りで入った空白(1 つ)を許す。
///
/// - ドメインの最後は英字 2 文字以上(末尾の `.` や `、` を含めない)
/// - `. ` のように点の**後ろ**に空白があるときは、続く語が小文字・数字で始まる場合だけドメインの続きとみなす
///   (`taro@example.com. Thanks` の文頭の語を含めないため)
/// - ドメインの途中の語(最後の `.` より前)に読み取りで入った空白 1 つは、続きが小文字・数字で始まる場合だけ許す
/// - 最後の `.` が読み取りで落ちた形(`taro@examplejp`)は、ドメインが `DOTLESS_TLDS` のどれかで終わる場合だけ認める
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    let local = r"[A-Za-z0-9_%+\-]+(?:\x20?\.\x20?[A-Za-z0-9_%+\-]+)*";
    let label = r"[A-Za-z0-9][A-Za-z0-9\-]*(?:\x20[a-z0-9][A-Za-z0-9\-]*)?";
    let next_label = r"(?:\x20?\.[A-Za-z0-9][A-Za-z0-9\-]*(?:\x20[a-z0-9][A-Za-z0-9\-]*)?|\x20?\.\x20[a-z0-9][A-Za-z0-9\-]*)";
    let tld = r"(?:\x20?\.[A-Za-z]{2,}|\x20?\.\x20[a-z][A-Za-z]+)";
    let dotless = format!(r"[A-Za-z0-9][A-Za-z0-9\-]*(?:{})\b", DOTLESS_TLDS.join("|"));
    Regex::new(&format!(r"{local}\x20?@\x20?(?:{label}{next_label}*{tld}|{dotless})")).expect("固定の正規表現が不正")
});

/// 最後の `.` が落ちたドメインの終わりとして認める TLD(評価画像の読み取りで落ちた形。AM-T19)。
const DOTLESS_TLDS: [&str; 4] = ["com", "net", "org", "jp"];

/// 郵便番号。`〒` + 7 桁(ハイフン・空白は任意)、または記号なしの `NNN-NNNN`(ハイフン必須)。
static POSTAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"{POSTAL_MARK}\x20?[0-9]{{3}}(?:\x20?-\x20?)?[0-9]{{4}}|[0-9]{{3}}-[0-9]{{4}}"))
        .expect("固定の正規表現が不正")
});

/// ①連絡先の検出器。行ごとに独立して判定する(ページの位置は使わない)。
pub(super) fn detect(_page: &dyn RecognizedPage, lines: &[Line]) -> Vec<Match> {
    let mut matches = Vec::new();
    for line in lines {
        let text = line.as_str();
        let found = find_emails(text)
            .map(|r| (r, MatchDetail::Email))
            .chain(find_phones(text).into_iter().map(|r| (r, MatchDetail::Phone)))
            .chain(find_postal_codes(text).map(|r| (r, MatchDetail::Address)));
        matches.extend(found.filter_map(|(range, detail)| line.to_match(range, detail)));
    }
    matches
}

fn find_emails(text: &str) -> impl Iterator<Item = Range<usize>> + '_ {
    EMAIL.find_iter(text).map(|m| m.range())
}

fn find_postal_codes(text: &str) -> impl Iterator<Item = Range<usize>> + '_ {
    POSTAL.find_iter(text).map(|m| m.range()).filter(|r| {
        let marked = text[r.clone()].starts_with(POSTAL_MARK);
        (marked || !continues_number_before(text, r.start)) && !continues_number_after(text, r.end)
    })
}

/// `start` の直前が数字、または「数字 + ハイフン/点」なら、もっと長い数字の並びの途中とみなす。
fn continues_number_before(text: &str, start: usize) -> bool {
    let before = &text.as_bytes()[..start];
    match before.last() {
        Some(b) if b.is_ascii_digit() => true,
        Some(b'-' | b'.') => before.len() >= 2 && before[before.len() - 2].is_ascii_digit(),
        _ => false,
    }
}

/// `end` の直後が数字、または「ハイフン + 数字」なら、もっと長い数字の並びの途中とみなす。
/// 空白の後の数字は別の語として扱う(表の隣の列など)。
fn continues_number_after(text: &str, end: usize) -> bool {
    let after = &text.as_bytes()[end..];
    match after.first() {
        Some(b) if b.is_ascii_digit() => true,
        Some(b'-') => after.get(1).is_some_and(u8::is_ascii_digit),
        _ => false,
    }
}

/// 電話番号の数字の組の上限(`+81 (0) 3 1234 5678` の 5 組)。国内表記は 3 組まで。
const MAX_GROUPS_WITH_COUNTRY_CODE: usize = 5;
const MAX_GROUPS_DOMESTIC: usize = 3;
/// 数字の総数の上限。これを超えたら読むのをやめる(`+81` + `0` + 11 桁 = 14)。
const MAX_PHONE_DIGITS: usize = 14;
/// 組の間の区切り(`-`・空白・括弧)の長さの上限(` - ` や `) ` を許す)。
const MAX_SEPARATOR_LEN: usize = 3;

/// 行の中の日本の電話番号(バイト範囲)。開始位置は `+`・`(`・`0` で、直前が数字の並びでないこと。
fn find_phones(text: &str) -> Vec<Range<usize>> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut start = 0;
    while start < bytes.len() {
        let is_start = matches!(bytes[start], b'+' | b'(' | b'0') && !continues_number_before(text, start);
        if is_start {
            if let Some(end) = phone_at(text, start) {
                found.push(start..end);
                start = end;
                continue;
            }
        }
        start += 1;
    }
    found
}

/// 数字の組を 1 つ読み終えた時点の状態。
struct GroupEnd {
    /// 組の終わりのバイト位置
    end: usize,
    /// ここまでの数字(区切りを除く)
    digits: String,
    /// ここまでの組の数
    groups: usize,
    /// 最初の組の桁数
    first_group_len: usize,
}

/// `start` から始まる電話番号の終わりのバイト位置。数字の組を読み進め、条件を満たす最も長いものを採る。
fn phone_at(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let with_country_code = bytes[start] == b'+';
    let max_groups = if with_country_code { MAX_GROUPS_WITH_COUNTRY_CODE } else { MAX_GROUPS_DOMESTIC };
    let mut pos = if with_country_code { start + 1 } else { start };
    if !with_country_code && bytes[pos] == b'(' {
        pos += 1;
    }

    let mut ends: Vec<GroupEnd> = Vec::new();
    let mut digits = String::new();
    let mut first_group_len = 0;
    loop {
        // 数字の組
        let group_start = pos;
        while pos < bytes.len() && bytes[pos].is_ascii_digit() && digits.len() <= MAX_PHONE_DIGITS {
            digits.push(char::from(bytes[pos]));
            pos += 1;
        }
        let group_len = pos - group_start;
        if group_len == 0 || digits.len() > MAX_PHONE_DIGITS {
            break;
        }
        if ends.is_empty() {
            first_group_len = group_len;
        }
        ends.push(GroupEnd { end: pos, digits: digits.clone(), groups: ends.len() + 1, first_group_len });
        if ends.len() >= max_groups {
            break;
        }
        // 区切り
        let separator_start = pos;
        while pos < bytes.len() && matches!(bytes[pos], b'-' | b' ' | b'(' | b')') {
            pos += 1;
        }
        if pos == separator_start || !is_valid_separator(&bytes[separator_start..pos]) {
            break;
        }
    }

    ends.iter()
        .rev()
        .find(|g| !continues_number_after(text, g.end) && is_valid_phone(g, with_country_code))
        .map(|g| g.end)
}

/// 区切りとして許す並び: 長さ 3 以下で、`-`・`(`・`)` はそれぞれ 1 つまで、空白は連続しない。
fn is_valid_separator(separator: &[u8]) -> bool {
    let count = |c: u8| separator.iter().filter(|&&b| b == c).count();
    separator.len() <= MAX_SEPARATOR_LEN
        && count(b'-') <= 1
        && count(b'(') <= 1
        && count(b')') <= 1
        && !separator.windows(2).any(|w| w == b"  ")
}

/// 読み取った数字の組が日本の電話番号の形か。
fn is_valid_phone(group: &GroupEnd, with_country_code: bool) -> bool {
    let national = if with_country_code {
        // `+81` の後ろの `(0)` や `0` は国内の頭の `0` として扱う
        let Some(rest) = group.digits.strip_prefix(JP_COUNTRY_CODE) else {
            return false;
        };
        format!("0{}", rest.strip_prefix('0').unwrap_or(rest))
    } else {
        // 区切りがあるとき、最初の組(市外局番・事業者の番号)は 2〜5 桁
        if group.groups >= 2 && !(2..=5).contains(&group.first_group_len) {
            return false;
        }
        group.digits.clone()
    };
    is_valid_national_number(&national)
}

/// 国内表記の番号(数字だけ)が、固定・携帯・IP 電話・フリーダイヤル等の桁数に合うか。
fn is_valid_national_number(digits: &str) -> bool {
    let bytes = digits.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'0' || bytes[1] == b'0' {
        return false;
    }
    let eleven_digits = ELEVEN_DIGIT_PHONE_PREFIXES.iter().any(|prefix| digits.starts_with(prefix));
    if eleven_digits { bytes.len() == 11 } else { bytes.len() == 10 }
}

#[cfg(test)]
mod tests {
    use super::super::super::MatchDetail;
    use super::super::test_support::{ranges_in, span};
    use super::detect;

    // 失敗時に文字列を表示しないよう、比較は UTF-16 範囲(数値)だけで行う。
    // テストデータはすべて架空(予約ドメイン・架空の番号)。

    fn emails(text: &str) -> Vec<std::ops::Range<usize>> {
        ranges_in(detect, text, MatchDetail::Email)
    }

    fn phones(text: &str) -> Vec<std::ops::Range<usize>> {
        ranges_in(detect, text, MatchDetail::Phone)
    }

    fn addresses(text: &str) -> Vec<std::ops::Range<usize>> {
        ranges_in(detect, text, MatchDetail::Address)
    }

    /// `text` 全体が 1 件の電話番号として検出される。
    fn assert_whole_phone(text: &str) {
        assert_eq!(phones(text), vec![0..text.encode_utf16().count()]);
    }

    // ---- メール ----

    #[test]
    fn メールを検出する() {
        let line = "連絡先 taro.yamada@example.com まで";
        assert_eq!(emails(line), vec![span(line, "taro.yamada@example.com")]);
    }

    #[test]
    fn サブドメインと記号を含むメールを検出する() {
        let line = "To: first_last+tag@mail.sub.example.jp";
        assert_eq!(emails(line), vec![span(line, "first_last+tag@mail.sub.example.jp")]);
    }

    #[test]
    fn メールのアットとドットの前後の空白を許す() {
        let cases = [
            "taro @ example.com",
            "taro@ example .com",
            "taro@example. com",
            "taro . yamada@example.jp",
        ];
        for line in cases {
            assert_eq!(emails(line), vec![0..line.len()]);
        }
    }

    #[test]
    fn メールの末尾の句読点を含めない() {
        let cases = [
            ("送り先は taro@example.com。", "taro@example.com"),
            ("Mail taro@example.com.", "taro@example.com"),
            ("(taro@example.jp), thanks", "taro@example.jp"),
            ("taro@example.com. Thanks", "taro@example.com"),
            ("taro@example.com、hanako@example.org", "taro@example.com"),
        ];
        for (line, expected) in cases {
            assert_eq!(emails(line).first(), Some(&span(line, expected)));
        }
    }

    #[test]
    fn 全角のメールを検出する() {
        let line = "メール：ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏｍ";
        assert_eq!(emails(line), vec![span(line, "ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏｍ")]);
    }

    #[test]
    fn 一行の複数のメールをそれぞれ検出する() {
        let line = "a@example.com, b@example.org";
        assert_eq!(emails(line), vec![span(line, "a@example.com"), span(line, "b@example.org")]);
    }

    #[test]
    fn メールのドメインの語の途中の空白を許す() {
        // 読み取りで語の途中に空白が入った形(最後の `.` より前の語だけ)
        let line = "Author <tomas@dev.examp le.org>";
        assert_eq!(emails(line), vec![span(line, "tomas@dev.examp le.org")]);
        // 空白の後が大文字なら別の語とみなす
        let line = "taro@mail.example.com Thanks";
        assert_eq!(emails(line), vec![span(line, "taro@mail.example.com")]);
    }

    #[test]
    fn メールの最後の点が落ちた形はtldで終わるときだけ認める() {
        for (line, expected) in [("mio.sato@examplejp", "mio.sato@examplejp"), ("宛先 taro@samplecom です", "taro@samplecom")] {
            assert_eq!(emails(line), vec![span(line, expected)]);
        }
        for line in ["taro@example", "taro@examplejpx", "user@localhost"] {
            assert!(emails(line).is_empty());
        }
    }

    #[test]
    fn メールの形でないものは対象外() {
        let cases = ["@example.com", "taro@", "taro@example", "taro@example.c", "価格は 100@3 個", "a @ b"];
        for line in cases {
            assert!(emails(line).is_empty());
        }
    }

    // ---- 電話番号 ----

    #[test]
    fn 固定電話をハイフン有無で検出する() {
        for line in ["03-1234-5678", "0312345678", "045-123-4567", "0123-45-6789", "01234-5-6789"] {
            assert_whole_phone(line);
        }
    }

    #[test]
    fn 携帯とip電話を検出する() {
        for line in ["090-1234-5678", "08012345678", "070 1234 5678", "050-1234-5678"] {
            assert_whole_phone(line);
        }
    }

    #[test]
    fn フリーダイヤルとナビダイヤルを検出する() {
        for line in ["0120-123-456", "0120123456", "0800-123-4567", "0570-123-456"] {
            assert_whole_phone(line);
        }
    }

    #[test]
    fn 括弧付きの電話を検出する() {
        for line in ["(03)1234-5678", "03(1234)5678", "(03) 1234-5678", "(090)1234-5678"] {
            assert_whole_phone(line);
        }
    }

    #[test]
    fn 国番号付きの電話を検出する() {
        for line in ["+81-3-1234-5678", "+81 90 1234 5678", "+81(0)3-1234-5678", "+813-1234-5678", "+81-90-1234-5678"]
        {
            assert_whole_phone(line);
        }
    }

    #[test]
    fn 区切りの前後の空白を許す() {
        assert_whole_phone("03 - 1234 - 5678");
    }

    #[test]
    fn 全角数字と各種ハイフンの電話を検出する() {
        // －(全角)・ー(長音)・‐・−・–・—
        let cases = [
            "０３－１２３４－５６７８",
            "０９０ー１２３４ー５６７８",
            "03\u{2010}1234\u{2010}5678",
            "03\u{2212}1234\u{2212}5678",
            "03\u{2013}1234\u{2014}5678",
            "（０３）１２３４－５６７８",
            "＋８１－９０－１２３４－５６７８",
        ];
        for line in cases {
            assert_whole_phone(line);
        }
    }

    #[test]
    fn 行の中の電話を前後の文字を含めずに検出する() {
        let line = "TEL:03-1234-5678(代表) FAX 03-1234-5679。";
        assert_eq!(phones(line), vec![span(line, "03-1234-5678"), span(line, "03-1234-5679")]);
        let line = "お問い合わせは０１２０－１２３－４５６まで";
        assert_eq!(phones(line), vec![span(line, "０１２０－１２３－４５６")]);
    }

    #[test]
    fn 桁不足と桁過多の電話は対象外() {
        let cases = [
            "03-1234-567",    // 9 桁
            "090-1234-567",   // 携帯の 10 桁
            "090-1234-56789", // 12 桁
            "03-1234-56789",  // 11 桁の固定
            "0800-123-456",   // 0800 の 10 桁
            "031234567890",   // 12 桁
            "+81-3-1234-567", // 国番号付きの桁不足
        ];
        for line in cases {
            assert!(phones(line).is_empty());
        }
    }

    #[test]
    fn 電話の形でないものは対象外() {
        let cases = [
            "1234567890",          // 0 で始まらない
            "00-1234-5678",        // 00 で始まる
            "+1-202-555-0123",     // 日本以外の国番号
            "2024-03-15",          // 日付
            "0120-12-34-56-78-90", // 区切りが多すぎる数字の並び
        ];
        for line in cases {
            assert!(phones(line).is_empty());
        }
    }

    #[test]
    fn 前後が数字に続く場合は対象外() {
        let cases = [
            "103-1234-5678",
            "1-03-1234-5678",
            "03-1234-5678-9",
            "0312345678 9" /* 空白の後の数字は別の語として許す(下で確認) */,
        ];
        for line in &cases[..3] {
            assert!(phones(line).is_empty());
        }
        assert_eq!(phones(cases[3]), vec![0..10]);
    }

    // ---- 郵便番号 ----

    #[test]
    fn 郵便記号付きの郵便番号を検出する() {
        for line in ["〒100-0001", "〒 100-0001", "〒1000001", "〒１００－０００１"] {
            assert_eq!(addresses(line), vec![0..line.encode_utf16().count()]);
        }
    }

    #[test]
    fn 単独の郵便番号を検出する() {
        let line = "住所 100-0001 東京都";
        assert_eq!(addresses(line), vec![span(line, "100-0001")]);
        let line = "１００－０００１";
        assert_eq!(addresses(line), vec![0..8]);
    }

    #[test]
    fn 郵便番号の形でないものは対象外() {
        let cases = [
            "1000001",      // 記号もハイフンも無い 7 桁
            "1234-5678",    // 前が数字に続く
            "100-00012",    // 後ろが数字に続く
            "03-100-0001",  // 電話の一部(前がハイフンと数字)
            "100-0001-2",   // 後ろがハイフンと数字
            "〒100-000",    // 桁不足
        ];
        for line in cases {
            assert!(addresses(line).is_empty());
        }
    }

    #[test]
    fn 電話番号の一部を郵便番号として拾わない() {
        let line = "045-123-4567";
        assert!(addresses(line).is_empty());
        assert_eq!(phones(line), vec![0..12]);
    }

    // ---- UTF-16 範囲 ----

    #[test]
    fn 日本語の行でutf16範囲が正しい() {
        let line = "山田様の電話は０９０－１２３４－５６７８、メールはｔａｒｏ＠ｅｘａｍｐｌｅ．ｊｐ、〒１００－０００１です";
        assert_eq!(phones(line), vec![span(line, "０９０－１２３４－５６７８")]);
        assert_eq!(emails(line), vec![span(line, "ｔａｒｏ＠ｅｘａｍｐｌｅ．ｊｐ")]);
        assert_eq!(addresses(line), vec![span(line, "〒１００－０００１")]);
    }

    #[test]
    fn 絵文字を含む行でutf16範囲が正しい() {
        // 絵文字は UTF-16 で 2 単位
        let line = "\u{1f4de} 03-1234-5678 \u{1f4e7} a@example.com";
        assert_eq!(phones(line), vec![3..15]);
        assert_eq!(emails(line), vec![span(line, "a@example.com")]);
    }
}
