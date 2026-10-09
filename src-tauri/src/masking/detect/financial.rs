//! ④金額・口座: カード番号・口座番号・通貨付きの金額(FR-006)。
//!
//! 正規化(全角→半角)後の文字列に規則を当てる。正規表現は線形時間の `regex` クレートだけを使う。
//!
//! - カード番号: 数字の組(区切りは空白 1 つかハイフン 1 つで、1 つの番号の中では同じ区切り)が 13〜19 桁で
//!   チェックディジット(Luhn)が正しいもの。区切りがあるときは最初の組が 4 桁、残りの組が 2〜6 桁。
//!   4 桁 × 4 組の区切りがある 16 桁は Luhn が合わなくても候補にする(ARCH §15 #6 B・PRD FR-006 改訂)。
//!   前後が英数字に続く数字の並びは対象外
//! - 口座番号: 手がかり語(「口座番号」「口座」「普通」「当座」)の後の 6〜8 桁の数字(数字だけを返す)。
//!   手がかり語だけの観測(数字を含まない短いラベル)は、同じ行の右隣(無ければ直下の行)の観測の先頭の数字を値とする
//! - 金額: 通貨記号・単位(`lexicon.rs`)が前か後ろに付いた数値だけ(PRD §10 #1)。記号・単位を含めて返す。
//!   桁区切りの `,` と小数を含む

use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use super::super::layout::{next_line_below, right_neighbor};
use super::super::text::{normalize, SensitiveText};
use super::super::{Match, MatchDetail, RecognizedPage};
use super::lexicon::{
    ACCOUNT_CUES, ACCOUNT_TYPES, ACCOUNT_TYPE_SUFFIX, CURRENCY_PREFIXES, CURRENCY_SUFFIXES, YEN_MULTIPLIERS,
};
use super::Line;

/// カード番号の桁数の範囲。
const CARD_DIGITS: std::ops::RangeInclusive<usize> = 13..=19;
/// 区切りのあるカード番号の最初の組の桁数。
const CARD_FIRST_GROUP_LEN: usize = 4;
/// 区切りのあるカード番号の 2 つ目以降の組の桁数の範囲。
const CARD_GROUP_LEN: std::ops::RangeInclusive<usize> = 2..=6;
/// Luhn が合わなくても候補にする区切り方(4 桁 × 4 組)。
const UNCHECKED_CARD_GROUPS: [usize; 4] = [4, 4, 4, 4];
/// 口座番号の桁数の範囲。
const ACCOUNT_DIGITS: std::ops::RangeInclusive<usize> = 6..=8;
/// 手がかり語だけの観測(ラベル)とみなす文字数の上限。長い文は値を探さない。
const MAX_LABEL_CHARS: usize = 20;

/// 数字の並び(組の間の区切りは空白 1 つかハイフン 1 つ)。
static DIGIT_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9]+(?:[\x20\-][0-9]+)*").expect("固定の正規表現が不正"));

/// 語の一覧を行と同じ規則で正規化し、長いものを先にした正規表現の選択肢にする。
fn alternatives(words: &[&str]) -> String {
    let mut normalized: Vec<String> = words
        .iter()
        .map(|word| normalize(&SensitiveText::new((*word).to_string())).as_str().to_string())
        .collect();
    normalized.sort_by_key(|w| std::cmp::Reverse(w.len()));
    normalized.iter().map(|w| regex::escape(w)).collect::<Vec<_>>().join("|")
}

/// 預金の種類(「普通」「当座預金」など)の正規表現の断片。
fn account_type_pattern() -> String {
    format!(r"(?:{})(?:{})?", alternatives(&ACCOUNT_TYPES), regex::escape(ACCOUNT_TYPE_SUFFIX))
}

/// 手がかり語 + 区切り + (預金の種類)+ 数字(`number` のグループ)。
static ACCOUNT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:{cues})(?:{suffix})?(?:\x20*:\x20*|\x20*)(?:{kind}\x20*)?(?P<number>[0-9]+)",
        cues = alternatives(&ACCOUNT_CUES),
        suffix = regex::escape(ACCOUNT_TYPE_SUFFIX),
        kind = account_type_pattern(),
    ))
    .expect("固定の正規表現が不正")
});

/// 口座のラベルを含む観測(手がかり語がどこかにある)。
static ACCOUNT_LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&alternatives(&ACCOUNT_CUES)).expect("固定の正規表現が不正"));

/// ラベルの右隣・直下の観測の先頭の口座番号(預金の種類は任意)。前後の空白を除いた文字列に当てる。
static ACCOUNT_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^(?:{}\x20*)?(?P<number>[0-9]+)", account_type_pattern())).expect("固定の正規表現が不正")
});

/// 通貨付きの金額(`amount` のグループが返す範囲)。英字の通貨の単位は前が英字でないこと。
static AMOUNT: LazyLock<Regex> = LazyLock::new(|| {
    let number = r"[0-9](?:[0-9,]*[0-9])?(?:\.[0-9]+)?";
    let is_code = |unit: &&str| unit.bytes().all(|b| b.is_ascii_alphabetic());
    let prefix_codes: Vec<&str> = CURRENCY_PREFIXES.iter().copied().filter(is_code).collect();
    let prefix_symbols: Vec<&str> = CURRENCY_PREFIXES.iter().copied().filter(|u| !is_code(u)).collect();
    let suffixes: Vec<String> = CURRENCY_SUFFIXES
        .iter()
        .map(|unit| {
            if *unit == "円" {
                format!("(?:{})?{}", alternatives(&YEN_MULTIPLIERS), regex::escape(unit))
            } else {
                regex::escape(unit)
            }
        })
        .collect();
    Regex::new(&format!(
        r"(?:^|[^A-Za-z])(?P<code>(?:{codes})\x20?{number})|(?P<symbol>(?:{symbols})\x20?{number})|(?P<suffix>{number}\x20?(?:{suffixes}))",
        codes = alternatives(&prefix_codes),
        symbols = alternatives(&prefix_symbols),
        suffixes = suffixes.join("|"),
    ))
    .expect("固定の正規表現が不正")
});

/// ④金額・口座の検出器。行ごとの規則に加え、口座のラベルの観測から右隣・直下の観測を値として探す。
pub(super) fn detect(page: &dyn RecognizedPage, lines: &[Line]) -> Vec<Match> {
    let mut matches = Vec::new();
    // 自分の行の中で口座番号が見つかった観測(ラベルの値として重ねて探さない)
    let mut has_own_account = Vec::with_capacity(lines.len());
    for line in lines {
        let text = line.as_str();
        let accounts = find_accounts(text);
        has_own_account.push(!accounts.is_empty());
        let found = find_cards(text)
            .into_iter()
            .map(|r| (r, MatchDetail::CardNumber))
            .chain(accounts.into_iter().map(|r| (r, MatchDetail::AccountNumber)))
            .chain(find_amounts(text).map(|r| (r, MatchDetail::Amount)));
        matches.extend(found.filter_map(|(range, detail)| line.to_match(range, detail)));
    }

    for line in lines.iter().filter(|line| is_account_label(line.as_str())) {
        let Some(neighbor) = right_neighbor(page, line.index).or_else(|| next_line_below(page, line.index))
        else {
            continue;
        };
        let Some(position) = lines.iter().position(|l| l.index == neighbor) else {
            continue;
        };
        let value = &lines[position];
        if has_own_account[position] {
            continue;
        }
        if let Some(found) = leading_account(value.as_str()).and_then(|r| value.to_match(r, MatchDetail::AccountNumber))
        {
            matches.push(found);
        }
    }
    matches
}

/// カード番号(バイト範囲)。数字の並びごとに、区切りの組の連続する部分からカードの形のものを左から採る。
fn find_cards(text: &str) -> Vec<Range<usize>> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    for run in DIGIT_RUN.find_iter(text) {
        let before = run.start().checked_sub(1).map(|i| bytes[i]);
        let after = bytes.get(run.end()).copied();
        if before.is_some_and(is_word_byte) || after.is_some_and(is_word_byte) {
            continue;
        }
        let groups = digit_groups(text, run.range());
        let mut i = 0;
        while i < groups.len() {
            // 最も長い組の連続を優先する
            match (i + 1..=groups.len()).rev().find(|&j| is_card(text, &groups[i..j])) {
                Some(j) => {
                    found.push(groups[i].start..groups[j - 1].end);
                    i = j;
                }
                None => i += 1,
            }
        }
    }
    found
}

/// 数字の並びを組(数字だけのバイト範囲)に分ける。
fn digit_groups(text: &str, run: Range<usize>) -> Vec<Range<usize>> {
    let bytes = text.as_bytes();
    let mut groups = Vec::new();
    let mut start = run.start;
    for pos in run.clone() {
        if !bytes[pos].is_ascii_digit() {
            groups.push(start..pos);
            start = pos + 1;
        }
    }
    groups.push(start..run.end);
    groups
}

/// 連続する組がカード番号の形か。
fn is_card(text: &str, groups: &[Range<usize>]) -> bool {
    let bytes = text.as_bytes();
    let lens: Vec<usize> = groups.iter().map(ExactSizeIterator::len).collect();
    let total: usize = lens.iter().sum();
    if !CARD_DIGITS.contains(&total) {
        return false;
    }
    if groups.len() > 1 {
        // 区切りはすべて同じ文字
        let separators: Vec<u8> = groups.windows(2).map(|w| bytes[w[0].end]).collect();
        if separators.iter().any(|&s| s != separators[0])
            || lens[0] != CARD_FIRST_GROUP_LEN
            || !lens[1..].iter().all(|len| CARD_GROUP_LEN.contains(len))
        {
            return false;
        }
        if lens == UNCHECKED_CARD_GROUPS {
            return true;
        }
    }
    let digits: Vec<u8> = groups.iter().flat_map(|g| bytes[g.clone()].iter().map(|b| b - b'0')).collect();
    luhn_valid(&digits)
}

/// チェックディジット(Luhn)が正しいか。`digits` は 0〜9 の値。
fn luhn_valid(digits: &[u8]) -> bool {
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &d)| {
            let d = u32::from(d);
            if i % 2 == 1 {
                let doubled = d * 2;
                if doubled > 9 { doubled - 9 } else { doubled }
            } else {
                d
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

/// 英数字・`_`(数字の並びがこれに続くなら、別の語の一部とみなす)。
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// 同じ行の手がかり語の後の口座番号(数字だけのバイト範囲)。
fn find_accounts(text: &str) -> Vec<Range<usize>> {
    ACCOUNT
        .captures_iter(text)
        .filter_map(|caps| caps.name("number"))
        .map(|m| m.range())
        .filter(|r| ACCOUNT_DIGITS.contains(&r.len()))
        .collect()
}

/// 観測全体が口座のラベル(「口座番号」「振込先口座」「口座番号(控え)」など。数字を含まない短い観測)か。
fn is_account_label(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= MAX_LABEL_CHARS
        && !trimmed.bytes().any(|b| b.is_ascii_digit())
        && ACCOUNT_LABEL.is_match(trimmed)
}

/// ラベルの値の観測の先頭の口座番号(バイト範囲)。後ろが英数字・ハイフンに続く数字は対象外。
fn leading_account(text: &str) -> Option<Range<usize>> {
    let offset = text.len() - text.trim_start().len();
    let trimmed = text.trim();
    let number = ACCOUNT_VALUE.captures(trimmed)?.name("number")?;
    let next = trimmed.as_bytes().get(number.end()).copied();
    if !ACCOUNT_DIGITS.contains(&number.len()) || next.is_some_and(|b| is_word_byte(b) || b == b'-') {
        return None;
    }
    Some(offset + number.start()..offset + number.end())
}

/// 通貨付きの金額(バイト範囲)。英字の単位(`USD`・`JPY`)の直後が英字なら対象外。
fn find_amounts(text: &str) -> impl Iterator<Item = Range<usize>> + '_ {
    AMOUNT.captures_iter(text).filter_map(|caps| {
        let amount = caps.name("code").or_else(|| caps.name("symbol")).or_else(|| caps.name("suffix"))?;
        let ends_with_letter = amount.as_str().bytes().last().is_some_and(|b| b.is_ascii_alphabetic());
        let next_is_letter = text.as_bytes().get(amount.end()).is_some_and(u8::is_ascii_alphabetic);
        (!(ends_with_letter && next_is_letter)).then(|| amount.range())
    })
}

#[cfg(test)]
mod tests {
    use std::ops::Range;

    use super::super::super::text::SensitiveText;
    use super::super::super::{Match, MatchDetail, NormalizedRect, RecognizedPage};
    use super::super::fake::FakePage;
    use super::super::test_support::{ranges_in, span};
    use super::super::Line;
    use super::detect;

    // 失敗時に文字列を表示しないよう、比較は UTF-16 範囲(数値)だけで行う。
    // カード番号はソースに書かず、実在しない先頭 9 の数字列から実行時に組み立てる(Luhn は計算で付ける)。

    /// Luhn のチェックディジット(`body` の右端に付ける 1 桁)。
    fn luhn_check_digit(body: &str) -> u32 {
        let sum: u32 = body
            .bytes()
            .rev()
            .enumerate()
            .map(|(i, b)| {
                let d = u32::from(b - b'0');
                if i % 2 == 0 {
                    let doubled = d * 2;
                    if doubled > 9 { doubled - 9 } else { doubled }
                } else {
                    d
                }
            })
            .sum();
        (10 - sum % 10) % 10
    }

    /// 先頭が 9 の決定論的な数字列(`len - 1` 桁)。
    fn body(len: usize, seed: usize) -> String {
        std::iter::once('9')
            .chain((1..len - 1).map(|i| char::from(b'0' + ((seed + i * 3) % 10) as u8)))
            .collect()
    }

    /// `len` 桁の架空のカード番号(Luhn が正しい)。
    fn valid_card(len: usize, seed: usize) -> String {
        let body = body(len, seed);
        let check = luhn_check_digit(&body);
        format!("{body}{check}")
    }

    /// `len` 桁の架空の数字列(Luhn が正しくない)。
    fn invalid_card(len: usize, seed: usize) -> String {
        let body = body(len, seed);
        let check = (luhn_check_digit(&body) + 1) % 10;
        format!("{body}{check}")
    }

    /// 数字列を `groups` の桁数で区切る。
    fn grouped(digits: &str, groups: &[usize], separator: &str) -> String {
        let mut parts = Vec::new();
        let mut start = 0;
        for &len in groups {
            parts.push(&digits[start..start + len]);
            start += len;
        }
        assert_eq!(start, digits.len());
        parts.join(separator)
    }

    fn cards(text: &str) -> Vec<Range<usize>> {
        ranges_in(detect, text, MatchDetail::CardNumber)
    }

    fn accounts(text: &str) -> Vec<Range<usize>> {
        ranges_in(detect, text, MatchDetail::AccountNumber)
    }

    fn amounts(text: &str) -> Vec<Range<usize>> {
        ranges_in(detect, text, MatchDetail::Amount)
    }

    fn whole(text: &str) -> Range<usize> {
        0..text.encode_utf16().count()
    }

    /// ページ全体に検出器を当て、指定した細分の結果だけを返す。
    fn detect_page(page: &dyn RecognizedPage, detail: MatchDetail) -> Vec<Match> {
        let lines: Vec<Line> = (0..page.line_count()).map(|i| Line::new(i, page.line_text(i))).collect();
        detect(page, &lines).into_iter().filter(|m| m.detail == detail).collect()
    }

    /// 観測の領域(x・y・幅・高さ。正規化座標・左下原点)。
    type Cell = (f64, f64, f64, f64);

    /// 観測ごとに文字列と領域を指定できる偽物のページ。
    struct GridPage {
        texts: Vec<SensitiveText>,
        boxes: Vec<NormalizedRect>,
    }

    impl GridPage {
        fn new(cells: &[(&str, Cell)]) -> Self {
            Self {
                texts: cells.iter().map(|(text, _)| SensitiveText::new((*text).to_string())).collect(),
                boxes: cells
                    .iter()
                    .map(|&(_, (x, y, width, height))| NormalizedRect { x, y, width, height })
                    .collect(),
            }
        }
    }

    impl RecognizedPage for GridPage {
        fn line_count(&self) -> usize {
            self.texts.len()
        }
        fn line_text(&self, line: usize) -> &SensitiveText {
            &self.texts[line]
        }
        fn line_box(&self, line: usize) -> NormalizedRect {
            self.boxes[line]
        }
        fn range_box(&self, _line: usize, _range: Range<usize>) -> Option<NormalizedRect> {
            None
        }
    }

    /// 同じ行の左右に並ぶ 2 つの観測(ラベル・値)。
    const LEFT_CELL: Cell = (0.1, 0.5, 0.2, 0.05);
    const RIGHT_CELL: Cell = (0.4, 0.5, 0.3, 0.05);

    // ---- カード番号 ----

    #[test]
    fn テスト用の番号の生成が正しい() {
        // 生成器そのものの確認(Luhn の計算が逆なら以降のテストが意味を持たない)
        assert_eq!(luhn_check_digit("7992739871"), 3);
        assert_ne!(valid_card(16, 1), invalid_card(16, 1));
    }

    #[test]
    fn 区切りなしのluhnが正しい13桁から19桁を検出する() {
        for len in 13..=19 {
            let card = valid_card(len, len);
            assert_eq!(cards(&card), vec![whole(&card)]);
        }
    }

    #[test]
    fn 区切りなしの12桁と20桁は対象外() {
        for len in [12, 20] {
            assert!(cards(&valid_card(len, 4)).is_empty());
        }
    }

    #[test]
    fn 空白とハイフンで区切ったluhnが正しい番号を検出する() {
        let cases: [(usize, &[usize]); 5] =
            [(16, &[4, 4, 4, 4]), (13, &[4, 4, 5]), (14, &[4, 4, 4, 2]), (15, &[4, 6, 5]), (19, &[4, 4, 4, 4, 3])];
        for (len, groups) in cases {
            for separator in [" ", "-"] {
                let card = grouped(&valid_card(len, 2), groups, separator);
                assert_eq!(cards(&card), vec![whole(&card)]);
            }
        }
    }

    #[test]
    fn 四桁四組の区切りがある16桁はluhnが正しくなくても検出する() {
        for separator in [" ", "-"] {
            let card = grouped(&invalid_card(16, 5), &[4, 4, 4, 4], separator);
            assert_eq!(cards(&card), vec![whole(&card)]);
        }
    }

    #[test]
    fn luhnが正しくない区切りなしと四桁四組以外は対象外() {
        assert!(cards(&invalid_card(16, 5)).is_empty());
        assert!(cards(&grouped(&invalid_card(13, 5), &[4, 4, 5], " ")).is_empty());
        assert!(cards(&grouped(&invalid_card(14, 5), &[4, 4, 4, 2], " ")).is_empty());
    }

    #[test]
    fn luhnが正しくない19桁の4桁4組の部分は候補にする() {
        // 4-4-4-4-3 の 19 桁は Luhn が合わないとき、4 桁 × 4 組の部分(先頭 16 桁)だけを候補にする【仮定】
        let card = grouped(&invalid_card(19, 5), &[4, 4, 4, 4, 3], " ");
        assert_eq!(cards(&card), vec![0..19]);
    }

    #[test]
    fn 有効期限が同じ数字の並びに続いても4桁4組を検出する() {
        for card in [valid_card(16, 6), invalid_card(16, 6)] {
            let card = grouped(&card, &[4, 4, 4, 4], " ");
            let line = format!("{card} 12/28");
            assert_eq!(cards(&line), vec![span(&line, &card)]);
        }
    }

    #[test]
    fn 行の中のカード番号を前後の文字を含めずに検出する() {
        let card = grouped(&valid_card(16, 7), &[4, 4, 4, 4], " ");
        let line = format!("カード番号: {card} 有効期限 12/28");
        assert_eq!(cards(&line), vec![span(&line, &card)]);
        let line = format!("登録カード({card})");
        assert_eq!(cards(&line), vec![span(&line, &card)]);
    }

    #[test]
    fn 英数字に続く数字列は対象外() {
        let card = valid_card(16, 3);
        assert!(cards(&format!("A{card}")).is_empty());
        assert!(cards(&format!("{card}x")).is_empty());
        // 数字が前に続くと 20 桁の 1 つの並びになり、カードの桁数を超える
        assert!(cards(&format!("1{}", valid_card(19, 3))).is_empty());
    }

    #[test]
    fn 全角のカード番号のutf16範囲が正しい() {
        let card = grouped(&valid_card(16, 8), &[4, 4, 4, 4], "-");
        let wide: String = card
            .chars()
            .map(|c| if c == '-' { '－' } else { char::from_u32(c as u32 + 0xfee0).unwrap_or(c) })
            .collect();
        let line = format!("カード {wide}");
        assert_eq!(cards(&line), vec![span(&line, &wide)]);
    }

    #[test]
    fn 日付や電話番号はカードとしない() {
        for line in ["2026-10-09 12:30", "03-1234-5678", "090 1234 5678"] {
            assert!(cards(line).is_empty());
        }
    }

    // ---- 口座番号 ----

    #[test]
    fn 手がかり語の後の6桁から8桁を口座番号として検出する() {
        let cases = [
            ("普通 1234567", "1234567"),
            ("当座 0582201", "0582201"),
            ("口座番号 123456", "123456"),
            ("口座番号: 12345678", "12345678"),
            ("口座番号：１２３４５６７", "１２３４５６７"),
            ("口座 普通 7012384", "7012384"),
            ("普通預金 5519024", "5519024"),
            ("口座番号1234567", "1234567"),
            ("振込先 当座 0047719 (本店)", "0047719"),
        ];
        for (line, expected) in cases {
            assert_eq!(accounts(line), vec![span(line, expected)]);
        }
    }

    #[test]
    fn 口座番号の桁数と手がかり語の条件を満たさないものは対象外() {
        for line in ["普通 12345", "普通 123456789", "1234567", "口座数 3", "普通 1,234,567円"] {
            assert!(accounts(line).is_empty());
        }
    }

    #[test]
    fn 口座のラベルの右隣の観測を値とする() {
        for label in ["口座番号", "口座", "振込先口座", "口座番号(控え)"] {
            let page = GridPage::new(&[(label, LEFT_CELL), ("4471029", RIGHT_CELL)]);
            assert_eq!(
                detect_page(&page, MatchDetail::AccountNumber),
                vec![Match::new(1, 0..7, MatchDetail::AccountNumber)]
            );
        }
    }

    #[test]
    fn 口座のラベルの右隣が自分で手がかり語を持つなら数字だけを1件返す() {
        let value = "普通 1234508";
        let page = GridPage::new(&[("出金口座", LEFT_CELL), (value, RIGHT_CELL)]);
        assert_eq!(
            detect_page(&page, MatchDetail::AccountNumber),
            vec![Match::new(1, span(value, "1234508"), MatchDetail::AccountNumber)]
        );
    }

    #[test]
    fn 右隣が無ければ直下の行を口座番号とする() {
        let page = FakePage::new(&["口座番号", " 902817 ", "次の行"]);
        assert_eq!(
            detect_page(&page, MatchDetail::AccountNumber),
            vec![Match::new(1, 1..7, MatchDetail::AccountNumber)]
        );
    }

    #[test]
    fn 口座のラベルの値が口座番号の形でなければ対象外() {
        for value in ["12345", "123456789", "未登録", "2026-10-09"] {
            let page = GridPage::new(&[("口座番号", LEFT_CELL), (value, RIGHT_CELL)]);
            assert!(detect_page(&page, MatchDetail::AccountNumber).is_empty());
        }
    }

    // ---- 金額 ----

    #[test]
    fn 通貨記号と単位の付いた金額を検出する() {
        let cases = [
            "¥48,000", "￥254,980", "¥ 1,980", "$1,249.99", "＄12", "JPY 2,150", "USD 3,000.50", "12,600円", "440円",
            "100 USD", "3.5USD", "１２，６００円", "12万円",
        ];
        for line in cases {
            assert_eq!(amounts(line), vec![whole(line)]);
        }
    }

    #[test]
    fn 行の中の金額を前後の文字を含めずに検出する() {
        let line = "合計(税込) ￥254,980 です";
        assert_eq!(amounts(line), vec![span(line, "￥254,980")]);
        let line = "手数料は440円、送料は$12.50。";
        assert_eq!(amounts(line), vec![span(line, "440円"), span(line, "$12.50")]);
    }

    #[test]
    fn 通貨記号や単位の無い数値は対象外() {
        for line in ["48,000", "合計 1,249.99", "3 個", "USD", "円", "¥", "JPYX 100", "2026-10-09"] {
            assert!(amounts(line).is_empty());
        }
    }
}
