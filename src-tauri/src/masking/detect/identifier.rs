//! ③識別子: 手がかり語付きの番号・人名・会社名(FR-005・FR-007)。手がかり語付きの番号は AM-T16、人名は AM-T21、会社名は AM-T22 で実装する。
//!
//! 正規化(全角→半角)後の文字列に規則を当てる。正規表現は線形時間の `regex` クレートだけを使う。
//!
//! - 手がかり語付きの番号: 手がかり語(`lexicon.rs`)+ 区切り + 英数字の値(`-`・`_` を含んでよい。数字を 1 つ以上含む)。
//!   値は空白・日本語・記号の手前で終わる。英字の手がかり語(「ID」「User ID」)は語の一部でないこと、
//!   値との間に空白か `:`・`=`・`#` があること
//! - 手がかり語だけの観測(数字を含まない短いラベル)は、同じ行の右隣(無ければ直下の行)の観測の先頭の値を番号とする
//!
//! 人名(ARCH_auto-masking §5.3 の (a)〜(d))。見逃し回避の方針のため、誤検出はある程度許す。
//!
//! - (a) 敬称(「様」「さん」「氏」「殿」)の直前のかな漢字列。敬称の直後が漢字なら語の一部(「様式」「氏名」)とみなす。
//!   漢字・カタカナより前のひらがなは助詞とみなして含めない。空白 1 つで区切られた「姓 名」まで
//! - (b) ラベル(「氏名」「名前」「担当(者)」「宛名」「差出人」「Name」)+ 区切り + 値。ラベルだけの観測は同じ行の右隣の観測を値とする
//! - (c) 手がかり語なし: 2 字以上の姓(辞書)+ 空白 0〜2 個 + かな漢字 1〜3 字。**1 字の姓は使わない**(辞書の承認時の決定)
//! - (d) 英字: ローマ字の姓・名の辞書の語を含む大文字始まりの 2〜3 語、または「Mr.」「Ms.」「Mrs.」「Dear」の後の大文字始まりの 1〜3 語。
//!   **2 字の辞書の語(go・ai・yu など)は大文字始まりの連なりの規則では手がかりにしない**(2026-10-09 の決定。1 字の姓と同じ扱い)。
//!   敬称・呼びかけ・ラベルがあれば 2 字の語も人名とする。呼びかけと敬称が続く形(「Dear Mr.」)、
//!   挨拶 + 読点(「Welcome,」)の後、山括弧のメールアドレスの直前(「Name <user@…>」)も人名とする
//!
//! AM-T23 で足した規則(手がかり語なしで辞書に無い姓・名を拾うため。辞書の中身は変えない)。
//!
//! - (e) 読み仮名の括弧(「(しおみ ちかげ)」)の直前のかな漢字列。名前か読みに空白があるときだけ
//! - (f) 人名とわかった 3 字以上の文字列の、同じページの別の出現
//! - (g) 観測全体が大文字始まりの 2〜3 語で、同じページのメールアドレスのローカル部と 2 語が対応するもの
//! - (h) 表の見出し(「氏名」「担当者」「担当」)の下に並ぶ、観測全体が名前の形の値
//!
//! 会社名(ARCH_auto-masking §5.3)。
//!
//! - 日本語: 会社の種類(「株式会社」「(株)」「㈱」「有限会社」「合同会社」など)+ 直前に続く名前の列(後置)。
//!   直前に名前が無ければ直後に続く名前の列(前置。種類の直後の空白 1 つを許す)。直前の列は数字を含めず、
//!   漢字・カタカナより前のひらがなは助詞とみなす。直後の列が助詞で始まるなら名前ではない。
//!   読み取りで「㈱」が「株」1 字・括弧の片方だけになった形(行頭・空白の後の「株」「株)」「(株」+ かな)も前置の種類とみなす
//! - 英字: 大文字始まりの 1〜3 語 + 「Inc.」「Co., Ltd.」「Ltd.」「LLC」「Corp.」
//! - ラベル(「会社名」「勤務先」「社名」「Company」)+ 区切り + 値。ラベルだけの観測は同じ行の右隣の観測を値とする
//!   (右隣も手がかり語・人名・会社のラベルなら表の見出しとみなして値にしない)

use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use super::super::layout::{near_right_neighbor, next_line_below, right_neighbor};
use super::super::text::{normalize, SensitiveText};
use super::super::{Match, MatchDetail, NormalizedRect, RecognizedPage};
use super::lexicon::{
    COMPANY_LABELS_ASCII, COMPANY_LABELS_JA, COMPANY_NAME_PARTICLES, COMPANY_SUFFIXES_ASCII, COMPANY_TYPES_JA,
    CUED_NUMBER_CUES_ASCII, CUED_NUMBER_KINDS_ASCII, CUED_NUMBER_KINDS_JA, CUED_NUMBER_SUBJECTS_ASCII,
    CUED_NUMBER_SUBJECTS_JA, CUE_PARTICLES, ENGLISH_NAME_GREETINGS, ENGLISH_NAME_TITLES, GIVEN_NAMES_ROMAJI, HONORIFICS,
    HONORIFIC_NON_NAMES, PERSON_COLUMN_LABELS_JA, PERSON_LABELS_ASCII, PERSON_LABELS_JA, SURNAMES_JA, SURNAMES_ROMAJI,
};
use super::{column_cells, is_hiragana, is_kana_kanji, is_kanji, is_katakana, is_katakana_mark, Line};

/// 手がかり語だけの観測(ラベル)とみなす文字数の上限。長い文は値を探さない。
const MAX_LABEL_CHARS: usize = 20;

/// 日本語の手がかり語(対象 + 空白 0〜1 個 + 番号の語)の正規表現の断片。語は行と同じ規則で正規化する
/// (長音 `ー` は `-` になる)。
fn ja_cue_pattern() -> String {
    format!(
        r"(?:{})\x20?(?:{})",
        normalized_alternatives(&CUED_NUMBER_SUBJECTS_JA),
        normalized_alternatives(&CUED_NUMBER_KINDS_JA)
    )
}

/// 英字の手がかり語(対象 + 番号の語、または「User ID」「ID」)の正規表現の断片。
fn en_cue_pattern() -> String {
    format!(r"(?:{}){CUED_NUMBER_KINDS_ASCII}|{}", CUED_NUMBER_SUBJECTS_ASCII.join("|"), CUED_NUMBER_CUES_ASCII.join("|"))
}

/// 手がかり語と値の間に入る助詞の正規表現の断片。
fn particle_pattern() -> String {
    CUE_PARTICLES.join("|")
}

/// 番号の値(英数字で始まり、英数字・`_`・`-` が続く)。
const VALUE_PATTERN: &str = r"[a-z0-9][a-z0-9_\-]*";

/// 手がかり語 + 区切り + 値。英字の手がかり語は前が英数字でないこと。
/// 区切りは `:`・`=`・`#`、助詞(「会員番号は 12345」。後に `:` が続いてもよい)、または空白だけ。
static CUED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)(?:(?P<ja>{ja})|(?:^|[^a-z0-9_])(?P<en>{en}))(?P<sep>\x20*[:=#]\x20*|\x20*(?:{particles})\x20*:?\x20*|\x20*)(?P<value>{VALUE_PATTERN})",
        ja = ja_cue_pattern(),
        en = en_cue_pattern(),
        particles = particle_pattern(),
    ))
    .expect("固定の正規表現が不正")
});

/// 手がかり語を含む観測(英字の手がかり語は語の一部でないこと)。
static LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i){ja}|(?:^|[^a-z0-9_])(?:{en})(?:$|[^a-z0-9_])",
        ja = ja_cue_pattern(),
        en = en_cue_pattern(),
    ))
    .expect("固定の正規表現が不正")
});

/// 観測の先頭の値。前後の空白を除いた文字列に当てる。
static LEADING_VALUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)^{VALUE_PATTERN}")).expect("固定の正規表現が不正"));

/// ③識別子の検出器(手がかり語付きの番号)。行ごとの規則に加え、ラベルの観測から右隣・直下の観測を値として探す。
pub(super) fn detect(page: &dyn RecognizedPage, lines: &[Line]) -> Vec<Match> {
    let mut matches = Vec::new();
    // 自分の行の中で手がかり語付きの番号が見つかった観測(ラベルの値として行の先頭を重ねて返さない)
    let mut has_own_value = Vec::with_capacity(lines.len());
    for line in lines {
        let found = find_cued_numbers(line.as_str());
        has_own_value.push(!found.is_empty());
        matches.extend(found.into_iter().filter_map(|r| line.to_match(r, MatchDetail::LabeledNumber)));
    }

    for (pos, line) in lines.iter().enumerate().filter(|(_, line)| is_label_only(line.as_str())) {
        // 表の見出しなら列の下に並ぶ値を番号とし、右隣(別の列の見出し)は値にしない
        let column = column_numbers(lines, &column_cells(page, lines, pos), &has_own_value);
        if !column.is_empty() {
            matches.extend(column);
            continue;
        }
        let Some(neighbor) = near_right_neighbor(page, line.index).or_else(|| next_line_below(page, line.index))
        else {
            continue;
        };
        let Some(position) = lines.iter().position(|l| l.index == neighbor) else {
            continue;
        };
        let value = &lines[position];
        if has_own_value[position] || is_label_only(value.as_str()) {
            continue;
        }
        if let Some(found) = leading_value(value.as_str()).and_then(|r| value.to_match(r, MatchDetail::LabeledNumber)) {
            matches.push(found);
        }
    }
    matches.extend(detect_person_names(page, lines));
    matches.extend(detect_company_names(page, lines));
    matches
}

/// 表の列の値とみなす、英字の大文字・小文字の切り替わりの最小回数(数字を含まない値のとき)。
/// 読み取りで `0` が `O` になった ID を拾い、「admin」「Tokyo」のような普通の語を除く。
const MIN_COLUMN_CASE_CHANGES: usize = 2;

/// 表の列の値の形: ASCII で、数字を含むか大文字・小文字の切り替わりが 2 回以上ある。
fn is_column_identifier(value: &str) -> bool {
    let case_changes = value
        .as_bytes()
        .windows(2)
        .filter(|w| w[0].is_ascii_alphabetic() && w[1].is_ascii_alphabetic())
        .filter(|w| w[0].is_ascii_uppercase() != w[1].is_ascii_uppercase())
        .count();
    !value.is_empty()
        && value.is_ascii()
        && (value.bytes().any(|b| b.is_ascii_digit()) || case_changes >= MIN_COLUMN_CASE_CHANGES)
}

/// 表の列の観測(`cells` は `lines` の位置)を上から順に番号とする。観測全体(前後の空白を除く)が
/// 番号の形(`is_column_identifier`)の間だけ続ける(読み取りで入った途中の空白を許すため、先頭の値ではなく観測全体を採る)。
fn column_numbers(lines: &[Line], cells: &[usize], has_own_value: &[bool]) -> Vec<Match> {
    let mut found = Vec::new();
    for &pos in cells {
        let text = lines[pos].as_str();
        let start = text.len() - text.trim_start().len();
        let value = text.trim();
        let is_number = is_column_identifier(value) && !has_own_value[pos] && !is_label_only(value);
        if !is_number {
            break;
        }
        if let Some(m) = lines[pos].to_match(start..start + value.len(), MatchDetail::LabeledNumber) {
            found.push(m);
        }
    }
    found
}

/// ③会社名の検出(会社の種類・英字の会社の種類・ラベル)。同じ範囲は 1 つにする。
fn detect_company_names(page: &dyn RecognizedPage, lines: &[Line]) -> Vec<Match> {
    let mut matches = Vec::new();
    for line in lines {
        let text = line.as_str();
        let mut ranges = japanese_companies(text);
        ranges.extend(english_companies(text));
        ranges.extend(labeled_companies(text));
        ranges.sort_by_key(|r| (r.start, r.end));
        ranges.dedup();
        matches.extend(ranges.into_iter().filter_map(|r| line.to_match(r, MatchDetail::CompanyName)));
    }

    for line in lines.iter().filter(|line| is_company_label_only(line.as_str())) {
        let Some(neighbor) = right_neighbor(page, line.index) else {
            continue;
        };
        let Some(value) = lines.iter().find(|l| l.index == neighbor) else {
            continue;
        };
        // 表の見出しの行(右隣も別のラベル)は値にしない
        let value_text = value.as_str();
        if is_company_label_only(value_text) || is_person_label_only(value_text) || is_label_only(value_text) {
            continue;
        }
        if let Some(found) = company_value(value.as_str(), 0).and_then(|r| value.to_match(r, MatchDetail::CompanyName)) {
            if !matches.contains(&found) {
                matches.push(found);
            }
        }
    }
    matches
}

/// 会社名の名前の列(会社の種類の前後)の文字数の上限。
const MAX_COMPANY_NAME_CHARS: usize = 20;

/// 正規化済みの語(長いものを先)の正規表現の選択肢。
fn normalized_alternatives(words: &[&str]) -> String {
    let mut words: Vec<String> =
        words.iter().map(|word| normalize(&SensitiveText::new((*word).to_string())).as_str().to_string()).collect();
    words.sort_by_key(|word| std::cmp::Reverse(word.len()));
    words.iter().map(|word| regex::escape(word)).collect::<Vec<_>>().join("|")
}

/// 日本語の会社の種類。
static COMPANY_TYPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&normalized_alternatives(&COMPANY_TYPES_JA)).expect("固定の正規表現が不正"));

/// 日本語の会社名(バイト範囲)。種類の直前に名前があれば後置、無ければ直後の名前(前置)。
fn japanese_companies(text: &str) -> Vec<Range<usize>> {
    let mut found = Vec::new();
    for company_type in COMPANY_TYPE.find_iter(text) {
        let before = company_name_before(text, company_type.start());
        if before < company_type.start() {
            found.push(before..company_type.end());
            continue;
        }
        // 種類と名前の間の空白 1 つまで(読み取りで入った空白)
        let name_start = company_type.end() + usize::from(text[company_type.end()..].starts_with(' '));
        let name_end = extend_english_words(text, name_start, company_name_after(text, name_start));
        if name_end > name_start {
            found.push(company_type.start()..name_end);
        }
    }
    // 「㈱」が「株」1 字・括弧の片方だけと読まれた形(行頭・空白の後で、かなが続くとき)は前置の会社の種類とみなす
    for caps in MISREAD_KABU.captures_iter(text) {
        let Some(kabu) = caps.name("kabu") else {
            continue;
        };
        let name_end = company_name_after(text, kabu.end());
        if name_end > kabu.end() {
            found.push(kabu.start()..name_end);
        }
    }
    found
}

/// 読み取りで「㈱」が「株」1 字・括弧の片方だけの形になったもの(行頭・空白の後の「株」「株)」「(株」+ かな)。
static MISREAD_KABU: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|\x20)(?P<kabu>\(?株\)?)[\p{Hiragana}\p{Katakana}]").expect("固定の正規表現が不正")
});

/// 名前の前半のひらがなの列とみなす文字数の下限(「やまびこ醸造」の「やまびこ」)。1 字は助詞とみなす。
const MIN_LEADING_HIRAGANA: usize = 2;

/// `end` の直前から後ろ向きに集めた名前の列の始まり(バイト位置)。数字は含めず、
/// 漢字・カタカナ・英字より前のひらがなは助詞とみなす。名前が無ければ `end`。
/// ただし、その前のひらがなの列(2 字以上・漢字側の端が助詞でない)が語の区切り(行頭・空白・記号)から
/// 始まるなら、名前の前半(「やまびこ醸造合資会社」)として含める。
fn company_name_before(text: &str, end: usize) -> usize {
    let chars: Vec<(usize, char)> = text[..end].char_indices().collect();
    let mut start = end;
    let mut has_non_hiragana = false;
    let mut k = chars.len();
    while k > 0 && chars.len() - k < MAX_COMPANY_NAME_CHARS {
        let (i, c) = chars[k - 1];
        let left = (k >= 2).then(|| chars[k - 2].1);
        let accepted = if is_hiragana(c) {
            !has_non_hiragana
        } else if is_kanji(c) || is_katakana(c) || c.is_ascii_alphabetic() {
            has_non_hiragana = true;
            true
        } else {
            is_katakana_mark(c) && left.is_some_and(is_katakana)
        };
        if !accepted {
            break;
        }
        start = i;
        k -= 1;
    }
    if !has_non_hiragana || k == 0 || !is_hiragana(chars[k - 1].1) || COMPANY_NAME_PARTICLES.contains(&chars[k - 1].1) {
        return start;
    }
    let mut j = k;
    while j > 0 && is_hiragana(chars[j - 1].1) && chars.len() - j < MAX_COMPANY_NAME_CHARS {
        j -= 1;
    }
    let at_boundary = j == 0 || !(is_kana_kanji(chars[j - 1].1) || chars[j - 1].1.is_ascii_alphanumeric());
    if at_boundary && k - j >= MIN_LEADING_HIRAGANA {
        start = chars[j].0;
    }
    start
}

/// 前置の会社の種類の後の名前が英字だけなら、空白 1 つで続く大文字・数字始まりの語を 3 語まで含める
/// (「株式会社 Kumoyuki Systems」)。続かなければ `end` のまま。
fn extend_english_words(text: &str, start: usize, end: usize) -> usize {
    if end == start || !text[start..end].bytes().all(|b| b.is_ascii_alphanumeric()) {
        return end;
    }
    ENGLISH_NAME_WORDS.find(&text[end..]).map_or(end, |m| end + m.end())
}

/// 前置の会社の種類の後に続く英字の語(空白 1 つ + 大文字・数字始まり。3 語まで)。
static ENGLISH_NAME_WORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:\x20[A-Z0-9][A-Za-z0-9&'\-]*){1,3}").expect("固定の正規表現が不正"));

/// `start` から前向きに集めた名前の列の終わり(バイト位置)。空白・記号の手前で終わる。助詞で始まるなら `start`。
fn company_name_after(text: &str, start: usize) -> usize {
    let mut end = start;
    let mut prev = None;
    for (offset, c) in text[start..].chars().take(MAX_COMPANY_NAME_CHARS).enumerate() {
        if offset == 0 && COMPANY_NAME_PARTICLES.contains(&c) {
            break;
        }
        if !(is_kana_kanji(c) || c.is_ascii_alphanumeric() || (is_katakana_mark(c) && prev.is_some_and(is_katakana)))
        {
            break;
        }
        end += c.len_utf8();
        prev = Some(c);
    }
    end
}

/// 英字の会社名: 大文字始まりの 1〜3 語 + 会社の種類。
static ENGLISH_COMPANY: LazyLock<Regex> = LazyLock::new(|| {
    let word = r"[A-Z][A-Za-z0-9&'\-]*";
    Regex::new(&format!(
        r"(?:^|[^A-Za-z0-9])(?P<name>{word}(?:\x20{word}){{0,2}},?\x20(?:{suffixes}))",
        suffixes = COMPANY_SUFFIXES_ASCII.join("|"),
    ))
    .expect("固定の正規表現が不正")
});

/// 英字の会社名(バイト範囲)。
fn english_companies(text: &str) -> Vec<Range<usize>> {
    ENGLISH_COMPANY.captures_iter(text).filter_map(|caps| caps.name("name").map(|m| m.range())).collect()
}

/// 会社のラベル + 区切り。日本語のラベルは `:` か空白、英字のラベルは語の一部でなく `:` が要る。
static COMPANY_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:{ja})(?:\x20*:\x20*|\x20+)|(?i:(?:^|[^a-z0-9_])(?:{en})\x20*:\x20*)",
        ja = normalized_alternatives(&COMPANY_LABELS_JA),
        en = COMPANY_LABELS_ASCII.join("|"),
    ))
    .expect("固定の正規表現が不正")
});

/// 会社のラベルだけの観測(「会社名」「勤務先:」「Company」)。前後の空白を除いた文字列に当てる。
static COMPANY_LABEL_ONLY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(?:{ja}|(?i:{en}))\x20*:?$",
        ja = normalized_alternatives(&COMPANY_LABELS_JA),
        en = COMPANY_LABELS_ASCII.join("|"),
    ))
    .expect("固定の正規表現が不正")
});

fn is_company_label_only(text: &str) -> bool {
    COMPANY_LABEL_ONLY.is_match(text.trim())
}

/// 同じ行の会社のラベルの後の会社名(バイト範囲)。
fn labeled_companies(text: &str) -> Vec<Range<usize>> {
    COMPANY_LABEL.find_iter(text).filter_map(|label| company_value(text, label.end())).collect()
}

/// 英字の会社名の値(1〜5 語)。
static ENGLISH_COMPANY_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9][A-Za-z0-9&'.,\-]*(?:\x20[A-Za-z0-9&'.,\-]+){0,4}").expect("固定の正規表現が不正")
});

/// `start` から始まる会社名の値(空白を飛ばす)。英字なら 1〜5 語、日本語なら名前の列。
fn company_value(text: &str, start: usize) -> Option<Range<usize>> {
    let start = start + (text[start..].len() - text[start..].trim_start_matches(' ').len());
    let first = text[start..].chars().next()?;
    let end = if first.is_ascii_alphanumeric() {
        let value = ENGLISH_COMPANY_VALUE.find(&text[start..])?;
        start + value.as_str().trim_end_matches(',').len()
    } else {
        company_name_after(text, start)
    };
    (end > start).then_some(start..end)
}

/// ③人名の検出(敬称・ラベル・姓の辞書・英字の人名・読み仮名・メールアドレス・表の列・同じページの別の出現)。
/// 同じ範囲は 1 つにし、`lines` の順・範囲の順に並べる。
fn detect_person_names(page: &dyn RecognizedPage, lines: &[Line]) -> Vec<Match> {
    // (`lines` の位置, バイト範囲)
    let mut found: Vec<(usize, Range<usize>)> = Vec::new();
    let email_locals = email_local_parts(lines);
    for (pos, line) in lines.iter().enumerate() {
        let text = line.as_str();
        let mut ranges = names_before_honorifics(text);
        ranges.extend(labeled_names(text));
        ranges.extend(surname_names(text));
        ranges.extend(english_names(text));
        ranges.extend(names_before_readings(text));
        ranges.extend(email_matched_name(text, &email_locals));
        found.extend(ranges.into_iter().map(|r| (pos, r)));
    }

    for (pos, line) in lines.iter().enumerate().filter(|(_, line)| is_person_label_only(line.as_str())) {
        // 表の見出しなら下に並ぶ値を人名とし、右隣(別の列の見出し)は値にしない
        let column = column_names(page, lines, pos);
        if !column.is_empty() {
            found.extend(column);
            continue;
        }
        let Some(neighbor) = right_neighbor(page, line.index) else {
            continue;
        };
        let Some(value_pos) = lines.iter().position(|l| l.index == neighbor) else {
            continue;
        };
        let value = lines[value_pos].as_str();
        if is_person_label_only(value) {
            continue;
        }
        if let Some(range) = name_value(value, 0) {
            found.push((value_pos, range));
        }
    }

    let repeated = repeated_names(lines, &found);
    found.extend(repeated);
    found.sort_by_key(|(pos, r)| (*pos, r.start, r.end));
    found.dedup();
    found.into_iter().filter_map(|(pos, r)| lines[pos].to_match(r, MatchDetail::PersonName)).collect()
}

/// (e) 読み仮名の括弧(「(しおみ ちかげ)」)。かな 1〜2 語。
static READING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\((?P<reading>[\x{3041}-\x{3096}\x{30a1}-\x{30fa}\-]+(?:\x20[\x{3041}-\x{3096}\x{30a1}-\x{30fa}\-]+)?)\)")
        .expect("固定の正規表現が不正")
});

/// (e) 読み仮名の括弧の直前のかな漢字列(漢字を含む)。名前か読みのどちらかに空白(姓と名の区切り)があること
/// (「注意(ちゅうい)」のような語の読みを除く)。
fn names_before_readings(text: &str) -> Vec<Range<usize>> {
    READING
        .captures_iter(text)
        .filter_map(|caps| {
            let (whole, reading) = (caps.get(0)?, caps.name("reading")?);
            let range = name_before(text, whole.start())?;
            let name = &text[range.clone()];
            (name.chars().any(is_kanji) && (name.contains(' ') || reading.as_str().contains(' '))).then_some(range)
        })
        .collect()
}

/// (g) メールアドレスのローカル部(`@` の前)。
static EMAIL_LOCAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?P<local>[A-Za-z0-9][A-Za-z0-9._+\-]*)@[A-Za-z0-9\-]+\.").expect("固定の正規表現が不正")
});

/// (g) 観測全体が大文字始まりの 2〜3 語。
static WHOLE_CAPITALIZED_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^[A-Z][A-Za-z'\-]+(?:\x20[A-Z][A-Za-z'\-]+){{1,{}}}$", MAX_ENGLISH_WORDS - 1))
        .expect("固定の正規表現が不正")
});

/// (g) メールアドレスのローカル部の名前と照らす語の長さの下限(頭文字は別に扱う)。
const MIN_EMAIL_NAME_TOKEN_LEN: usize = 3;

/// ページ内のメールアドレスのローカル部を `.`・`_`・`+`・`-` で区切った語(小文字)。アドレスごとに返す。
fn email_local_parts(lines: &[Line]) -> Vec<Vec<String>> {
    lines
        .iter()
        .flat_map(|line| EMAIL_LOCAL.captures_iter(line.as_str()).filter_map(|caps| caps.name("local")))
        .map(|local| {
            local
                .as_str()
                .split(['.', '_', '+', '-'])
                .filter(|token| !token.is_empty())
                .map(str::to_ascii_lowercase)
                .collect()
        })
        .collect()
}

/// (g) 観測全体が大文字始まりの 2〜3 語で、同じページのメールアドレスのローカル部と 2 語が対応するもの
/// (1 語が 3 字以上の語と一致し、別の 1 語が別の語と一致するか頭文字が 1 字の語と一致する。
/// 「Sales Report」と `sales@` のような 1 語だけの一致は除く)。
fn email_matched_name(text: &str, email_locals: &[Vec<String>]) -> Option<Range<usize>> {
    let trimmed = text.trim();
    if email_locals.is_empty() || !WHOLE_CAPITALIZED_NAME.is_match(trimmed) {
        return None;
    }
    let words: Vec<String> = trimmed.split(' ').map(str::to_ascii_lowercase).collect();
    let matched = email_locals.iter().any(|tokens| {
        words.iter().enumerate().any(|(i, word)| {
            let Some(t) = tokens.iter().position(|token| token.len() >= MIN_EMAIL_NAME_TOKEN_LEN && token == word) else {
                return false;
            };
            words.iter().enumerate().filter(|&(j, _)| j != i).any(|(_, other)| {
                tokens.iter().enumerate().filter(|&(k, _)| k != t).any(|(_, token)| {
                    token == other || (token.len() == 1 && other.starts_with(token.as_str()))
                })
            })
        })
    });
    let start = text.len() - text.trim_start().len();
    matched.then_some(start..start + trimmed.len())
}

/// (h) 表の見出しとみなす行の観測の数の下限(ラベルと値の 2 列だけのフォームを除く)。
const MIN_HEADER_ROW_CELLS: usize = 3;

/// (h) 表の見出しとみなす観測の文字数の上限。
const MAX_HEADER_CHARS: usize = 8;

/// (h) 表の見出しらしい観測か(短く、空白・数字を含まない)。
fn is_header_like(text: &str) -> bool {
    let text = text.trim();
    !text.is_empty()
        && text.chars().count() <= MAX_HEADER_CHARS
        && !text.chars().any(|c| c == ' ' || c.is_ascii_digit())
}

/// (h) 表の列の見出しになる人名のラベル(「氏名」「担当者:」など)か。
fn is_person_column_label(text: &str) -> bool {
    let label = text.trim().trim_end_matches(':').trim_end();
    PERSON_COLUMN_LABELS_JA
        .iter()
        .any(|l| normalize(&SensitiveText::new((*l).to_string())).as_str() == label)
}

/// (h) 表の列として下へたどる行の数の上限。
const MAX_COLUMN_ROWS: usize = 50;

/// 縦の中心が `row` の高さの範囲に入るか(同じ行とみなす)。
fn in_same_row(rect: &NormalizedRect, row: &NormalizedRect) -> bool {
    let center = rect.y + rect.height / 2.0;
    center >= row.y && center <= row.y + row.height
}

/// (h) 表の列の見出しになる人名のラベル(`PERSON_COLUMN_LABELS_JA`)だけの観測が表の見出しなら、
/// その下に並ぶ値の観測を人名とする。表の見出しとみなすのは、同じ行に 3 つ以上の観測があり、
/// そのすべてが見出しらしい(短く、空白・数字を含まない)とき(隣に値が並ぶフォームを除く)。
/// 左端が見出しの左端から見出しの高さ以内に揃う観測を上から順にたどり、前の観測との間が前の観測の高さ以内で、
/// 観測全体が人名の値の形(ラベルでない)である間だけ続ける。
fn column_names(page: &dyn RecognizedPage, lines: &[Line], header_pos: usize) -> Vec<(usize, Range<usize>)> {
    if !is_person_column_label(lines[header_pos].as_str()) {
        return Vec::new();
    }
    let header = page.line_box(lines[header_pos].index);
    let row: Vec<&Line> = lines.iter().filter(|l| in_same_row(&page.line_box(l.index), &header)).collect();
    if row.len() < MIN_HEADER_ROW_CELLS || !row.iter().all(|l| is_header_like(l.as_str())) {
        return Vec::new();
    }
    let mut found = Vec::new();
    let mut prev_box = header;
    for _ in 0..MAX_COLUMN_ROWS {
        // 前の観測より下(縦の中心が前の観測の下端より下)で、左端が見出しの左端に揃う観測のうち最も上のもの
        let Some((pos, cell)) = lines
            .iter()
            .enumerate()
            .map(|(pos, l)| (pos, page.line_box(l.index)))
            .filter(|(_, cell)| cell.y + cell.height / 2.0 < prev_box.y && (cell.x - header.x).abs() <= header.height)
            .max_by(|(pa, a), (pb, b)| (a.y + a.height).total_cmp(&(b.y + b.height)).then(pb.cmp(pa)))
        else {
            break;
        };
        if prev_box.y - (cell.y + cell.height) > prev_box.height {
            break;
        }
        let Some(range) = whole_name_value(lines[pos].as_str()) else {
            break;
        };
        found.push((pos, range));
        prev_box = cell;
    }
    found
}

/// 観測全体(前後の空白を除く)が人名の値の形ならその範囲。ラベル・番号を含むものは除く。
fn whole_name_value(text: &str) -> Option<Range<usize>> {
    if is_person_label_only(text) || is_label_only(text) || is_company_label_only(text) {
        return None;
    }
    let range = name_value(text, 0)?;
    (range.end == text.trim_end().len()).then_some(range)
}

/// (f) 同じページの別の出現として広げる名前の長さの下限(空白を除く文字数)。
const MIN_REPEATED_NAME_CHARS: usize = 3;

/// (f) 見つけた人名と同じ文字列(空白の有無は問わない)の、同じページの別の出現。
/// 広げるのは漢字・カタカナを含む 3 字以上の名前と、大文字始まりの 2〜3 語の英字の名前だけ。
fn repeated_names(lines: &[Line], found: &[(usize, Range<usize>)]) -> Vec<(usize, Range<usize>)> {
    let mut keys: Vec<Vec<char>> = found
        .iter()
        .filter_map(|(pos, r)| {
            let name = lines[*pos].as_str().get(r.clone())?;
            let japanese = name.chars().any(|c| is_kanji(c) || is_katakana(c));
            let english = WHOLE_CAPITALIZED_NAME.is_match(name);
            (japanese || english).then(|| name.chars().filter(|&c| c != ' ').collect::<Vec<char>>())
        })
        .filter(|key| key.len() >= MIN_REPEATED_NAME_CHARS)
        .collect();
    keys.sort();
    keys.dedup();

    let mut repeated = Vec::new();
    for (pos, line) in lines.iter().enumerate() {
        let text = line.as_str();
        let compact: Vec<(usize, char)> = text.char_indices().filter(|&(_, c)| c != ' ').collect();
        for key in &keys {
            for start in 0..compact.len().saturating_sub(key.len() - 1) {
                let window = &compact[start..start + key.len()];
                if !window.iter().map(|&(_, c)| c).eq(key.iter().copied()) {
                    continue;
                }
                let (begin, (last, last_char)) = (window[0].0, window[key.len() - 1]);
                let end = last + last_char.len_utf8();
                // 英字の名前は語の一部でないこと
                let bounded = !key[0].is_ascii()
                    || (!text[..begin].chars().next_back().is_some_and(|c| c.is_ascii_alphanumeric())
                        && !text[end..].chars().next().is_some_and(|c| c.is_ascii_alphanumeric()));
                if bounded {
                    repeated.push((pos, begin..end));
                }
            }
        }
    }
    repeated
}

/// 人名とみなす文字列の長さの上限(空白を除く文字数)。
const MAX_NAME_CHARS: usize = 10;

/// (c) 手がかり語なしの規則で姓の後に続ける文字数の上限。
const MAX_GIVEN_CHARS: usize = 3;

/// (c) 姓と名の間に許す空白の数。
const MAX_GAP_SPACES: usize = 2;

/// (d) 英字の人名の語数の上限。
const MAX_ENGLISH_WORDS: usize = 3;

fn starts_with_honorific(text: &str) -> bool {
    HONORIFICS.iter().any(|h| text.starts_with(h))
}

/// (a) 敬称の直前のかな漢字列(バイト範囲)。
fn names_before_honorifics(text: &str) -> Vec<Range<usize>> {
    let mut found = Vec::new();
    for (pos, _) in text.char_indices() {
        let Some(honorific) = HONORIFICS.iter().find(|h| text[pos..].starts_with(*h)) else {
            continue;
        };
        // 「様式」「氏名」「殿下」など、敬称の直後が漢字なら語の一部
        if text[pos + honorific.len()..].chars().next().is_some_and(is_kanji) {
            continue;
        }
        if let Some(range) = name_before(text, pos) {
            found.push(range);
        }
    }
    found
}

/// `end` の直前(空白を除く)から後ろ向きに集めた人名の範囲。
fn name_before(text: &str, end: usize) -> Option<Range<usize>> {
    let end = text[..end].trim_end_matches(' ').len();
    let chars: Vec<(usize, char)> = text[..end].char_indices().collect();
    let mut start = end;
    let mut count = 0;
    let mut has_non_hiragana = false;
    let mut space_at = None;
    let mut k = chars.len();
    while k > 0 && count < MAX_NAME_CHARS {
        let (i, c) = chars[k - 1];
        let left = (k >= 2).then(|| chars[k - 2].1);
        let accepted = if c == ' ' {
            // 空白 1 つで区切られた「姓 名」まで
            let next_ok = left.is_some_and(|l| is_kanji(l) || is_katakana(l) || (is_hiragana(l) && !has_non_hiragana));
            if space_at.is_none() && count > 0 && next_ok {
                space_at = Some(i);
                k -= 1;
                continue;
            }
            false
        } else if is_kanji(c) || is_katakana(c) {
            has_non_hiragana = true;
            true
        } else if is_hiragana(c) {
            // 漢字・カタカナより前のひらがなは助詞とみなす
            !has_non_hiragana
        } else {
            is_katakana_mark(c) && left.is_some_and(is_katakana)
        };
        if !accepted {
            break;
        }
        start = i;
        count += 1;
        k -= 1;
    }
    // 空白の前の区切りがラベル(「ご担当 しおみ様」)なら含めない
    if let Some(space) = space_at.filter(|&space| space > start) {
        if PERSON_LABELS_JA.contains(&&text[start..space]) {
            start = space + 1;
        }
    }
    let name = text.get(start..end)?;
    (!name.is_empty() && !name.starts_with(' ') && !HONORIFIC_NON_NAMES.contains(&name)).then_some(start..end)
}

/// 日本語のラベル(正規化済み・長いものを先)の正規表現の選択肢。
fn person_label_ja_pattern() -> String {
    let mut labels: Vec<String> = PERSON_LABELS_JA
        .iter()
        .map(|label| normalize(&SensitiveText::new((*label).to_string())).as_str().to_string())
        .collect();
    labels.sort_by_key(|label| std::cmp::Reverse(label.len()));
    labels.iter().map(|label| regex::escape(label)).collect::<Vec<_>>().join("|")
}

/// (b) ラベル + 区切り。日本語のラベルは `:` か空白、英字のラベルは語の一部でなく `:` が要る。
static PERSON_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:{ja})(?:\x20*:\x20*|\x20+)|(?i:(?:^|[^a-z0-9_])(?:{en})\x20*:\x20*)",
        ja = person_label_ja_pattern(),
        en = PERSON_LABELS_ASCII.join("|"),
    ))
    .expect("固定の正規表現が不正")
});

/// (b) ラベルだけの観測(「担当者」「差出人:」「Name」)。前後の空白を除いた文字列に当てる。
static PERSON_LABEL_ONLY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^お?(?:{ja}|(?i:{en}))\x20*:?$",
        ja = person_label_ja_pattern(),
        en = PERSON_LABELS_ASCII.join("|"),
    ))
    .expect("固定の正規表現が不正")
});

fn is_person_label_only(text: &str) -> bool {
    PERSON_LABEL_ONLY.is_match(text.trim())
}

/// (b) 同じ行のラベルの後の人名(バイト範囲)。
fn labeled_names(text: &str) -> Vec<Range<usize>> {
    PERSON_LABEL.find_iter(text).filter_map(|label| name_value(text, label.end())).collect()
}

/// `start` から始まる人名の値(空白を飛ばす)。英字なら大文字・小文字を問わず 1〜3 語、日本語ならかな漢字の列。
fn name_value(text: &str, start: usize) -> Option<Range<usize>> {
    let start = start + (text[start..].len() - text[start..].trim_start_matches(' ').len());
    let first = text[start..].chars().next()?;
    if first.is_ascii_alphabetic() {
        let value = ENGLISH_VALUE.find(&text[start..])?;
        let end = start + value.end();
        // メールアドレス・ドメインの一部(直後が `@`、または `.` + 英数字)は名前にしない
        let mut rest = text[end..].chars();
        let next = rest.next();
        if next == Some('@') || (next == Some('.') && rest.next().is_some_and(|c| c.is_ascii_alphanumeric())) {
            return None;
        }
        Some(start..end)
    } else if is_kana_kanji(first) {
        japanese_name_after(text, start)
    } else {
        None
    }
}

/// 英字の値(1〜3 語)。
static ENGLISH_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^[A-Za-z][A-Za-z'\-]*(?:\x20[A-Za-z][A-Za-z'\-]*){{0,{}}}", MAX_ENGLISH_WORDS - 1))
        .expect("固定の正規表現が不正")
});

/// `start` から前向きに集めたかな漢字の人名(空白 1 つで区切られた「姓 名」まで。敬称の手前で終わる)。
fn japanese_name_after(text: &str, start: usize) -> Option<Range<usize>> {
    let mut end = start;
    let mut count = 0;
    let mut spaced = false;
    let mut prev = None;
    for (offset, c) in text[start..].char_indices() {
        let i = start + offset;
        if count >= MAX_NAME_CHARS || starts_with_honorific(&text[i..]) {
            break;
        }
        if c == ' ' {
            let next = text[i + 1..].chars().next();
            if spaced || count == 0 || !next.is_some_and(is_kana_kanji) || starts_with_honorific(&text[i + 1..]) {
                break;
            }
            spaced = true;
            prev = Some(c);
            continue;
        }
        if !(is_kana_kanji(c) || (is_katakana_mark(c) && prev.is_some_and(is_katakana))) {
            break;
        }
        end = i + c.len_utf8();
        count += 1;
        prev = Some(c);
    }
    (end > start).then_some(start..end)
}

/// (c) 2 字以上の姓(辞書)+ 空白 0〜2 個 + かな漢字 1〜3 字(バイト範囲)。
fn surname_names(text: &str) -> Vec<Range<usize>> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let byte_at = |k: usize| chars.get(k).map_or(text.len(), |&(i, _)| i);
    let mut found = Vec::new();
    let mut k = 0;
    while k < chars.len() {
        // 長い姓を先に試す。1 字の姓は使わない
        let surname_end = (2..=3).rev().map(|n| k + n).find(|&e| {
            e <= chars.len() && chars[k..e].iter().all(|&(_, c)| is_kanji(c) || c == 'ヶ' || c == 'ノ')
                && SURNAMES_JA.contains(&text[byte_at(k)..byte_at(e)])
        });
        let Some(surname_end) = surname_end else {
            k += 1;
            continue;
        };
        let mut j = surname_end;
        while j < chars.len() && j - surname_end < MAX_GAP_SPACES && chars[j].1 == ' ' {
            j += 1;
        }
        let given_start = j;
        while j < chars.len()
            && j - given_start < MAX_GIVEN_CHARS
            && is_kana_kanji(chars[j].1)
            && !starts_with_honorific(&text[byte_at(j)..])
        {
            j += 1;
        }
        if j > given_start {
            found.push(byte_at(k)..byte_at(j));
            k = j;
        } else {
            k += 1;
        }
    }
    found
}

/// (d) 大文字始まりの語の連なり(1 語 2 字以上)。
static CAPITALIZED_RUN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[^A-Za-z0-9])(?P<run>[A-Z][A-Za-z'\-]+(?:\x20[A-Z][A-Za-z'\-]+)*)").expect("固定の正規表現が不正")
});

/// (d) 敬称・呼びかけの後の大文字始まりの 1〜3 語。
static TITLED_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:^|[^A-Za-z0-9])(?:{titles})(?:\x20+(?:{titles}))*\x20+(?P<name>[A-Z][A-Za-z'\-]+(?:\x20[A-Z][A-Za-z'\-]+){{0,{more}}})",
        titles = ENGLISH_NAME_TITLES.join("|"),
        more = MAX_ENGLISH_WORDS - 1,
    ))
    .expect("固定の正規表現が不正")
});

/// (d) 挨拶 + 読点の後の大文字始まりの 1〜3 語(「Welcome, …」)。挨拶は大文字・小文字を区別しない。
static GREETED_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:^|[^A-Za-z0-9])(?i:{greetings}),\x20*(?P<name>[A-Z][A-Za-z'\-]+(?:\x20[A-Z][A-Za-z'\-]+){{0,{more}}})",
        greetings = ENGLISH_NAME_GREETINGS.join("|"),
        more = MAX_ENGLISH_WORDS - 1,
    ))
    .expect("固定の正規表現が不正")
});

/// (d) 山括弧のメールアドレスの直前の大文字始まりの 2〜3 語(「Name <user@example.com>」)。
static NAME_BEFORE_ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:^|[^A-Za-z0-9])(?P<name>[A-Z][A-Za-z'\-]+(?:\x20[A-Z][A-Za-z'\-]+){{1,{more}}})\x20*<[^<>\x20]*@",
        more = MAX_ENGLISH_WORDS - 1,
    ))
    .expect("固定の正規表現が不正")
});

/// 語が敬称・呼びかけ(「Dear」「Mr」など。末尾の `.` を除いた形)か。
fn is_title_word(word: &str) -> bool {
    matches!(word, "Dear" | "Mr" | "Mrs" | "Ms")
}

/// 語がローマ字の姓・名の辞書にあるか(ASCII の大文字・小文字を区別しない)。
fn is_romaji_name(word: &str) -> bool {
    let lower = word.to_ascii_lowercase();
    SURNAMES_ROMAJI.contains(lower.as_str()) || GIVEN_NAMES_ROMAJI.contains(lower.as_str())
}

/// (d) 英字の人名(バイト範囲)。
fn english_names(text: &str) -> Vec<Range<usize>> {
    let mut found: Vec<Range<usize>> = [&*TITLED_NAME, &*GREETED_NAME, &*NAME_BEFORE_ADDRESS]
        .iter()
        .flat_map(|re| re.captures_iter(text).filter_map(|caps| caps.name("name").map(|m| m.range())))
        .collect();
    for caps in CAPITALIZED_RUN.captures_iter(text) {
        let Some(run) = caps.name("run") else {
            continue;
        };
        let mut offset = run.start();
        let words: Vec<Range<usize>> = run
            .as_str()
            .split(' ')
            .map(|word| {
                let range = offset..offset + word.len();
                offset += word.len() + 1;
                range
            })
            .skip_while(|range| is_title_word(&text[range.clone()]))
            .collect();
        if let Some(span) = english_name_span(text, &words) {
            found.push(span);
        }
    }
    found
}

/// 手がかり語なしの規則で使う辞書の語の長さの下限(2 字の語は手がかり語があるときだけ使う)。
const MIN_UNCUED_ROMAJI_LEN: usize = 3;

/// 手がかり語なしの規則で人名の手がかりにする語か(3 字以上で、ローマ字の姓・名の辞書にある)。
fn is_uncued_romaji_name(word: &str) -> bool {
    word.len() >= MIN_UNCUED_ROMAJI_LEN && is_romaji_name(word)
}

/// 大文字始まりの語の連なりのうち人名とする範囲。辞書の語(3 字以上)を含む 2〜3 語。
/// 4 語以上なら辞書の語の周りの 2〜3 語。
fn english_name_span(text: &str, words: &[Range<usize>]) -> Option<Range<usize>> {
    if words.len() < 2 {
        return None;
    }
    let first = words.iter().position(|w| is_uncued_romaji_name(&text[w.clone()]))?;
    let last = words.iter().rposition(|w| is_uncued_romaji_name(&text[w.clone()]))?;
    let (start, end) = if words.len() <= MAX_ENGLISH_WORDS {
        (0, words.len() - 1)
    } else if first == last {
        if first + 1 < words.len() { (first, first + 1) } else { (first - 1, first) }
    } else {
        (first, last.min(first + MAX_ENGLISH_WORDS - 1))
    };
    Some(words[start].start..words[end].end)
}

/// 同じ行の手がかり語の後の番号(バイト範囲)。
fn find_cued_numbers(text: &str) -> Vec<Range<usize>> {
    CUED.captures_iter(text)
        .filter_map(|caps| {
            let (sep, value) = (caps.name("sep")?, caps.name("value")?);
            // 英字の手がかり語は値との間に区切りが要る(`IDE`・`idx1` などを除く)。`#`・`.` で終わる手がかり語
            // (「Invoice #」「Order No.」)はそれ自体が区切り
            let en_needs_separator = caps.name("en").is_some_and(|en| !en.as_str().ends_with(['#', '.']));
            if en_needs_separator && sep.as_str().is_empty() {
                return None;
            }
            number_range(text, value.range())
        })
        .collect()
}

/// 値の末尾の `-`・`_` を除き、数字を含むときだけ範囲を返す。
fn number_range(text: &str, range: Range<usize>) -> Option<Range<usize>> {
    let trimmed = text[range.clone()].trim_end_matches(['-', '_']);
    let range = range.start..range.start + trimmed.len();
    trimmed.bytes().any(|b| b.is_ascii_digit()).then_some(range)
}

/// 観測全体が手がかり語のラベル(「会員番号」「ログイン ID」「顧客ID:」など。数字を含まない短い観測)か。
fn is_label_only(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= MAX_LABEL_CHARS
        && !trimmed.bytes().any(|b| b.is_ascii_digit())
        && LABEL.is_match(trimmed)
}

/// ラベルの値の観測の先頭の番号(バイト範囲)。
fn leading_value(text: &str) -> Option<Range<usize>> {
    let offset = text.len() - text.trim_start().len();
    let value = LEADING_VALUE.find(text.trim())?;
    number_range(text, offset + value.start()..offset + value.end())
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

    // 失敗時に文字列を表示しないよう、比較は UTF-16 範囲(数値)だけで行う。テストデータはすべて架空。

    fn cued(text: &str) -> Vec<Range<usize>> {
        ranges_in(detect, text, MatchDetail::LabeledNumber)
    }

    /// ページ全体に検出器を当て、手がかり語付きの番号の結果だけを返す。
    fn detect_page(page: &dyn RecognizedPage) -> Vec<Match> {
        let lines: Vec<Line> = (0..page.line_count()).map(|i| Line::new(i, page.line_text(i))).collect();
        detect(page, &lines).into_iter().filter(|m| m.detail == MatchDetail::LabeledNumber).collect()
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

    #[test]
    fn 手がかり語の後の番号を検出する() {
        let cases = [
            ("顧客番号: C-00918273", "C-00918273"),
            ("お客様番号 7730-1182", "7730-1182"),
            ("社員番号 E-204871", "E-204871"),
            ("社員ID K1093357", "K1093357"),
            ("顧客ID CU88301", "CU88301"),
            ("会員番号:M-55-01928", "M-55-01928"),
            ("User ID: u_48213", "u_48213"),
            ("userid=7731", "7731"),
            ("ID: A7731", "A7731"),
            ("社員番号E-204871", "E-204871"),
        ];
        for (line, expected) in cases {
            assert_eq!(cued(line), vec![span(line, expected)]);
        }
    }

    #[test]
    fn 全角の手がかり語と番号を検出する() {
        let line = "社員ＩＤ：Ｋ１０９３３５７";
        assert_eq!(cued(line), vec![span(line, "Ｋ１０９３３５７")]);
    }

    #[test]
    fn 番号は空白と日本語の手前で終わる() {
        let line = "社員番号 E-204871 佐藤 美緒 Mio Sato";
        assert_eq!(cued(line), vec![span(line, "E-204871")]);
        let line = "顧客番号 C-2210043(株)ミズハ計装";
        assert_eq!(cued(line), vec![span(line, "C-2210043")]);
    }

    #[test]
    fn 手がかり語付きの番号でないものは対象外() {
        let cases = [
            "ID: admin",         // 数字を含まない
            "社員番号を入力",    // 値が無い
            "Android 14",        // 語の一部
            "IDE 2024",          // 語の一部
            "valid: 123",        // 語の一部
            "ID",                // 手がかり語だけ
            "社員番号: 未登録",  // 英数字の値が無い
        ];
        for line in cases {
            assert!(cued(line).is_empty());
        }
    }

    #[test]
    fn 業務画面で一般的な番号の手がかり語を検出する() {
        // 対象 + 番号/No./ID/コード/# の組み合わせ(カテゴリ単位で足した語彙)
        let cases = [
            ("注文番号 PO-30018", "PO-30018"),
            ("受注番号: 77120", "77120"),
            ("発注No. HN-4410", "HN-4410"),
            ("契約番号 KY-20931", "KY-20931"),
            ("請求書番号 INV-2210", "INV-2210"),
            ("お問い合わせ番号 Q-1020-33", "Q-1020-33"),
            ("問合せNo 5512", "5512"),
            ("予約番号 R7710042", "R7710042"),
            ("会員No. AB-1029", "AB-1029"),
            ("登録番号 T1234567890123", "T1234567890123"),
            ("取引先コード TR-0042", "TR-0042"),
            ("患者ID P-88213", "P-88213"),
            ("職員番号 4471", "4471"),
            ("従業員 ID 99012", "99012"),
            ("受付番号 #20931", "20931"),
            ("顧客コード C7781", "C7781"),
        ];
        for (line, expected) in cases {
            assert_eq!(cued(line), vec![span(line, expected)], "case {}", expected.len());
        }
    }

    #[test]
    fn 英字の番号の手がかり語を検出する() {
        let cases = [
            ("Order No. 58821-A", "58821-A"),
            ("Invoice #INV-7731", "INV-7731"),
            ("Account Number: 00412", "00412"),
            ("Customer ID CU-1182", "CU-1182"),
            ("Member ID: M88213", "M88213"),
            ("Employee No 4410", "4410"),
            ("Ticket # 4821", "4821"),
            ("Case Number 0091-22", "0091-22"),
            ("contract_id=CT-2031", "CT-2031"),
        ];
        for (line, expected) in cases {
            assert_eq!(cued(line), vec![span(line, expected)], "case {}", expected.len());
        }
    }

    #[test]
    fn 手がかり語と番号の間の助詞を許す() {
        let cases = [
            ("会員番号は HX-71020 です。", "HX-71020"),
            ("注文番号が58201の件", "58201"),
            ("予約番号も R-2201 になります", "R-2201"),
            ("お客様番号は: 7730", "7730"),
        ];
        for (line, expected) in cases {
            assert_eq!(cued(line), vec![span(line, expected)], "case {}", expected.len());
        }
    }

    #[test]
    fn 一般化した手がかり語でも番号でないものは対象外() {
        let cases = [
            "注文番号は下記のとおりです", // 英数字の値が無い
            "Invoice question",           // 手がかり語の対象だけ(番号の語が無い)
            "Order history 2024",         // 番号の語が無い
            "問い合わせ番号を入力",       // 値が無い
            "Account settings",           // 番号の語が無い
            "Ticketing 2026",             // 語の一部
        ];
        for line in cases {
            assert!(cued(line).is_empty(), "case {}", line.len());
        }
    }

    /// 表の見出しの行(3 列)と、`header` の列の下に並ぶ値。
    fn header_table(headers: [&str; 3], values: &[&str]) -> GridPage {
        let mut cells: Vec<(&str, Cell)> = headers
            .iter()
            .enumerate()
            .map(|(i, h)| (*h, (0.1 + 0.3 * i as f64, 0.8, 0.12, 0.03)))
            .collect();
        for (row, value) in values.iter().enumerate() {
            // 見出し(中央寄せ)より左から始まり、見出しより幅が広い値
            cells.push((value, (0.37, 0.75 - 0.05 * row as f64, 0.2, 0.03)));
        }
        GridPage::new(&cells)
    }

    #[test]
    fn 表の見出しにだけ手がかり語がある列の値を番号とする() {
        let values = ["Xk29Lq7Pz04Rm1Tb8", "a81c0f22e9b4d7", "NK-0093"];
        let page = header_table(["連携先", "接続 ID", "備考"], &values);
        let expected: Vec<Match> = values
            .iter()
            .enumerate()
            .map(|(i, v)| Match::new(3 + i, 0..v.len(), MatchDetail::LabeledNumber))
            .collect();
        assert_eq!(detect_page(&page), expected);
    }

    #[test]
    fn 表の列の値は数字が読み取りで落ちても英字の大小が混ざれば番号とする() {
        // `0` が `O` と読まれて数字を含まなくなった ID(大文字・小文字の切り替わりが多い)
        let values = ["QOnmFpmkM-mZxKBCqb-G", "b8c0f9e2"];
        let page = header_table(["連携先", "接続 ID", "備考"], &values);
        assert_eq!(detect_page(&page).len(), 2);
        // 英字だけの普通の語は番号にしない
        let page = header_table(["連携先", "接続 ID", "備考"], &["admin", "b8c0f9e2"]);
        assert!(detect_page(&page).is_empty());
    }

    #[test]
    fn 表の見出しの列は番号でない値か離れた観測で終わる() {
        let page = header_table(["連携先", "契約番号", "備考"], &["CB-240117", "未契約", "CB-240118"]);
        assert_eq!(detect_page(&page), vec![Match::new(3, 0..9, MatchDetail::LabeledNumber)]);
        // 見出しの行でない(右隣に値がある)ラベルは従来どおり右隣を値とする
        let page = GridPage::new(&[("契約番号", LEFT_CELL), ("CB-240117", RIGHT_CELL)]);
        assert_eq!(detect_page(&page), vec![Match::new(1, 0..9, MatchDetail::LabeledNumber)]);
    }

    #[test]
    fn 手がかり語だけの観測の右隣の観測を値とする() {
        for (label, value) in [("会員番号", "M-55-01928"), ("ID", "A7731"), ("社員番号", "E-551902"), ("顧客ID:", "CU88301")]
        {
            let page = GridPage::new(&[(label, LEFT_CELL), (value, RIGHT_CELL)]);
            assert_eq!(detect_page(&page), vec![Match::new(1, 0..value.len(), MatchDetail::LabeledNumber)]);
        }
    }

    #[test]
    fn 画面の端まで離れた右隣は番号の値にしない() {
        let page = GridPage::new(&[("会員番号", (0.01, 0.5, 0.03, 0.013)), ("M-55-01928", (0.84, 0.5, 0.05, 0.013))]);
        assert!(detect_page(&page).is_empty());
    }

    #[test]
    fn 右隣が無ければ直下の行を値とする() {
        let page = FakePage::new(&["お客様番号", "  00-4418-2207  ", "次の行"]);
        assert_eq!(detect_page(&page), vec![Match::new(1, 2..14, MatchDetail::LabeledNumber)]);
    }

    #[test]
    fn 右隣の観測が自分で手がかり語の値を持つなら値の部分だけを返す() {
        let value = "User ID: u_48213";
        let page = GridPage::new(&[("ログイン ID", LEFT_CELL), (value, RIGHT_CELL)]);
        assert_eq!(detect_page(&page), vec![Match::new(1, span(value, "u_48213"), MatchDetail::LabeledNumber)]);
    }

    #[test]
    fn ラベルの値が番号の形でなければ対象外() {
        for value in ["未登録", "admin", "—"] {
            let page = GridPage::new(&[("社員番号", LEFT_CELL), (value, RIGHT_CELL)]);
            assert!(detect_page(&page).is_empty());
        }
        let page = FakePage::new(&["社員番号の付け方については人事部の案内を参照してください", "E-551902"]);
        assert!(detect_page(&page).is_empty());
    }

    // ---- ③人名(AM-T21)。人名はすべて架空(辞書に無い姓も使う) ----

    fn names(text: &str) -> Vec<Range<usize>> {
        ranges_in(detect, text, MatchDetail::PersonName)
    }

    /// ページ全体に検出器を当て、人名の結果だけを返す。
    fn detect_page_names(page: &dyn RecognizedPage) -> Vec<Match> {
        let lines: Vec<Line> = (0..page.line_count()).map(|i| Line::new(i, page.line_text(i))).collect();
        detect(page, &lines).into_iter().filter(|m| m.detail == MatchDetail::PersonName).collect()
    }

    #[test]
    fn 敬称の直前のかな漢字列を人名とする() {
        let cases = [
            ("汐見様", "汐見"),
            ("葛城 さん", "葛城"),
            ("鳴海 千景 様", "鳴海 千景"),
            ("霧ヶ峰氏によると", "霧ヶ峰"),
            ("汐見殿", "汐見"),
            ("お世話になっております。葛城さん", "葛城"),
            ("林様", "林"),
            ("ご担当 しおみ様", "しおみ"),
            ("宛先: アサギリ様", "アサギリ"),
        ];
        for (line, expected) in cases {
            assert_eq!(names(line), vec![span(line, expected)]);
        }
    }

    #[test]
    fn 敬称に見えても人名でないものは対象外() {
        for line in ["お客様番号", "仕様書を参照", "様々な画面", "皆さん", "同様に", "氏名", "殿下", "様"] {
            assert!(names(line).is_empty());
        }
    }

    #[test]
    fn ラベルの後の値を人名とする() {
        let cases = [
            ("氏名: 汐見 千景", "汐見 千景"),
            ("担当：葛城", "葛城"),
            ("担当者 鳴海", "鳴海"),
            ("宛名: アサギリ リオ", "アサギリ リオ"),
            ("差出人: Tobias Brandt <t.brandt@example.com>", "Tobias Brandt"),
            ("Name: Rin Kirishima", "Rin Kirishima"),
            ("お名前：汐見", "汐見"),
        ];
        for (line, expected) in cases {
            assert_eq!(names(line), vec![span(line, expected)]);
        }
    }

    #[test]
    fn ラベルに見えても値が無いものは対象外() {
        for line in ["名前を入力してください", "担当部署: 営業部", "氏名", "Name", "Filename: report"] {
            assert!(names(line).is_empty());
        }
    }

    #[test]
    fn ラベルだけの観測の右隣の観測を人名とする() {
        for (label, value) in [("担当者", "葛城 千景"), ("Name", "Rin Kirishima"), ("差出人:", "汐見")] {
            let page = GridPage::new(&[(label, LEFT_CELL), (value, RIGHT_CELL)]);
            assert_eq!(
                detect_page_names(&page),
                vec![Match::new(1, 0..value.encode_utf16().count(), MatchDetail::PersonName)]
            );
        }
    }

    #[test]
    fn 姓の辞書と続くかな漢字1から3字を人名とする() {
        let cases = [
            ("山田太郎", "山田太郎"),
            ("山田 太郎", "山田 太郎"),
            ("参加者 高橋汐里", "高橋汐里"),
            ("鈴木 ゆうひ 宛", "鈴木 ゆうひ"),
            ("山田花子様", "山田花子"),
        ];
        for (line, expected) in cases {
            assert_eq!(names(line), vec![span(line, expected)]);
        }
        let line = "高橋 一花、鈴木 二葉";
        assert_eq!(names(line), vec![span(line, "高橋 一花"), span(line, "鈴木 二葉")]);
    }

    #[test]
    fn 手がかり語なしでは姓だけ_一字の姓_辞書に無い姓を使わない() {
        // 姓だけ / 1 字の姓(東・林)+ かな漢字 / 辞書に無い姓
        for line in ["鈴木", "東京都の林道", "林 汐里", "汐見千景"] {
            assert!(names(line).is_empty());
        }
    }

    #[test]
    fn 辞書の語が文中の一部に現れると人名として拾う_既知の誤検出() {
        // 見逃し回避の方針のため除外しない。件数を把握するための代表例(姓「石川」+「県金沢」)
        let line = "石川県金沢市";
        assert_eq!(names(line), vec![span(line, "石川県金沢")]);
    }

    #[test]
    fn 二字のローマ字は手がかり語なしの英字の人名に使わない() {
        // 2 字の語(go・ai・yu など)だけが辞書に一致する大文字始まりの連なりは対象外(2026-10-09 の決定)
        for line in ["Go Back", "Ai Assistant", "Go To Settings", "Yu Ai"] {
            assert!(names(line).is_empty());
        }
        // 3 字以上の辞書の語が別にあれば、2 字の語も連なりの一部として含める
        let line = "Ai Sato";
        assert_eq!(names(line), vec![span(line, "Ai Sato")]);
        // 手がかり語(敬称・呼びかけ・ラベル)があれば 2 字の語も人名とする
        for (line, expected) in [("Mr. Go", "Go"), ("Dear Ai", "Ai"), ("Name: Yu Kirishima", "Yu Kirishima")] {
            assert_eq!(names(line), vec![span(line, expected)]);
        }
    }

    #[test]
    fn ローマ字の姓名の辞書を含む大文字始まりの2から3語を人名とする() {
        let cases = [
            ("Mio Sato", "Mio Sato"),
            ("Hanako Suzuki", "Hanako Suzuki"),
            ("SUZUKI HANAKO", "SUZUKI HANAKO"),
            ("Reviewed by Kenta Brandt.", "Kenta Brandt"),
            ("Weekly Sync With Mio Sato", "Mio Sato"),
            ("Kenta Tobias Brandt", "Kenta Tobias Brandt"),
        ];
        for (line, expected) in cases {
            assert_eq!(names(line), vec![span(line, expected)]);
        }
    }

    #[test]
    fn 英字の敬称と呼びかけの後を人名とする() {
        let cases = [
            ("Mr. Brandt", "Brandt"),
            ("Ms. Tobias Brandt", "Tobias Brandt"),
            ("Mrs Kirishima", "Kirishima"),
            ("Dear Rin,", "Rin"),
            ("Dear Mio Sato", "Mio Sato"),
        ];
        for (line, expected) in cases {
            assert_eq!(names(line), vec![span(line, expected)]);
        }
    }

    #[test]
    fn 辞書に無い英字の語や1語だけは対象外() {
        for line in ["Tobias Brandt", "Sato", "mio sato", "Meeting Room", "Dear customer", "Mr."] {
            assert!(names(line).is_empty());
        }
    }

    #[test]
    fn 人名と手がかり語付きの番号を同じ行で両方返す() {
        let line = "社員番号 E-204871 佐藤 美緒 Mio Sato";
        assert_eq!(cued(line), vec![span(line, "E-204871")]);
        assert_eq!(names(line), vec![span(line, "佐藤 美緒"), span(line, "Mio Sato")]);
    }

    // ---- ③人名の調整(AM-T23)。人名はすべて架空 ----

    #[test]
    fn 呼びかけと敬称が続いても後の名前を人名とする() {
        let cases = [
            ("Dear Mr. Tobias Brandt, the file is attached.", "Tobias Brandt"),
            ("Dear Ms. Rin", "Rin"),
            ("Dear Mrs Kirishima", "Kirishima"),
        ];
        for (line, expected) in cases {
            assert_eq!(names(line), vec![span(line, expected)]);
        }
    }

    #[test]
    fn 挨拶と読点の後の大文字始まりの語を人名とする() {
        let cases = [
            ("Welcome, Tobias Brandt", "Tobias Brandt"),
            ("welcome, Rin Kirishima", "Rin Kirishima"),
            ("weLcome, Tobias Brandt", "Tobias Brandt"),
            ("Hello, Tobias", "Tobias"),
        ];
        for (line, expected) in cases {
            assert_eq!(names(line), vec![span(line, expected)]);
        }
        // 読点が無い・小文字の語が続くものは対象外
        for line in ["Welcome Back", "Welcome to Settings", "Welcome, guest", "Hi there"] {
            assert!(names(line).is_empty());
        }
    }

    #[test]
    fn ログイン中のラベルの後の値を人名とする() {
        for (line, expected) in [("ログイン中: 汐見 千景", "汐見 千景"), ("ログイン中：汐見千景", "汐見千景")] {
            assert_eq!(names(line), vec![span(line, expected)]);
        }
        assert!(names("ログイン中").is_empty());
    }

    #[test]
    fn 英字の連絡先のラベルの後の名前を人名とする() {
        let line = "Contact: Tobias Brandt";
        assert_eq!(names(line), vec![span(line, "Tobias Brandt")]);
        // メールアドレス・ドメインの一部は名前にしない
        for line in ["Contact: support@example.com", "Contact: sales.team@example.com", "Contact: 03-0000-1111"] {
            assert!(names(line).is_empty());
        }
    }

    #[test]
    fn 山括弧のメールアドレスの直前の大文字始まりの語を人名とする() {
        let line = "a91c2e0 Tobias Brandt <t.brandt@example.org>";
        assert_eq!(names(line), vec![span(line, "Tobias Brandt")]);
        for line in ["0e84aa1 deploy-bot <bot@example.com>", "Tobias <t@example.org>"] {
            assert!(names(line).is_empty());
        }
    }

    #[test]
    fn 同じページのメールアドレスのローカル部と2語が対応する観測を人名とする() {
        for email in ["tobias.lindgren@example.net", "t.lindgren@example.org", "lindgren-tobias@example.jp"] {
            let page = FakePage::new(&["Tobias Lindgren", email]);
            assert_eq!(detect_page_names(&page), vec![Match::new(0, 0..15, MatchDetail::PersonName)]);
        }
        // 1 語だけの対応・観測の一部の連なりは対象外
        for (line, email) in [("Sales Report", "sales@example.com"), ("Tobias Lindgren joined", "tobias.lindgren@example.net")] {
            let page = FakePage::new(&[line, email]);
            assert!(detect_page_names(&page).iter().all(|m| m.line != 0));
        }
    }

    #[test]
    fn 読み仮名の括弧が続くかな漢字列を人名とする() {
        let cases = [
            ("汐見 千景(しおみ ちかげ)", "汐見 千景"),
            ("汐見千景(しおみ ちかげ)", "汐見千景"),
            ("汐見 千景(しおみちかげ)", "汐見 千景"),
            ("葛城千景(カツラギ チカゲ)", "葛城千景"),
        ];
        for (line, expected) in cases {
            assert_eq!(names(line), vec![span(line, expected)]);
        }
        // 名前にも読みにも空白が無いもの(語の読み)は対象外
        for line in ["注意(ちゅうい)", "汐見千景(しおみちかげ)"] {
            assert!(names(line).is_empty());
        }
    }

    #[test]
    fn 人名とわかった文字列の同じページの別の出現も人名とする() {
        let page = FakePage::new(&["汐見千景", "汐見 千景(しおみ ちかげ)", "宛先 汐見千景 ほか"]);
        assert_eq!(
            detect_page_names(&page),
            vec![
                Match::new(0, 0..4, MatchDetail::PersonName),
                Match::new(1, 0..5, MatchDetail::PersonName),
                Match::new(2, 3..7, MatchDetail::PersonName),
            ]
        );
        let page = FakePage::new(&["Tobias Brandt", "Dear Mr. Tobias Brandt,"]);
        let found = detect_page_names(&page);
        assert!(found.contains(&Match::new(0, 0..13, MatchDetail::PersonName)));
        // 3 字未満の名前は広げない
        let page = FakePage::new(&["汐見", "汐見様"]);
        assert_eq!(detect_page_names(&page), vec![Match::new(1, 0..2, MatchDetail::PersonName)]);
    }

    /// 表の見出しの行(4 列)と、2 列目の見出しの下に並ぶ値。正規化座標・左下原点。
    fn table_page(cells_below: &[&str]) -> GridPage {
        let mut cells: Vec<(&str, Cell)> = vec![
            ("社員番号", (0.10, 0.80, 0.06, 0.02)),
            ("氏名", (0.30, 0.80, 0.03, 0.02)),
            ("英字表記", (0.45, 0.80, 0.06, 0.02)),
            ("メール", (0.60, 0.80, 0.04, 0.02)),
        ];
        for (k, text) in cells_below.iter().enumerate() {
            cells.push((text, (0.297, 0.80 - 0.03 * (k as f64 + 1.0), 0.05, 0.022)));
        }
        GridPage::new(&cells)
    }

    #[test]
    fn 表の人名の見出しの下に並ぶ値を人名とする() {
        let page = table_page(&["汐見千景", "葛城 千景", "Tobias Brandt"]);
        let found = detect_page_names(&page);
        for (line, len) in [(4, 4), (5, 5), (6, 13)] {
            assert!(found.contains(&Match::new(line, 0..len, MatchDetail::PersonName)));
        }
        // 見出しの右隣(別の列の見出し)は値にしない
        assert!(found.iter().all(|m| m.line != 2));
    }

    #[test]
    fn 表の列は人名の形でない値か離れた観測で終わる() {
        // 番号を含む値で止まり、その下の名前の形の観測も拾わない
        let page = table_page(&["汐見千景", "E-204871", "アサギリ リオ"]);
        let lines: Vec<usize> = detect_page_names(&page).iter().map(|m| m.line).collect();
        assert_eq!(lines, vec![4]);
        // 行の間が大きく空いた観測(表の外)は拾わない
        let mut cells: Vec<(&str, Cell)> = vec![
            ("社員番号", (0.10, 0.80, 0.06, 0.02)),
            ("氏名", (0.30, 0.80, 0.03, 0.02)),
            ("メール", (0.60, 0.80, 0.04, 0.02)),
            ("汐見千景", (0.297, 0.77, 0.05, 0.022)),
        ];
        cells.push(("請求先情報", (0.297, 0.60, 0.05, 0.022)));
        let lines: Vec<usize> = detect_page_names(&GridPage::new(&cells)).iter().map(|m| m.line).collect();
        assert_eq!(lines, vec![3]);
    }

    #[test]
    fn フォームのラベルの下の別のラベルは人名にしない() {
        // ラベルと値の 2 列だけの行は表の見出しとみなさない
        let page = GridPage::new(&[
            ("氏名", (0.10, 0.80, 0.03, 0.02)),
            ("葛城 千景", (0.30, 0.80, 0.08, 0.02)),
            ("住所", (0.10, 0.77, 0.03, 0.02)),
            ("所在地未登録", (0.30, 0.77, 0.10, 0.02)),
        ]);
        assert_eq!(detect_page_names(&page), vec![Match::new(1, 0..5, MatchDetail::PersonName)]);
        // 隣のカードと同じ高さで 3 つ以上並んでも、見出しでない観測(空白・数字を含む値)があれば表とみなさない
        let page = GridPage::new(&[
            ("氏名", (0.10, 0.80, 0.03, 0.02)),
            ("葛城 千景", (0.30, 0.80, 0.08, 0.02)),
            ("会員番号", (0.60, 0.80, 0.06, 0.02)),
            ("M-55-01928", (0.70, 0.80, 0.08, 0.02)),
            ("住所", (0.10, 0.77, 0.03, 0.02)),
        ]);
        assert!(detect_page_names(&page).iter().all(|m| m.line != 4));
    }

    #[test]
    fn 名前の見出しの列は人名にしない() {
        // 「名前」「Name」は人以外(キー・ファイルなど)の名前の列にも使われるため、列の規則に使わない
        let page = GridPage::new(&[
            ("名前", (0.30, 0.80, 0.03, 0.02)),
            ("キー", (0.45, 0.80, 0.03, 0.02)),
            ("作成日", (0.60, 0.80, 0.04, 0.02)),
            ("本番決済", (0.297, 0.77, 0.05, 0.022)),
        ]);
        assert!(detect_page_names(&page).iter().all(|m| m.line != 3));
    }

    // ---- ③会社名(AM-T22)。会社名はすべて架空 ----

    fn companies(text: &str) -> Vec<Range<usize>> {
        ranges_in(detect, text, MatchDetail::CompanyName)
    }

    /// ページ全体に検出器を当て、会社名の結果だけを返す。
    fn detect_page_companies(page: &dyn RecognizedPage) -> Vec<Match> {
        let lines: Vec<Line> = (0..page.line_count()).map(|i| Line::new(i, page.line_text(i))).collect();
        detect(page, &lines).into_iter().filter(|m| m.detail == MatchDetail::CompanyName).collect()
    }

    #[test]
    fn 会社の種類の後に続く名前を会社名とする() {
        let cases = [
            ("株式会社ユズリハ物産 御中", "株式会社ユズリハ物産"),
            ("(株)ミズハ計装", "(株)ミズハ計装"),
            ("（株）ミズハ計装", "（株）ミズハ計装"),
            ("㈱あけぼの架設", "㈱あけぼの架設"),
            ("有限会社ほしまち製作所", "有限会社ほしまち製作所"),
            ("組織: 合同会社クレセントノード", "合同会社クレセントノード"),
            ("送付先: 鈴木 陽向 様(株式会社カザミドリ設計)", "株式会社カザミドリ設計"),
            ("株式会社 トキワグラフ", "株式会社 トキワグラフ"),
        ];
        for (line, expected) in cases {
            assert_eq!(companies(line), vec![span(line, expected)]);
        }
    }

    #[test]
    fn 会社の種類の前に続く名前を会社名とする() {
        let cases = [
            ("ヒバリ測量株式会社", "ヒバリ測量株式会社"),
            ("請求元 ソラノワ技研合同会社", "ソラノワ技研合同会社"),
            ("弊社はコハク工房有限会社です", "コハク工房有限会社"),
            ("ミズハ計装(株) 営業部", "ミズハ計装(株)"),
            ("ルリカケ商会㈱", "ルリカケ商会㈱"),
        ];
        for (line, expected) in cases {
            assert_eq!(companies(line), vec![span(line, expected)]);
        }
    }

    #[test]
    fn 番号の直後の会社の種類は後ろの名前を会社名とする() {
        let line = "顧客番号 C-2210043(株)ミズハ計装";
        assert_eq!(companies(line), vec![span(line, "(株)ミズハ計装")]);
        assert_eq!(cued(line), vec![span(line, "C-2210043")]);
    }

    #[test]
    fn 英字の会社の種類の前の大文字始まりの語を会社名とする() {
        let cases = [
            ("Hollowpine Co., Ltd.", "Hollowpine Co., Ltd."),
            ("Hollowpine Co.,Ltd.", "Hollowpine Co.,Ltd."),
            ("tenant=Kirinoha Systems Inc. plan=team", "Kirinoha Systems Inc."),
            ("Billed to Mistral Peak Ltd", "Mistral Peak Ltd"),
            ("Ferncastle Labs, Inc.", "Ferncastle Labs, Inc."),
            // 末尾の `.` が `,` と読まれた形
            ("tenant=Kirinoha Systems Inc, plan=team", "Kirinoha Systems Inc,"),
        ];
        for (line, expected) in cases {
            assert_eq!(companies(line), vec![span(line, expected)]);
        }
    }

    #[test]
    fn 会社のラベルの後の値を会社名とする() {
        let cases = [
            ("会社名: ソラノワ技研", "ソラノワ技研"),
            ("勤務先 トキワグラフ", "トキワグラフ"),
            ("Company: Kirinoha Systems", "Kirinoha Systems"),
        ];
        for (line, expected) in cases {
            assert_eq!(companies(line), vec![span(line, expected)]);
        }
        for (label, value) in [("会社名", "コハク工房"), ("勤務先:", "ヒバリ測量"), ("Company", "Kirinoha Systems")] {
            let page = GridPage::new(&[(label, LEFT_CELL), (value, RIGHT_CELL)]);
            assert_eq!(
                detect_page_companies(&page),
                vec![Match::new(1, 0..value.encode_utf16().count(), MatchDetail::CompanyName)]
            );
        }
    }

    #[test]
    fn 丸囲みの株が株と読まれた形を前置の会社の種類とする() {
        // 読み取りで「㈱」が「株」1 字になる(評価画像で確認)。行頭・空白の後で、かなが続くときだけ
        for (line, expected) in [
            ("株あけぼの架設", "株あけぼの架設"),
            ("CU88301 株ミズハ計装", "株ミズハ計装"),
            ("株）あけぼの架設", "株）あけぼの架設"),
            ("(株あけぼの架設", "(株あけぼの架設"),
        ] {
            assert_eq!(companies(line), vec![span(line, expected)]);
        }
        for line in ["株価の推移", "株主総会", "株を買う", "優待株アサギリ"] {
            assert!(companies(line).is_empty());
        }
    }

    #[test]
    fn 法人の種類の前後に続く名前を会社名とする() {
        let cases = [
            ("一般社団法人こもれび地域連携会", "一般社団法人こもれび地域連携会"),
            ("一般財団法人ミナト文化振興会", "一般財団法人ミナト文化振興会"),
            ("公益社団法人アオバ学習支援協会", "公益社団法人アオバ学習支援協会"),
            ("公益財団法人しずく記念基金", "公益財団法人しずく記念基金"),
            ("医療法人社団ひまわり会", "医療法人社団ひまわり会"),
            ("社会福祉法人やまゆり福祉会", "社会福祉法人やまゆり福祉会"),
            ("学校法人キタカゼ学園", "学校法人キタカゼ学園"),
            ("NPO法人ほたる自然塾", "NPO法人ほたる自然塾"),
            ("特定非営利活動法人つばめ子ども食堂", "特定非営利活動法人つばめ子ども食堂"),
            ("独立行政法人ハヤテ研究機構", "独立行政法人ハヤテ研究機構"),
            ("アサツキ会計税理士法人", "アサツキ会計税理士法人"),
            ("(一社)こもれび地域連携会", "(一社)こもれび地域連携会"),
            ("(公財)しずく記念基金", "(公財)しずく記念基金"),
        ];
        for (line, expected) in cases {
            let found = companies(line);
            assert!(found.contains(&span(line, expected)), "case {}", expected.len());
        }
    }

    #[test]
    fn ひらがなで始まる後置の社名は語の区切りからを会社名とする() {
        let cases = [
            ("やまびこ醸造合資会社", "やまびこ醸造合資会社"),
            ("見積先: ささなみ建設工業株式会社", "ささなみ建設工業株式会社"),
            ("取引先 みどり商会(株)", "みどり商会(株)"),
        ];
        for (line, expected) in cases {
            assert_eq!(companies(line), vec![span(line, expected)], "case {}", expected.len());
        }
        // 文中で漢字の後に続くひらがなは助詞を含みうるので含めない(従来どおり)
        let line = "弊社はコハク工房有限会社です";
        assert_eq!(companies(line), vec![span(line, "コハク工房有限会社")]);
    }

    #[test]
    fn 前置の会社の種類の後の英字の名前を複数語まで会社名とする() {
        let cases = [
            ("株式会社 Kirinoha Systems", "株式会社 Kirinoha Systems"),
            ("株式会社Hollow Pine Labs 御中", "株式会社Hollow Pine Labs"),
        ];
        for (line, expected) in cases {
            assert_eq!(companies(line), vec![span(line, expected)], "case {}", expected.len());
        }
    }

    #[test]
    fn 海外の会社の種類の前の大文字始まりの語を会社名とする() {
        let cases = [
            ("Lindenhof Maschinenbau GmbH", "Lindenhof Maschinenbau GmbH"),
            ("Sol Poniente S.A.", "Sol Poniente S.A."),
            ("Vlietwater Logistics B.V.", "Vlietwater Logistics B.V."),
            ("Merlion Harbour Pte. Ltd.", "Merlion Harbour Pte. Ltd."),
            ("Thornbury Holdings PLC", "Thornbury Holdings PLC"),
            ("Ashgrove Partners LLP", "Ashgrove Partners LLP"),
            ("Kestrel Dynamics Corporation", "Kestrel Dynamics Corporation"),
            ("Bramblewood Limited", "Bramblewood Limited"),
            ("Nordlys Energi AG", "Nordlys Energi AG"),
        ];
        for (line, expected) in cases {
            assert_eq!(companies(line), vec![span(line, expected)], "case {}", expected.len());
        }
        for line in ["GmbH", "Pte. Ltd.", "SOLD AS IS", "We are a PLC", "AG"] {
            assert!(companies(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 会社のラベルの右隣がラベルなら値にしない() {
        // 表の見出しの行(「会社名」の右隣が「担当者」)
        let page = GridPage::new(&[("会社名", LEFT_CELL), ("担当者", RIGHT_CELL)]);
        assert!(detect_page_companies(&page).is_empty());
    }

    #[test]
    fn 会社名でないものは対象外() {
        let cases = [
            "株式会社",                 // 種類だけ
            "株式会社の設立手続き",     // 種類の後が助詞
            "会社名を入力してください", // ラベルの後に区切りが無い
            "Company",                  // ラベルだけ
            "Inc.",                     // 種類だけ
            "since 2019 inc. and ltd.", // 大文字始まりの語が無い
            "Incoming Call",            // 語の一部
        ];
        for line in cases {
            assert!(companies(line).is_empty());
        }
    }
}
