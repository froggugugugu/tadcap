//! ④金額・口座: カード番号・口座番号・通貨付きの金額(FR-006)。
//!
//! 正規化(全角→半角)後の文字列に規則を当てる。正規表現は線形時間の `regex` クレートだけを使う。
//!
//! - カード番号: 数字の組(区切りは空白 1 つかハイフン 1 つで、1 つの番号の中では同じ区切り)が 13〜19 桁で
//!   チェックディジット(Luhn)が正しいもの。区切りがあるときは最初の組が 4 桁、残りの組が 2〜6 桁。
//!   4 桁 × 4 組の区切りがある 16 桁は Luhn が合わなくても候補にする(ARCH §15 #6 B・PRD FR-006 改訂)。
//!   前後が英数字に続く数字の並びは対象外。1 つの番号が読み取りで横に並ぶ複数の観測に分かれた場合
//!   (「1234 5678」「9012」「3456」)は、数字だけの観測を右へつないで判定し、各観測の数字の範囲を返す
//! - 口座番号: 手がかり語(「口座番号」「口座」「普通」「当座」「貯蓄」「(普)」「(当)」など)の後の 6〜8 桁の数字
//!   (数字だけを返す)。英字の手がかり語(Account・Acct・A/C・ACH・Routing・Sort code・BSB など)の後は 6〜17 桁、
//!   Sort code(2-2-2)・BSB(3-3)の区切りも値とする。
//!   手がかり語だけの観測(数字を含まない短いラベル)は、同じ行の右隣(無ければ直下の行)の観測の先頭の数字を値とする。
//!   その値の前の預金の種類が誤読されていても(空白の前の数字・空白以外の 1〜3 文字)、続く数字を値とする。
//!   ラベルが表の見出しの行にあるなら、列の下に並ぶ値を口座番号の形の間だけ値とする
//! - ゆうちょ銀行の記号・番号(`1NNN0-NNNNNN1`: 記号 5 桁は 1 で始まり 0 で終わり、番号 6〜8 桁は 1 で終わる)は
//!   手がかり語なしで口座番号とする
//! - IBAN: 国コード + チェックディジット 2 桁 + 英数字(4 文字ごとの空白は任意)で、桁数が国ごとの桁数(`IBAN_LENGTHS`)に
//!   合うもの。チェックディジット(mod-97)が正しければ手がかり語なし、合わなければ同じ行(同じ高さの観測を含む)に
//!   「IBAN」があるときだけ口座番号とする
//! - 金額: 通貨記号・ISO 4217 のコード・日本語の単位(`lexicon.rs`)が前か後ろに付いた数値だけ(PRD §10 #1)。
//!   記号・単位を含めて返す。数値は桁区切り・小数の `,`・`.`(両方式)・`'` を含み、前の負の印(`-`・`△`・`▲`)、
//!   日本語の単位の前の数の単位の組み合わせ(「32万4,000円」)、末尾の「-」「.-」「也」も金額に含める

use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use super::super::layout::{next_line_below, right_neighbor, same_row};
use super::super::text::{normalize, SensitiveText};
use super::super::{Match, MatchDetail, RecognizedPage};
use super::lexicon::{
    ACCOUNT_CUES, ACCOUNT_CUES_ASCII, ACCOUNT_TYPES, ACCOUNT_TYPE_SUFFIX, AMOUNT_MULTIPLIERS, CURRENCY_CODES,
    CURRENCY_DOLLAR_PREFIXES, CURRENCY_SUFFIX_SYMBOLS, CURRENCY_SYMBOLS, CURRENCY_UNITS_JA, IBAN_CUE, IBAN_LENGTHS,
    NEGATIVE_MARKS,
};
use super::{column_cells, Line};

/// カード番号の桁数の範囲。
const CARD_DIGITS: std::ops::RangeInclusive<usize> = 13..=19;
/// 区切りのあるカード番号の最初の組の桁数。
const CARD_FIRST_GROUP_LEN: usize = 4;
/// 区切りのあるカード番号の 2 つ目以降の組の桁数の範囲。
const CARD_GROUP_LEN: std::ops::RangeInclusive<usize> = 2..=6;
/// Luhn が合わなくても候補にする区切り方(4 桁 × 4 組)。
const UNCHECKED_CARD_GROUPS: [usize; 4] = [4, 4, 4, 4];
/// 口座番号の桁数の範囲(日本語の手がかり語)。
const ACCOUNT_DIGITS: std::ops::RangeInclusive<usize> = 6..=8;
/// 英字の手がかり語の後の口座番号の桁数の範囲(米国の口座番号は 17 桁まで。ABA の 9 桁を含む)。
const ACCOUNT_DIGITS_ASCII: std::ops::RangeInclusive<usize> = 6..=17;
/// 手がかり語だけの観測(ラベル)とみなす文字数の上限。長い文は値を探さない。
const MAX_LABEL_CHARS: usize = 20;
/// 分かれたカード番号としてつなぐ観測の数の上限。
const MAX_SPLIT_CARD_PARTS: usize = 4;
/// 分かれたカード番号の観測の間の隙間の上限(左の観測の 1 文字の幅に対する倍数)。
const MAX_SPLIT_CARD_GAP_CHARS: f64 = 2.0;

/// 数字の並び(組の間の区切りは空白 1 つかハイフン 1 つ)。
static DIGIT_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9]+(?:[\x20\-][0-9]+)*").expect("固定の正規表現が不正"));

/// 観測全体が数字の並びだけ(前後の空白を除いた文字列に当てる)。分かれたカード番号の部品。
static DIGITS_ONLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]+(?:[\x20\-][0-9]+)*$").expect("固定の正規表現が不正"));

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

/// 英字の手がかり語の正規表現の断片(語の間・番号の語「No.」「number」「#」は任意)。
fn ascii_account_cue_pattern() -> String {
    format!(r"(?:{})(?:\x20?(?:number|no\.?|#))?", ACCOUNT_CUES_ASCII.join("|"))
}

/// 英字の手がかり語 + 区切り + 値(`number` のグループ。Sort code の 2-2-2・BSB の 3-3・数字の並び)。
/// 手がかり語の前と値の後は英数字でないこと。
static ACCOUNT_ASCII: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)(?:^|[^a-z0-9])(?:{cue})(?:\x20*[:#]\x20*|\x20+)(?P<number>[0-9]{{2}}-[0-9]{{2}}-[0-9]{{2}}|[0-9]{{3}}-[0-9]{{3}}|[0-9]+)(?:$|[^a-z0-9\-])",
        cue = ascii_account_cue_pattern(),
    ))
    .expect("固定の正規表現が不正")
});

/// 口座のラベルを含む観測(手がかり語がどこかにある)。英字の手がかり語は語の一部でないこと。
static ACCOUNT_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"{}|(?i:(?:^|[^a-z0-9])(?:{})(?:$|[^a-z0-9]))",
        alternatives(&ACCOUNT_CUES),
        ascii_account_cue_pattern()
    ))
    .expect("固定の正規表現が不正")
});

/// 英字の口座のラベル(英字の手がかり語だけを含む)。値の桁数の範囲を広げるかの判定に使う。
static ACCOUNT_LABEL_ASCII: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)(?:^|[^a-z0-9])(?:{})(?:$|[^a-z0-9])", ascii_account_cue_pattern()))
        .expect("固定の正規表現が不正")
});

/// ラベルの右隣・直下の観測の先頭の口座番号(預金の種類は任意)。前後の空白を除いた文字列に当てる。
static ACCOUNT_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^(?:{}\x20*|[^0-9\x20]{{1,3}}\x20+)?(?P<number>[0-9]+)", account_type_pattern()))
        .expect("固定の正規表現が不正")
});

/// ゆうちょ銀行の記号(5 桁・1 で始まり 0 で終わる)- 番号(6〜8 桁・1 で終わる)。前後は英数字・`-` でないこと。
static YUCHO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[^0-9A-Za-z\-])(?P<number>1[0-9]{3}0-[0-9]{5,7}1)(?:$|[^0-9A-Za-z\-])").expect("固定の正規表現が不正")
});

/// IBAN の候補(国コード + チェックディジット + 4 文字ずつの組。組の間の空白 1 つは任意)。前は英数字でないこと。
/// 桁数は国ごとの桁数で後から切り詰める。
static IBAN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[^A-Za-z0-9])(?P<iban>[A-Z]{2}[0-9]{2}(?:\x20?[A-Z0-9]{4}){2,7}(?:\x20?[A-Z0-9]{1,3})?)")
        .expect("固定の正規表現が不正")
});

/// IBAN の手がかり語(語として独立していること・大文字小文字を区別しない)。
static IBAN_CUE_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)(?:^|[^a-z0-9]){IBAN_CUE}(?:$|[^a-z0-9])")).expect("固定の正規表現が不正")
});

/// 通貨付きの金額(`amount` のグループが返す範囲)。英字の通貨のコード・`A$` などは前が英字でないこと。
static AMOUNT: LazyLock<Regex> = LazyLock::new(|| {
    // 桁区切り・小数の `,` `.`(両方式)と `'`(スイスの桁区切り)。数字で始まり数字で終わる
    let number = r"[0-9](?:[0-9.,']*[0-9])?";
    let negative = format!("(?:{}\x20?)?", alternatives(&NEGATIVE_MARKS));
    let multiplier = alternatives(&AMOUNT_MULTIPLIERS);
    Regex::new(&format!(
        r"(?:^|[^A-Za-z])(?P<code>{negative}(?:{codes}|{dollars})\x20?{negative}{number})|(?P<symbol>{negative}(?:{symbols})\x20?{negative}{number})|(?P<suffix>{negative}{number}(?:(?:{multiplier}){number})*(?:{multiplier})?\x20?(?:{units_ja})|{negative}{number}\x20?(?:{suffix_symbols}|{codes}))",
        codes = alternatives(&CURRENCY_CODES),
        dollars = alternatives(&CURRENCY_DOLLAR_PREFIXES),
        symbols = alternatives(&CURRENCY_SYMBOLS),
        units_ja = alternatives(&CURRENCY_UNITS_JA),
        suffix_symbols = alternatives(&CURRENCY_SUFFIX_SYMBOLS),
    ))
    .expect("固定の正規表現が不正")
});

/// ④金額・口座の検出器。行ごとの規則に加え、口座のラベルの観測から右隣・直下の観測(表の見出しなら列の値)を
/// 値として探す。チェックディジットが合わない IBAN は、同じ高さの観測に「IBAN」があるときだけ返す。
pub(super) fn detect(page: &dyn RecognizedPage, lines: &[Line]) -> Vec<Match> {
    let mut matches = Vec::new();
    // 自分の行の中で口座番号が見つかった観測(ラベルの値として重ねて探さない)
    let mut has_own_account = Vec::with_capacity(lines.len());
    // 自分の行の中でカード番号が見つかった観測(分かれたカード番号の部品にしない)
    let mut has_own_card = Vec::with_capacity(lines.len());
    for line in lines {
        let text = line.as_str();
        let mut accounts = find_accounts(text);
        for (range, checksum_ok) in find_ibans(text) {
            if checksum_ok || has_iban_cue_in_row(page, lines, line) {
                accounts.push(range);
            }
        }
        has_own_account.push(!accounts.is_empty());
        let cards = find_cards(text);
        has_own_card.push(!cards.is_empty());
        let found = cards
            .into_iter()
            .map(|r| (r, MatchDetail::CardNumber))
            .chain(accounts.into_iter().map(|r| (r, MatchDetail::AccountNumber)))
            .chain(find_amounts(text).into_iter().map(|r| (r, MatchDetail::Amount)));
        matches.extend(found.filter_map(|(range, detail)| line.to_match(range, detail)));
    }

    for (pos, line) in lines.iter().enumerate().filter(|(_, line)| is_account_label(line.as_str())) {
        let digits = account_digits_for_label(line.as_str());
        // 表の見出しなら列の下に並ぶ値を口座番号とする。数字を含むのに形が合わない値(読み取りの誤り)は飛ばして続け、
        // 数字を含まない観測(見出し・空欄の表記)で終える
        let cells = column_cells(page, lines, pos);
        if !cells.is_empty() {
            for position in cells {
                let value = &lines[position];
                if has_own_account[position] {
                    continue;
                }
                match leading_account(value.as_str(), digits.clone()).and_then(|r| value.to_match(r, MatchDetail::AccountNumber)) {
                    Some(found) => matches.push(found),
                    None if value.as_str().bytes().any(|b| b.is_ascii_digit()) => continue,
                    None => break,
                }
            }
            continue;
        }
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
        if let Some(found) =
            leading_account(value.as_str(), digits).and_then(|r| value.to_match(r, MatchDetail::AccountNumber))
        {
            matches.push(found);
        }
    }
    matches.extend(find_split_cards(page, lines, &has_own_card));
    matches
}

/// `line` の行の中、または同じ高さに並ぶ観測に IBAN の手がかり語があるか。
fn has_iban_cue_in_row(page: &dyn RecognizedPage, lines: &[Line], line: &Line) -> bool {
    IBAN_CUE_WORD.is_match(line.as_str())
        || same_row(page, line.index)
            .into_iter()
            .filter_map(|index| lines.iter().find(|l| l.index == index))
            .any(|l| IBAN_CUE_WORD.is_match(l.as_str()))
}

/// ラベルの値の桁数の範囲。英字の手がかり語だけのラベルなら英字の範囲(6〜17 桁)。
fn account_digits_for_label(text: &str) -> std::ops::RangeInclusive<usize> {
    let has_ja_cue = ACCOUNT_CUES.iter().any(|cue| {
        let cue = normalize(&SensitiveText::new((*cue).to_string()));
        text.contains(cue.as_str())
    });
    if !has_ja_cue && ACCOUNT_LABEL_ASCII.is_match(text) { ACCOUNT_DIGITS_ASCII } else { ACCOUNT_DIGITS }
}

/// 横に並ぶ数字だけの観測をつないだカード番号(各観測の数字の範囲)。左端の観測から右へ、
/// つないだ全体がカード番号の形になる最も長いつながりを採る。自分でカード番号を持つ観測は部品にしない。
fn find_split_cards(page: &dyn RecognizedPage, lines: &[Line], has_own_card: &[bool]) -> Vec<Match> {
    let is_part = |position: usize| !has_own_card[position] && DIGITS_ONLY.is_match(lines[position].as_str().trim());
    let mut used = vec![false; lines.len()];
    let mut matches = Vec::new();
    for start in 0..lines.len() {
        if used[start] || !is_part(start) {
            continue;
        }
        let mut chain = vec![start];
        while chain.len() < MAX_SPLIT_CARD_PARTS {
            let last = chain[chain.len() - 1];
            let Some(next) = adjacent_right(page, lines, last).filter(|&n| !used[n] && is_part(n) && !chain.contains(&n))
            else {
                break;
            };
            chain.push(next);
        }
        // 2 つ以上の観測をつないでカード番号の形になる、最も長いつながり
        let Some(len) = (2..=chain.len()).rev().find(|&len| is_split_card(lines, &chain[..len])) else {
            continue;
        };
        for &position in &chain[..len] {
            used[position] = true;
            let line = &lines[position];
            if let Some(found) = line.to_match(trimmed_range(line.as_str()), MatchDetail::CardNumber) {
                matches.push(found);
            }
        }
    }
    matches
}

/// つないだ観測の数字が 1 つのカード番号の形か。観測の間はハイフンを含む観測があればハイフン、
/// 無ければ空白 1 つでつなぐ(1 つの番号の中では同じ区切り)。
fn is_split_card(lines: &[Line], parts: &[usize]) -> bool {
    let texts: Vec<&str> = parts.iter().map(|&p| lines[p].as_str().trim()).collect();
    let separator = if texts.iter().any(|t| t.contains('-')) { "-" } else { " " };
    let joined = texts.join(separator);
    matches!(find_cards(&joined).as_slice(), [only] if *only == (0..joined.len()))
}

/// `position` の観測の右に接して並ぶ観測(縦の中心が同じ行の高さに入り、左端が `position` の右端から
/// 1 文字の幅の `MAX_SPLIT_CARD_GAP_CHARS` 倍以内。読み取りの領域どうしの小さな重なりも許す)。
fn adjacent_right(page: &dyn RecognizedPage, lines: &[Line], position: usize) -> Option<usize> {
    let left = page.line_box(lines[position].index);
    let chars = lines[position].as_str().trim().chars().count().max(1);
    let char_width = left.width / chars as f64;
    let right_edge = left.x + left.width;
    lines
        .iter()
        .enumerate()
        .filter(|&(p, _)| p != position)
        .map(|(p, line)| (p, page.line_box(line.index)))
        .filter(|(_, rect)| {
            let center = rect.y + rect.height / 2.0;
            center >= left.y
                && center <= left.y + left.height
                && rect.x > left.x + left.width / 2.0
                && rect.x >= right_edge - char_width
                && rect.x <= right_edge + char_width * MAX_SPLIT_CARD_GAP_CHARS
        })
        .min_by(|(pa, a), (pb, b)| a.x.total_cmp(&b.x).then(pa.cmp(pb)))
        .map(|(p, _)| p)
}

/// 前後の空白を除いた部分のバイト範囲。
fn trimmed_range(text: &str) -> Range<usize> {
    let start = text.len() - text.trim_start().len();
    let end = text.trim_end().len();
    start..end.max(start)
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

/// 同じ行の口座番号(バイト範囲)。日本語の手がかり語の後の数字・英字の手がかり語の後の値・ゆうちょの記号番号。
fn find_accounts(text: &str) -> Vec<Range<usize>> {
    let mut found: Vec<Range<usize>> = ACCOUNT
        .captures_iter(text)
        .filter_map(|caps| caps.name("number"))
        .map(|m| m.range())
        .filter(|r| ACCOUNT_DIGITS.contains(&r.len()))
        .collect();
    for number in ACCOUNT_ASCII.captures_iter(text).filter_map(|caps| caps.name("number")) {
        let digits = number.as_str().bytes().filter(u8::is_ascii_digit).count();
        let hyphenated = number.as_str().contains('-');
        if (hyphenated || ACCOUNT_DIGITS_ASCII.contains(&digits)) && !overlaps_any(&number.range(), &found) {
            found.push(number.range());
        }
    }
    for number in YUCHO.captures_iter(text).filter_map(|caps| caps.name("number")) {
        if !overlaps_any(&number.range(), &found) {
            found.push(number.range());
        }
    }
    found.sort_by_key(|r| r.start);
    found
}

/// IBAN の候補(バイト範囲)と、チェックディジット(mod-97)が正しいか。桁数が国ごとの桁数に合うものだけ。
/// 候補が長ければ、国ごとの桁数に達した所(組の終わり)で切り詰める。
fn find_ibans(text: &str) -> Vec<(Range<usize>, bool)> {
    IBAN.captures_iter(text)
        .filter_map(|caps| caps.name("iban"))
        .filter_map(|m| {
            let candidate = m.as_str();
            let expected = IBAN_LENGTHS.iter().find(|(country, _)| candidate.starts_with(country))?.1;
            // 英数字が `expected` 個になった所までのバイト数
            let mut count = 0;
            let mut end = None;
            for (i, b) in candidate.bytes().enumerate() {
                if b != b' ' {
                    count += 1;
                }
                if count == expected {
                    end = Some(i + 1);
                    break;
                }
            }
            let end = end?;
            // 切り詰めた所の後が英数字(組の途中)なら対象外
            if candidate.as_bytes().get(end).is_some_and(u8::is_ascii_alphanumeric) {
                return None;
            }
            let compact: String = candidate[..end].chars().filter(|c| *c != ' ').collect();
            Some((m.start()..m.start() + end, iban_checksum_ok(&compact)))
        })
        .collect()
}

/// IBAN のチェックディジット(ISO 13616 の mod-97)が正しいか。先頭 4 文字を末尾に回し、英字を 10〜35 にした数を 97 で割った余りが 1。
fn iban_checksum_ok(compact: &str) -> bool {
    let rotated = compact.get(4..).unwrap_or_default().chars().chain(compact.chars().take(4));
    let mut remainder: u32 = 0;
    for c in rotated {
        let Some(value) = c.to_digit(36) else {
            return false;
        };
        let digits = if value >= 10 { 100 } else { 10 };
        remainder = (remainder * digits + value) % 97;
    }
    remainder == 1
}

fn overlaps_any(range: &Range<usize>, others: &[Range<usize>]) -> bool {
    others.iter().any(|o| range.start < o.end && o.start < range.end)
}

/// 観測全体が口座のラベル(「口座番号」「振込先口座」「口座番号(控え)」「Acct」など。数字を含まない短い観測)か。
fn is_account_label(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= MAX_LABEL_CHARS
        && !trimmed.bytes().any(|b| b.is_ascii_digit())
        && ACCOUNT_LABEL.is_match(trimmed)
}

/// ラベルの値の観測の先頭の口座番号(バイト範囲)。後ろが英数字・ハイフンに続く数字は対象外。
/// 観測の先頭がゆうちょの記号番号なら、その全体を返す。
fn leading_account(text: &str, digits: std::ops::RangeInclusive<usize>) -> Option<Range<usize>> {
    let offset = text.len() - text.trim_start().len();
    let trimmed = text.trim();
    if let Some(number) = YUCHO.captures(trimmed).and_then(|caps| caps.name("number")).filter(|m| m.start() == 0) {
        return Some(offset..offset + number.end());
    }
    let number = ACCOUNT_VALUE.captures(trimmed)?.name("number")?;
    let next = trimmed.as_bytes().get(number.end()).copied();
    if !digits.contains(&number.len()) || next.is_some_and(|b| is_word_byte(b) || b == b'-') {
        return None;
    }
    Some(offset + number.start()..offset + number.end())
}

/// 通貨付きの金額(バイト範囲)。英字の単位(`USD`・`JPY`)の直後が英字なら対象外。
/// 前の負の印 `-` が英数字に続くなら(語の一部のハイフン)負の印を含めない。
/// 末尾の「也」「.-」「-」(後に数字が続かないもの)は金額に含める。
fn find_amounts(text: &str) -> Vec<Range<usize>> {
    let bytes = text.as_bytes();
    AMOUNT
        .captures_iter(text)
        .filter_map(|caps| {
            let amount = caps.name("code").or_else(|| caps.name("symbol")).or_else(|| caps.name("suffix"))?;
            let ends_with_letter = amount.as_str().bytes().last().is_some_and(|b| b.is_ascii_alphabetic());
            let next_is_letter = bytes.get(amount.end()).is_some_and(u8::is_ascii_alphabetic);
            if ends_with_letter && next_is_letter {
                return None;
            }
            let mut start = amount.start();
            if bytes[start] == b'-' && start > 0 && bytes[start - 1].is_ascii_alphanumeric() {
                start += 1;
                while bytes.get(start) == Some(&b' ') {
                    start += 1;
                }
            }
            Some(start..amount.end() + trailer_len(&text[amount.end()..]))
        })
        .collect()
}

/// 金額の末尾の「也」「.-」「-」のバイト数(後に数字・英字が続く「-」は範囲の区切りとみなして含めない)。
fn trailer_len(rest: &str) -> usize {
    let not_continued = |after: &str| !after.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric());
    if rest.starts_with('也') {
        '也'.len_utf8()
    } else if rest.starts_with(".-") && not_continued(&rest[2..]) {
        2
    } else if rest.starts_with('-') && not_continued(&rest[1..]) {
        1
    } else {
        0
    }
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
    fn 口座のラベルの値の預金の種類が誤読されていても数字を値とする() {
        // 「当座」が別の字や記号に読まれた形(AM-T19 の評価で見つかった)。種類の後に空白があること
        for value in ["当坐 4471029", "=座 4471029", "x 4471029"] {
            let page = GridPage::new(&[("振込先口座", LEFT_CELL), (value, RIGHT_CELL)]);
            assert_eq!(
                detect_page(&page, MatchDetail::AccountNumber),
                vec![Match::new(1, span(value, "4471029"), MatchDetail::AccountNumber)]
            );
        }
        // 空白の無い前置き・4 文字以上の前置きは対象外
        for value in ["当坐4471029", "ABCD 4471029"] {
            let page = GridPage::new(&[("振込先口座", LEFT_CELL), (value, RIGHT_CELL)]);
            assert!(detect_page(&page, MatchDetail::AccountNumber).is_empty());
        }
    }

    // ---- 横に並ぶ観測に分かれたカード番号 ----

    /// 4 桁 × 4 組のカード番号を、指定した組の数ずつ別の観測(左から右へ並ぶ)に分ける。
    /// `gap` は観測の間の隙間(正規化座標。負なら重なり)。1 文字の幅は 0.01。
    fn split_card_page(card: &str, parts: &[usize], gap: f64) -> (GridPage, Vec<String>) {
        let groups: Vec<&str> = card.split(' ').collect();
        let mut texts = Vec::new();
        let mut start = 0;
        for &n in parts {
            texts.push(groups[start..start + n].join(" "));
            start += n;
        }
        let mut x = 0.1;
        let mut cells = Vec::new();
        for text in &texts {
            let width = 0.01 * text.len() as f64;
            cells.push((x, 0.5, width, 0.05));
            x += width + gap;
        }
        let page = GridPage::new(
            &texts.iter().zip(&cells).map(|(t, c)| (t.as_str(), *c)).collect::<Vec<_>>(),
        );
        (page, texts)
    }

    #[test]
    fn 横に並ぶ観測に分かれたカード番号をつないで各観測を返す() {
        let card = grouped(&valid_card(16, 7), &[4, 4, 4, 4], " ");
        for (parts, gap) in [(vec![2, 1, 1], 0.003), (vec![2, 2], -0.004), (vec![1, 1, 1, 1], 0.015)] {
            let (page, texts) = split_card_page(&card, &parts, gap);
            let expected: Vec<Match> =
                texts.iter().enumerate().map(|(i, t)| Match::new(i, whole(t), MatchDetail::CardNumber)).collect();
            assert_eq!(detect_page(&page, MatchDetail::CardNumber), expected, "{parts:?}");
        }
    }

    #[test]
    fn 離れた観測やカードの形にならない数字はつながない() {
        let card = grouped(&valid_card(16, 7), &[4, 4, 4, 4], " ");
        // 隙間が 1 文字の幅の 2 倍を超える
        let (page, _) = split_card_page(&card, &[2, 2], 0.05);
        assert!(detect_page(&page, MatchDetail::CardNumber).is_empty());
        // つないでも桁が足りない(4 桁 × 3 組・Luhn なし)
        let short = grouped(&invalid_card(12, 5), &[4, 4, 4], " ");
        let (page, _) = split_card_page(&short, &[2, 1], 0.003);
        assert!(detect_page(&page, MatchDetail::CardNumber).is_empty());
        // 数字以外を含む観測は部品にしない
        let page = GridPage::new(&[("9123 4567", (0.1, 0.5, 0.09, 0.05)), ("期限 12/28", (0.193, 0.5, 0.1, 0.05))]);
        assert!(detect_page(&page, MatchDetail::CardNumber).is_empty());
    }

    #[test]
    fn 自分でカード番号を持つ観測は分かれたカードの部品にしない() {
        let card = grouped(&valid_card(16, 7), &[4, 4, 4, 4], " ");
        let next = grouped(&valid_card(16, 3), &[4, 4, 4, 4], " ");
        let page = GridPage::new(&[(card.as_str(), (0.1, 0.5, 0.19, 0.05)), (next.as_str(), (0.293, 0.5, 0.19, 0.05))]);
        assert_eq!(
            detect_page(&page, MatchDetail::CardNumber),
            vec![
                Match::new(0, whole(&card), MatchDetail::CardNumber),
                Match::new(1, whole(&next), MatchDetail::CardNumber)
            ]
        );
    }

    #[test]
    fn 英字の口座の手がかり語の後の番号を検出する() {
        // 英字の手がかり語(Account・Acct・A/C・ACH・Routing・Sort code・BSB・Checking・Savings)は 6〜17 桁、
        // Sort code(2-2-2)・BSB(3-3)の区切りも口座の値とする
        let cases = [
            ("Acct 41926370", "41926370"),
            ("Account No. 00123456", "00123456"),
            ("Account number: 1234567890", "1234567890"),
            ("ACH account 3349018822", "3349018822"),
            ("A/C 12345678", "12345678"),
            ("Routing 021000021", "021000021"),
            ("Sort code 12-34-56", "12-34-56"),
            ("BSB 062-000", "062-000"),
            ("Checking 55102938471", "55102938471"),
            ("Savings acct: 7712093", "7712093"),
        ];
        for (line, expected) in cases {
            assert_eq!(accounts(line), vec![span(line, expected)], "case {}", expected.len());
        }
        for line in ["Account settings", "Account 2024", "account 12345", "Acct manager", "Routing table 10"] {
            assert!(accounts(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 預金の種類の略記と貯蓄預金の後の番号を検出する() {
        let cases = [
            ("みずなら銀行 本店営業部 (普)2948105", "2948105"),
            ("(当) 0047719", "0047719"),
            ("（普）１２３４５６７", "１２３４５６７"),
            ("(普通)7012384", "7012384"),
            ("貯蓄預金 5519024", "5519024"),
            ("当座預金 0582201", "0582201"),
        ];
        for (line, expected) in cases {
            assert_eq!(accounts(line), vec![span(line, expected)], "case {}", expected.len());
        }
    }

    #[test]
    fn ゆうちょの記号と番号の形を検出する() {
        // 記号 5 桁(1 で始まり 0 で終わる)- 番号 6〜8 桁(1 で終わる)
        for line in ["10180-35781291", "記号番号 12340-1234561", "振込先 13570-246811"] {
            let expected = line.split(' ').next_back().unwrap_or(line);
            assert_eq!(accounts(line), vec![span(line, expected)], "case {}", line.len());
        }
        for line in ["12345-67890121", "10180-35781299", "10180-35781291-2", "A10180-35781291", "2026-10180-3578121"] {
            assert!(accounts(line).is_empty(), "case {}", line.len());
        }
    }

    /// 国コードと BBAN から、チェックディジット(mod-97)が正しい IBAN を組み立てる(架空の値)。
    fn iban(country: &str, bban: &str) -> String {
        let digits_of = |s: &str| -> String {
            s.chars().map(|c| if c.is_ascii_digit() { c.to_string() } else { (c as u32 - 'A' as u32 + 10).to_string() }).collect()
        };
        let numeric = format!("{}{}00", digits_of(bban), digits_of(country));
        let remainder = numeric.bytes().fold(0u32, |acc, b| (acc * 10 + u32::from(b - b'0')) % 97);
        format!("{country}{:02}{bban}", 98 - remainder)
    }

    /// 4 文字ずつ空白で区切る(IBAN の表示の形)。
    fn spaced4(text: &str) -> String {
        text.as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn チェックディジットが正しいibanを検出する() {
        // 架空の銀行コード ZZZZ・架空の国内番号
        for (country, bban) in [("GB", "ZZZZ00000041926370"), ("DE", "000000000041926370"), ("FR", "0000000000041926370ZZ12")] {
            let compact = iban(country, bban);
            for line in [compact.clone(), spaced4(&compact), format!("IBAN: {}", spaced4(&compact))] {
                let expected = if line.starts_with("IBAN") { spaced4(&compact) } else { line.clone() };
                assert_eq!(accounts(&line), vec![span(&line, &expected)], "case {}", line.len());
            }
        }
    }

    #[test]
    fn チェックディジットが合わないibanは同じ行に手がかり語があるときだけ検出する() {
        let valid = iban("GB", "ZZZZ00000041926370");
        // チェックディジットを 1 つずらした値(読み取りの誤りなど)
        let wrong = format!("GB{:02}{}", (valid[2..4].parse::<u32>().unwrap_or(0) + 1) % 100, &valid[4..]);
        let shown = spaced4(&wrong);
        assert!(accounts(&shown).is_empty());
        let line = format!("IBAN {shown}");
        assert_eq!(accounts(&line), vec![span(&line, &shown)]);
        // 同じ行の別の観測(表の右の列)に「IBAN」がある
        let page = GridPage::new(&[(shown.as_str(), LEFT_CELL), ("IBAN", RIGHT_CELL)]);
        assert_eq!(
            detect_page(&page, MatchDetail::AccountNumber),
            vec![Match::new(0, 0..shown.len(), MatchDetail::AccountNumber)]
        );
        // 国ごとの桁数に合わないもの・未知の国コードは手がかり語があっても対象外
        for line in ["IBAN GB82 ZZQM 0000 0041 9263", "IBAN QQ82 ZZQM 0000 0041 9263 70"] {
            assert!(accounts(line).is_empty(), "case {}", line.len());
        }
    }

    /// 表の見出しの行(氏名・金融機関・口座番号)と、口座番号の列の下に並ぶ値。
    fn account_table(values: &[&str]) -> GridPage {
        let mut cells: Vec<(&str, Cell)> = ["氏名", "金融機関", "口座番号"]
            .iter()
            .enumerate()
            .map(|(i, h)| (*h, (0.1 + 0.3 * i as f64, 0.8, 0.1, 0.03)))
            .collect();
        for (row, value) in values.iter().enumerate() {
            cells.push((value, (0.7, 0.75 - 0.05 * row as f64, 0.15, 0.03)));
        }
        GridPage::new(&cells)
    }

    #[test]
    fn 口座番号の見出しの列の値をすべて口座番号とする() {
        let values = ["6170482", "10180-35781291", "0093317"];
        let page = account_table(&values);
        let expected: Vec<Match> = values
            .iter()
            .enumerate()
            .map(|(i, v)| Match::new(3 + i, 0..v.len(), MatchDetail::AccountNumber))
            .collect();
        // ゆうちょの形は行ごとの規則で先に見つかるため、行の順に並べて比べる
        let mut found = detect_page(&page, MatchDetail::AccountNumber);
        found.sort_by_key(|m| m.line);
        assert_eq!(found, expected);
    }

    #[test]
    fn 口座番号の列は読み取りの崩れた値を飛ばして数字の無い観測で終わる() {
        let values = ["6170482", "0L10482", "0093317", "未登録", "8805126"];
        let page = account_table(&values);
        let lines: Vec<usize> = detect_page(&page, MatchDetail::AccountNumber).iter().map(|m| m.line).collect();
        assert_eq!(lines, vec![3, 5]);
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
    fn 主要な通貨の記号とisoコードの金額を検出する() {
        // 記号(前置・後置)、複数文字の記号(A$ など)、ISO 4217 のコード(前置・後置)
        let cases = [
            "£845.00", "￡120", "€3,210.50", "€ 99", "3.210,50 €", "CHF 2,450.00", "CHF 2'450.00", "A$64.00", "C$1,200",
            "HK$880", "S$45.90", "NZ$12", "US$300", "EUR 1.200,00", "GBP 75", "AUD 410.25", "1,299.00 USD", "500 EUR",
            "75.5 GBP", "₩50,000", "₹1,20,000", "10ドル", "50ユーロ", "20ポンド", "300元",
        ];
        for line in cases {
            assert_eq!(amounts(line), vec![whole(line)], "case {}", line.len());
        }
    }

    #[test]
    fn 小数のコンマとピリオドの両方式と負号を含める() {
        let cases = ["€3.210,50", "€1.234.567,89", "¥1.375,000", "-$120.00", "$-120.00", "−¥500", "-€12,50", "△1,000円", "▲2,000円"];
        for line in cases {
            assert_eq!(amounts(line), vec![whole(line)], "case {}", line.len());
        }
        let line = "Credit -$120.00 applied";
        assert_eq!(amounts(line), vec![span(line, "-$120.00")]);
        // 語の一部のハイフン(「ID-」の後)は負号にしない
        let line = "ID-$5";
        assert_eq!(amounts(line), vec![span(line, "$5")]);
    }

    #[test]
    fn 万億千を組み合わせた円の金額と末尾の記号を含める() {
        let cases = ["32万4,000円", "1億2,000万円", "1.5万円", "3億円", "5千円", "￥3,960-", "¥1,375,000-", "1,000円也", "¥5,000.-"];
        for line in cases {
            assert_eq!(amounts(line), vec![whole(line)], "case {}", line.len());
        }
        // 範囲のハイフン(後に数字が続く)は含めない
        let line = "¥3,960-4,000";
        assert_eq!(amounts(line)[0], span(line, "¥3,960"));
    }

    #[test]
    fn 行の中の英字の通貨の金額を前後の語を含めずに検出する() {
        let line = "Usage this month: A$64.00 overage";
        assert_eq!(amounts(line), vec![span(line, "A$64.00")]);
        let line = "Total 3.210,50 € incl. VAT";
        assert_eq!(amounts(line), vec![span(line, "3.210,50 €")]);
        let line = "refund CHF 2,450.00 → done";
        assert_eq!(amounts(line), vec![span(line, "CHF 2,450.00")]);
    }

    #[test]
    fn 通貨の記号やコードに見えても金額でないものは対象外() {
        for line in ["PHP 8.2", "MAUD 10", "USDT 100", "EURO 2024", "A$", "€", "EUR", "Version 1.2.3", "CHFX 10", "SA$ x"] {
            assert!(amounts(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 通貨記号や単位の無い数値は対象外() {
        for line in ["48,000", "合計 1,249.99", "3 個", "USD", "円", "¥", "JPYX 100", "2026-10-09"] {
            assert!(amounts(line).is_empty());
        }
    }
}
