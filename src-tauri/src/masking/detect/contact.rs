//! ①連絡先: メール・電話番号・住所(FR-003・FR-007)。メール・電話番号・郵便番号は AM-T11、都道府県で始まる住所は AM-T22 で実装する。
//!
//! 正規化(全角→半角)後の文字列に規則を当てる。正規表現は線形時間の `regex` クレートだけを使い、
//! 電話番号は数字の組を左から読む手書きの走査(1 つの開始位置につき読む長さに上限がある)で判定する。
//!
//! 住所(ARCH_auto-masking §5.3)。複数行の住所は行(観測)ごとに判定する。
//!
//! - 郵便番号: 「〒」+ 7 桁、または記号なしの `NNN-NNNN`
//! - 都道府県名(辞書)+ かな漢字で始まる部分から行の終わりまで
//! - 郵便番号だけの観測(「郵便番号」のラベル付きを含む)の後に続く観測(同じ行の近い右隣、無ければ直下の行)。
//!   かな漢字を含むものだけ。都道府県で始まる行の次の行(建物名など)は手がかりが無いので拾わない
//! - 英語の住所(2026-10-09 の一般化): 番地 + 大文字始まりの 1〜4 語 + 通りの種類(`STREET_SUFFIXES`)と、
//!   続く `,` 区切りの部分(大文字・数字・`#` で始まる 1〜4 語。Suite・市・州・郵便番号)を 4 つまで。
//!   番地の前の部屋・区画(「Unit 12,」「Apt 3B」)も含める。
//!   「市, 州の略称 5 桁の郵便番号」だけの行(住所の 2 行目)と、英国式の郵便番号(`AB1 2CD`)の行
//!   (前の大文字始まりの町名 0〜3 語と、後の `,` + 国名を含む)も住所とする
//! - ローマ字の日本の住所: `N-N(-N)` の番地 + 大文字始まりの町名 + `,` 区切りの部分で、市区町村の接尾辞
//!   (`-shi`・`-ku` など)・`Japan`・`NNN-NNNN` のどれかを含むもの
//! - 丁目・番地・号と大字・字: 町名(漢字・カタカナ。前の市区町村名を含む)+ 「N丁目」(+ 番・号)・「N番地」・
//!   「N番N号」、または「大字」「字」+ 町名 + 番地
//! - 住所の行の続き(2026-10-09 の書式の拡張): 住所が行の終わりまで続く行の直下の行が、郵便番号(+ 国名)だけの行か、
//!   語の途中で折り返した行(行頭が長音・小書きの仮名)なら、その行も住所とする
//!
//! 電話番号(2026-10-09 の一般化)。日本の番号に加え、`+` と国番号で始まる海外の番号(E.164: 国番号を含めて
//! 8〜15 桁)と、北米の国内表記(`(NXX) NXX-XXXX`・`NXX-NXX-XXXX`。N は 2〜9)を拾う。`+81` は日本の桁数で判定する。
//! 書式の拡張: 組の区切りに `.` を許し、括弧の市外局番の後の局番は 0・1 で始まってもよい。読み取りで国番号と
//! 次の組がつながった形(組が 3 つ以上のとき最初の組を 6 桁まで)を許す。後に続く内線(`ext.`・`x`・「内線」)を含める

use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use super::super::layout::{next_line_below, right_neighbor};
use super::super::{Match, MatchDetail, RecognizedPage};
use super::lexicon::{
    ELEVEN_DIGIT_PHONE_PREFIXES, JP_COUNTRY_CODE, JP_MUNICIPALITY_SUFFIXES, JP_ROMAJI_ADMIN_SUFFIXES, PHONE_EXTENSION_CUES,
    POSTAL_LABELS, POSTAL_MARK, PREFECTURES, STREET_SUFFIXES, UNIT_DESIGNATORS, US_STATE_CODES,
};
use super::{is_kana_kanji, is_kanji, Line};

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
    Regex::new(&format!(r"{POSTAL_MARK}\x20?{POSTAL_DIGITS}|[0-9]{{3}}-[0-9]{{4}}")).expect("固定の正規表現が不正")
});

/// 郵便番号の数字の形(郵便記号を除く)。
const POSTAL_DIGITS: &str = r"[0-9]{3}(?:\x20?-\x20?)?[0-9]{4}";

/// 郵便番号だけの観測(ラベル・郵便記号は任意)。前後の空白を除いた文字列に当てる。
static POSTAL_ONLY: LazyLock<Regex> = LazyLock::new(|| {
    let labels = POSTAL_LABELS.iter().map(|label| regex::escape(label)).collect::<Vec<_>>().join("|");
    Regex::new(&format!(r"^(?:(?:{labels})\x20*:?\x20*)?(?:{POSTAL_MARK}\x20?{POSTAL_DIGITS}|[0-9]{{3}}-[0-9]{{4}})$"))
        .expect("固定の正規表現が不正")
});

/// ①連絡先の検出器。行ごとの規則に加え、郵便番号だけの観測から右隣・直下の観測を住所として探す。
pub(super) fn detect(page: &dyn RecognizedPage, lines: &[Line]) -> Vec<Match> {
    let mut matches = Vec::new();
    for line in lines {
        let text = line.as_str();
        let found = find_emails(text)
            .map(|r| (r, MatchDetail::Email))
            .chain(find_phones(text).into_iter().map(|r| (r, MatchDetail::Phone)))
            .chain(find_postal_codes(text).map(|r| (r, MatchDetail::Address)))
            .chain(prefecture_address(text).map(|r| (r, MatchDetail::Address)))
            .chain(english_addresses(text).into_iter().map(|r| (r, MatchDetail::Address)))
            .chain(block_addresses(text).into_iter().map(|r| (r, MatchDetail::Address)));
        matches.extend(found.filter_map(|(range, detail)| line.to_match(range, detail)));
    }

    // 住所が行の終わりまで続く行の直下の続きの行(郵便番号だけの行・語の途中で折り返した行)
    for line in lines {
        let Some(english) = address_reaching_end(line) else {
            continue;
        };
        let Some(next) = next_line_below(page, line.index).filter(|&i| is_close_below(page, line.index, i)) else {
            continue;
        };
        let Some(value) = lines.iter().find(|l| l.index == next) else {
            continue;
        };
        let range = trimmed(value.as_str());
        let tail = &value.as_str()[range.clone()];
        let continues = if english { ADDRESS_TAIL_ASCII.is_match(tail) } else { is_wrapped_japanese(tail) };
        if continues {
            if let Some(found) = value.to_match(range, MatchDetail::Address) {
                if !matches.contains(&found) {
                    matches.push(found);
                }
            }
        }
    }

    for line in lines.iter().filter(|line| is_postal_only(line.as_str())) {
        let near_right = right_neighbor(page, line.index).filter(|&i| is_near_right(page, line.index, i));
        let Some(neighbor) = near_right.or_else(|| next_line_below(page, line.index)) else {
            continue;
        };
        let Some(value) = lines.iter().find(|l| l.index == neighbor) else {
            continue;
        };
        if let Some(found) = address_after_postal(value.as_str()).and_then(|r| value.to_match(r, MatchDetail::Address)) {
            if !matches.contains(&found) {
                matches.push(found);
            }
        }
    }
    matches
}

/// 住所が行の終わり(末尾の空白を除く)まで続くなら、その住所が英字の住所か(`Some(true)`)日本語の住所か。
fn address_reaching_end(line: &Line) -> Option<bool> {
    let text = line.as_str();
    let end = text.trim_end().len();
    let ranges: Vec<Range<usize>> = prefecture_address(text)
        .into_iter()
        .chain(english_addresses(text))
        .chain(block_addresses(text))
        .collect();
    let reaching = ranges.into_iter().find(|r| r.end == end && r.start < r.end)?;
    Some(!text[reaching].chars().any(is_kana_kanji))
}

/// 続きの行とみなす縦の間隔の上限(住所の行の高さに対する倍率)。
const MAX_CONTINUATION_GAP_RATIO: f64 = 1.0;

/// `below` が `line` のすぐ下(縦の間隔が `line` の高さ以内)にあるか(正規化座標・左下原点)。
fn is_close_below(page: &dyn RecognizedPage, line: usize, below: usize) -> bool {
    let (upper, lower) = (page.line_box(line), page.line_box(below));
    upper.y - (lower.y + lower.height) <= upper.height * MAX_CONTINUATION_GAP_RATIO
}

/// 英字の住所の続きの行: 郵便番号(数字 3〜5 桁 + 任意の `-` と 3〜4 桁、または英国式)と、任意の `,` + 国名。
static ADDRESS_TAIL_ASCII: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(?:[0-9]{{3,5}}(?:-[0-9]{{3,4}})?|{UK_POSTCODE})(?:[,.]?\x20?[A-Z][A-Za-z]+(?:\x20[A-Z][A-Za-z]+){{0,2}})?$"
    ))
    .expect("固定の正規表現が不正")
});

/// 行頭に来ない(語の途中で折り返したときだけ行頭に来る)文字。正規化後の長音(`-`)と小書きの仮名。
const WRAPPED_LINE_STARTS: &str = "-ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ";

/// 日本語の住所の語の途中で折り返した続きの行か(行頭が `WRAPPED_LINE_STARTS` で、かな漢字を含む)。
fn is_wrapped_japanese(text: &str) -> bool {
    text.chars().next().is_some_and(|c| WRAPPED_LINE_STARTS.contains(c)) && text.chars().any(is_kana_kanji)
}

/// 前後の空白を除いた部分のバイト範囲。
fn trimmed(text: &str) -> Range<usize> {
    let start = text.len() - text.trim_start().len();
    start..text.trim_end().len().max(start)
}

/// 郵便番号だけの観測と右隣の観測の間隔の上限(郵便番号の観測の高さに対する倍率)。
/// これより離れた右隣は別の枠・列の観測とみなす。
const MAX_POSTAL_GAP_RATIO: f64 = 2.0;

/// `neighbor` の左端が `line` の右端から `line` の高さ × `MAX_POSTAL_GAP_RATIO` 以内にあるか(正規化座標)。
fn is_near_right(page: &dyn RecognizedPage, line: usize, neighbor: usize) -> bool {
    let (label, value) = (page.line_box(line), page.line_box(neighbor));
    value.x - (label.x + label.width) <= label.height * MAX_POSTAL_GAP_RATIO
}

fn is_postal_only(text: &str) -> bool {
    POSTAL_ONLY.is_match(text.trim())
}

/// 都道府県名の長さ(文字数)の候補。長いもの(「神奈川県」など)を先に試す。
const PREFECTURE_CHAR_LENS: [usize; 2] = [4, 3];

/// `text` が都道府県名で始まるなら、その長さ(バイト)。
fn prefecture_len(text: &str) -> Option<usize> {
    PREFECTURE_CHAR_LENS.iter().find_map(|&n| {
        let end = text.char_indices().nth(n).map_or(text.len(), |(i, _)| i);
        (text[..end].chars().count() == n && PREFECTURES.contains(&text[..end])).then_some(end)
    })
}

/// 都道府県名 + かな漢字で始まる部分から行の終わり(末尾の空白を除く)まで(バイト範囲)。行の最初の 1 件だけ。
fn prefecture_address(text: &str) -> Option<Range<usize>> {
    let end = text.trim_end_matches(' ').len();
    text.char_indices().find_map(|(pos, _)| {
        let len = prefecture_len(&text[pos..])?;
        text[pos + len..].chars().next().is_some_and(is_kana_kanji).then_some(pos..end)
    })
}

/// 郵便番号だけの観測の後に続く観測の住所(前後の空白を除いた範囲)。かな漢字を含み、
/// 郵便番号だけでも都道府県で始まる住所を含むものでもない(それぞれ行ごとの規則で拾う)とき。
fn address_after_postal(text: &str) -> Option<Range<usize>> {
    let start = text.len() - text.trim_start().len();
    let end = text.trim_end().len();
    let value = text.get(start..end)?;
    let is_address = value.chars().any(is_kana_kanji) && !is_postal_only(value) && prefecture_address(value).is_none();
    is_address.then_some(start..end)
}

/// 英語の住所の `,` 区切りの部分(大文字・数字・`#` 始まりの 1〜4 語)。
const ADDRESS_SEGMENT: &str = r"[A-Z0-9#][A-Za-z0-9#.'\-]*(?:\x20[A-Z0-9#][A-Za-z0-9#.'\-]*){0,3}";

/// 英国式の郵便番号(外側 `A9`・`A99`・`AA9`・`AA99`・`A9A`・`AA9A` + 空白 + 内側 `9AA`)。
const UK_POSTCODE: &str = r"[A-Z]{1,2}[0-9][A-Z0-9]?\x20[0-9][A-Z]{2}";

/// 英語の住所の番地から始まる部分(`addr`)。番地は 1〜6 桁(末尾の英字 1 つを許す)、通りの名前は大文字始まりの語か
/// 序数(`5th`)。通りの種類の後に `,` 区切りの部分を 4 つまで続ける。番地の前の部屋・区画
/// (`UNIT_DESIGNATORS` + 1〜6 文字の番号 + 任意の `,`)も含める。
static STREET_ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    let mut suffixes: Vec<&str> = STREET_SUFFIXES.to_vec();
    suffixes.sort_by_key(|s| std::cmp::Reverse(s.len()));
    Regex::new(&format!(
        r"(?:^|[^A-Za-z0-9])(?P<addr>(?:(?:{units})\x20[A-Za-z0-9\-]{{1,6}},?\x20)?[0-9]{{1,6}}[A-Za-z]?\x20(?:(?:[A-Z][A-Za-z'\-]*|[0-9]+(?:st|nd|rd|th))\x20){{1,4}}(?:{suffixes})\b\.?(?:,\x20?{ADDRESS_SEGMENT}){{0,4}})",
        units = UNIT_DESIGNATORS.join("|"),
        suffixes = suffixes.join("|")
    ))
    .expect("固定の正規表現が不正")
});

/// 英国式の郵便番号の行(前の大文字始まりの町名 0〜3 語と、後の `,` + 国名 1〜3 語を含む)。前後は英数字でないこと。
static UK_POSTCODE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:^|[^A-Za-z0-9])(?P<addr>(?:[A-Z][a-z][A-Za-z'\-]*\x20){{0,3}}{UK_POSTCODE}(?:,\x20?[A-Z][A-Za-z]*(?:\x20[A-Z][A-Za-z]*){{0,2}})?)(?:$|[^A-Za-z0-9])"
    ))
    .expect("固定の正規表現が不正")
});

/// ローマ字の日本の住所(`N-N(-N)` の番地 + 大文字始まりの町名 + `,` 区切りの部分 1〜4 つ)。前は英数字・`-` でないこと。
/// 日本の住所の手がかり(`JP_ROMAJI_HINT`)を含むものだけを住所とする。
static ROMAJI_JP_ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:^|[^A-Za-z0-9\-])(?P<addr>[0-9]{{1,4}}-[0-9]{{1,4}}(?:-[0-9]{{1,4}})?\x20[A-Z][a-z]+(?:-[a-z]+)?(?:,\x20?{ADDRESS_SEGMENT}){{1,4}})"
    ))
    .expect("固定の正規表現が不正")
});

/// ローマ字の日本の住所の手がかり: 市区町村の接尾辞(`-shi` など)・`Japan`・日本の郵便番号(`NNN-NNNN`)。
static JP_ROMAJI_HINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"-(?:{})\b|\bJapan\b|\b[0-9]{{3}}-[0-9]{{4}}\b", JP_ROMAJI_ADMIN_SUFFIXES.join("|")))
        .expect("固定の正規表現が不正")
});

/// 英語の住所の 2 行目(「市, 州の略称 5 桁の郵便番号」。市は大文字始まりの 1〜3 語)。
static CITY_STATE_ZIP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:^|[^A-Za-z0-9])(?P<addr>[A-Z][A-Za-z.'\-]*(?:\x20[A-Z][A-Za-z.'\-]*){{0,2}},\x20?(?:{})\x20[0-9]{{5}}(?:-[0-9]{{4}})?)(?:$|[^A-Za-z0-9])",
        US_STATE_CODES.join("|")
    ))
    .expect("固定の正規表現が不正")
});

/// 英語の住所(バイト範囲)。番地から始まる住所に重なる 2 行目・英国式の郵便番号・ローマ字の日本の住所の形は重ねて返さない。
fn english_addresses(text: &str) -> Vec<Range<usize>> {
    let mut found: Vec<Range<usize>> =
        STREET_ADDRESS.captures_iter(text).filter_map(|caps| caps.name("addr").map(|m| m.range())).collect();
    let romaji = ROMAJI_JP_ADDRESS
        .captures_iter(text)
        .filter_map(|caps| caps.name("addr"))
        .filter(|m| JP_ROMAJI_HINT.is_match(m.as_str()))
        .map(|m| m.range());
    for regex_found in [
        romaji.collect::<Vec<_>>(),
        CITY_STATE_ZIP.captures_iter(text).filter_map(|caps| caps.name("addr").map(|m| m.range())).collect(),
        UK_POSTCODE_LINE.captures_iter(text).filter_map(|caps| caps.name("addr").map(|m| m.range())).collect(),
    ] {
        for r in regex_found {
            if !found.iter().any(|s| r.start < s.end && s.start < r.end) {
                found.push(r);
            }
        }
    }
    found.sort_by_key(|r| r.start);
    found
}

/// 数字の「丁目」の前の数(算用数字 1〜3 桁、または漢数字 1〜3 字)。
const CHOME_NUMBER: &str = "(?:[0-9]{1,3}|[一二三四五六七八九十]{1,3})";

/// 町名の前の市区町村名(かな漢字 1〜10 字 + 市・区・町・村・郡)。
fn municipality_pattern() -> String {
    let suffixes: String = JP_MUNICIPALITY_SUFFIXES.iter().collect();
    format!(r"(?:[\p{{Han}}\p{{Hiragana}}\p{{Katakana}}]{{1,10}}?[{suffixes}])?")
}

/// 丁目・番地・号の住所(`addr`)。市区町村名(任意)+ 町名(漢字・カタカナ 1〜10 字)+ 「N丁目」(+ 番地・号)、
/// 「N番地(の N)」、「N番N号」。
static BLOCK_ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?P<addr>{city}[\p{{Han}}\p{{Katakana}}]{{1,10}}(?:{CHOME_NUMBER}丁目(?:[0-9]{{1,4}}(?:番地?|-)[0-9]{{1,4}}号?|[0-9]{{1,4}}番地?)?|[0-9]{{1,5}}番地(?:の?[0-9]{{1,4}})?|[0-9]{{1,4}}番[0-9]{{1,4}}号))",
        city = municipality_pattern(),
    ))
    .expect("固定の正規表現が不正")
});

/// 大字・字の住所(`addr`)。市区町村名(任意)+ 「大字」「字」+ 町名 + 番地(`N`・`N番地`・`N-N(-N)`)。
static OAZA_ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?P<addr>{city}(?:大字|字)[\p{{Han}}\p{{Katakana}}]{{1,8}}[0-9]{{1,5}}(?:番地?)?(?:-[0-9]{{1,4}}){{0,2}})",
        city = municipality_pattern(),
    ))
    .expect("固定の正規表現が不正")
});

/// 丁目・番地・号と大字・字の住所(バイト範囲)。都道府県で始まる住所に重なるものは返さない(そちらが行の終わりまで覆う)。
/// 市区町村名の無い「字」は、前が漢字なら語の一部(「文字」)とみなす。
fn block_addresses(text: &str) -> Vec<Range<usize>> {
    let prefecture = prefecture_address(text);
    let mut found: Vec<Range<usize>> = Vec::new();
    let candidates = BLOCK_ADDRESS
        .captures_iter(text)
        .chain(OAZA_ADDRESS.captures_iter(text))
        .filter_map(|caps| caps.name("addr"))
        .filter(|m| {
            let bare_aza = m.as_str().starts_with('字');
            let after_kanji = text[..m.start()].chars().next_back().is_some_and(is_kanji);
            !(bare_aza && after_kanji)
        })
        .map(|m| m.range());
    for r in candidates {
        let overlaps = |o: &Range<usize>| r.start < o.end && o.start < r.end;
        if !prefecture.as_ref().is_some_and(overlaps) && !found.iter().any(overlaps) {
            found.push(r);
        }
    }
    found.sort_by_key(|r| r.start);
    found
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

/// 電話番号の数字の組の上限(`+33 1 23 45 67 89` の 6 組)。国内表記は 3 組まで。
const MAX_GROUPS_WITH_COUNTRY_CODE: usize = 6;
const MAX_GROUPS_DOMESTIC: usize = 3;
/// 数字の総数の上限。これを超えたら読むのをやめる(E.164 の上限 15 桁。`+81` + `0` + 11 桁 = 14 も収まる)。
const MAX_PHONE_DIGITS: usize = 15;
/// 海外の番号(国番号を含む)の桁数の下限。E.164 の番号は国番号を含めて 8 桁未満がほぼ無く、
/// これより短い `+` 付きの数(`+1 2024` など)は番号でないことが多い。
const MIN_INTERNATIONAL_DIGITS: usize = 8;
/// 区切りがあるときの国番号(最初の組)の桁数の上限(E.164 の国番号は 1〜3 桁)。
const MAX_COUNTRY_CODE_LEN: usize = 3;
/// 組の間の区切り(`-`・空白・括弧)の長さの上限(` - ` や `) ` を許す)。
const MAX_SEPARATOR_LEN: usize = 3;

/// 行の中の日本の電話番号(バイト範囲)。開始位置は `+`・`(`・`0` で、直前が数字の並びでないこと。
fn find_phones(text: &str) -> Vec<Range<usize>> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut start = 0;
    while start < bytes.len() {
        // `+` は英数字に続かないこと(`x+1` のような式・識別子の一部を除く)
        let after_word = bytes[start] == b'+' && start > 0 && bytes[start - 1].is_ascii_alphanumeric();
        let is_start =
            matches!(bytes[start], b'+' | b'(' | b'0') && !continues_number_before(text, start) && !after_word;
        if is_start {
            if let Some(end) = phone_at(text, start) {
                found.push(start..end);
                start = end;
                continue;
            }
        }
        start += 1;
    }
    for m in NANP_PHONE.captures_iter(text).filter_map(|caps| caps.name("phone")) {
        let overlaps = found.iter().any(|r| m.start() < r.end && r.start < m.end());
        if !overlaps && !continues_number_after(text, m.end()) {
            found.push(m.range());
        }
    }
    for range in &mut found {
        range.end += extension_len(&text[range.end..]);
    }
    found.sort_by_key(|r| r.start);
    found
}

/// 北米の国内表記(`(NXX) NXX-XXXX`・`NXX-NXX-XXXX`・`NXX.NXX.XXXX`。N は 2〜9)。前が英数字・`-`・`.` でないこと。
/// 括弧の市外局番の後は、局番が 0・1 で始まる形(架空の番号の 555-01XX など)と `.`・空白の区切りも許す。
static NANP_PHONE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:^|[^A-Za-z0-9\-.])(?P<phone>\([2-9][0-9]{2}\)\x20?[0-9]{3}[\-.\x20][0-9]{4}|[2-9][0-9]{2}-[2-9][0-9]{2}-[0-9]{4}|[2-9][0-9]{2}\.[2-9][0-9]{2}\.[0-9]{4})",
    )
    .expect("固定の正規表現が不正")
});

/// 電話番号の後の内線(`ext. 12`・`x104`・「内線 204」・括弧で囲んだ「(内線204)」)。後が英数字でないこと。
static PHONE_EXTENSION: LazyLock<Regex> = LazyLock::new(|| {
    let cues = PHONE_EXTENSION_CUES.join("|");
    Regex::new(&format!(
        r"(?i)^(?:\x20?(?:{cues})\x20?[0-9]{{1,6}}|\x20?\((?:{cues})\x20?[0-9]{{1,6}}\))(?:$|[^a-z0-9])"
    ))
    .expect("固定の正規表現が不正")
});

/// 電話番号の直後(`rest`)に続く内線のバイト数。無ければ 0。
fn extension_len(rest: &str) -> usize {
    PHONE_EXTENSION.find(rest).map_or(0, |m| {
        // 後ろの区切り(英数字でない 1 文字)は含めない
        let matched = m.as_str();
        let last = matched.chars().next_back();
        if last.is_some_and(|c| c.is_ascii_digit() || c == ')') { matched.len() } else { matched.len() - last.map_or(0, char::len_utf8) }
    })
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
        while pos < bytes.len() && matches!(bytes[pos], b'-' | b' ' | b'(' | b')' | b'.') {
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

/// 区切りとして許す並び: 長さ 3 以下で、`-`・`.`・`(`・`)` はそれぞれ 1 つまで(`-` と `.` は同時に使わない)、
/// 空白は連続しない。
fn is_valid_separator(separator: &[u8]) -> bool {
    let count = |c: u8| separator.iter().filter(|&&b| b == c).count();
    separator.len() <= MAX_SEPARATOR_LEN
        && count(b'-') + count(b'.') <= 1
        && count(b'(') <= 1
        && count(b')') <= 1
        && !separator.windows(2).any(|w| w == b"  ")
}

/// 読み取った数字の組が日本の電話番号の形か。
fn is_valid_phone(group: &GroupEnd, with_country_code: bool) -> bool {
    let national = if with_country_code {
        // `+81` の後ろの `(0)` や `0` は国内の頭の `0` として扱う
        let Some(rest) = group.digits.strip_prefix(JP_COUNTRY_CODE) else {
            return is_valid_international(group);
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

/// 日本以外の国番号付きの番号の形か(国番号を含めて 8〜15 桁、区切りがあれば国番号は 1〜3 桁)。
/// 組が 3 つ以上あるときは、読み取りで国番号と次の組がつながった形として最初の組を 6 桁まで許す。
fn is_valid_international(group: &GroupEnd) -> bool {
    (MIN_INTERNATIONAL_DIGITS..=MAX_PHONE_DIGITS).contains(&group.digits.len())
        && (group.groups == 1
            || group.first_group_len <= MAX_COUNTRY_CODE_LEN
            || (group.groups >= MIN_GROUPS_FOR_MERGED_COUNTRY_CODE && group.first_group_len <= MAX_MERGED_FIRST_GROUP_LEN))
}

/// 国番号と次の組がつながった最初の組を許す、組の数の下限と最初の組の桁数の上限(国番号 3 桁 + 市外局番 3 桁)。
const MIN_GROUPS_FOR_MERGED_COUNTRY_CODE: usize = 3;
const MAX_MERGED_FIRST_GROUP_LEN: usize = 6;

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
    use super::super::super::text::SensitiveText;
    use super::super::super::{Match, MatchDetail, NormalizedRect, RecognizedPage};
    use super::super::fake::FakePage;
    use super::super::test_support::{ranges_in, span};
    use super::super::Line;
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
            "+1 2024",             // 国番号付きでも桁が少なすぎる
            "+81-3-1234-56789",    // 日本の国番号は国内の桁数で判定する
            "x+1 555-0142",        // 英数字に続く + は式・識別子の一部
            "123-456-7890",        // 北米の形でも局番が 0・1 で始まる
            "2024-03-15",          // 日付
            "0120-12-34-56-78-90", // 区切りが多すぎる数字の並び
        ];
        for line in cases {
            assert!(phones(line).is_empty());
        }
    }

    #[test]
    fn 国番号付きの海外の電話を検出する() {
        // E.164: + と国番号の後に、国番号を含めて 8〜15 桁
        for line in [
            "+1-202-555-0123",
            "+1 555-0142",
            "+44 20 7946 0958",
            "+49 30 901820",
            "+65 6123 4567",
            "+33 1 23 45 67 89",
            "+86 10 1234 5678",
            "+12025550123",
        ] {
            assert_whole_phone(line);
        }
        let line = "Mobile +1 555-0142 / office";
        assert_eq!(phones(line), vec![span(line, "+1 555-0142")]);
    }

    #[test]
    fn 北米の国内表記の電話を検出する() {
        for line in ["(202) 555-0123", "202-555-0123", "202.555.0123"] {
            assert_whole_phone(line);
        }
        // 区切りが揃わない・長い数字の並びの途中は対象外
        for line in ["202-555.0123", "1202-555-0123", "202-555-01234", "ORD-202-555-0123"] {
            assert!(phones(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 国番号と市外局番の間の空白が落ちた海外の電話を検出する() {
        // 読み取りで国番号と次の組がつながった形(組が 3 つ以上あるときだけ、最初の組を 6 桁まで許す)
        for line in ["+61491 570 156", "+33199 00 24 87", "+4420 7946 0718"] {
            assert_whole_phone(line);
        }
        for line in ["+12345 678", "+1234567 89 01"] {
            assert!(phones(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 括弧の市外局番と点で区切った電話を検出する() {
        // 括弧の市外局番(N は 2〜9)の後の局番は 0・1 で始まってもよい(架空の 555-01xx を含む)
        for line in ["(555) 010-2290", "(555)010-2290", "(415) 555 0132", "+44.20.7946.0718", "+1.415.555.0132", "03.1234.5678"] {
            assert_whole_phone(line);
        }
        for line in ["(123) 456-7890", "(55) 010-2290", "1.2.3", "0.123.4567", "03.12.2026"] {
            assert!(phones(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 内線の番号を電話に含める() {
        let cases = [
            ("03-1234-5678 内線 204", "03-1234-5678 内線 204"),
            ("03-1234-5678(内線204)", "03-1234-5678(内線204)"),
            ("+1 (415) 555-0132 ext. 12", "+1 (415) 555-0132 ext. 12"),
            ("(555) 010-2290 x104 まで", "(555) 010-2290 x104"),
            ("TEL 06-0000-1234 Ext 3", "06-0000-1234 Ext 3"),
        ];
        for (line, expected) in cases {
            assert_eq!(phones(line), vec![span(line, expected)], "case {}", expected.len());
        }
        let line = "03-1234-5678 x";
        assert_eq!(phones(line), vec![span(line, "03-1234-5678")]);
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

    // ---- 都道府県で始まる住所(AM-T22)。市町村名・番地はすべて架空 ----

    /// ページ全体に検出器を当て、住所の結果だけを返す。
    fn detect_page_addresses(page: &dyn RecognizedPage) -> Vec<Match> {
        let lines: Vec<Line> = (0..page.line_count()).map(|i| Line::new(i, page.line_text(i))).collect();
        detect(page, &lines).into_iter().filter(|m| m.detail == MatchDetail::Address).collect()
    }

    #[test]
    fn 都道府県名で始まる行の残りを住所とする() {
        let cases = [
            ("愛知県ひがしの市栄町4-9-1 ユズリハビル3F", "愛知県ひがしの市栄町4-9-1 ユズリハビル3F"),
            ("北海道すずらん町北3条西4-6", "北海道すずらん町北3条西4-6"),
            ("住所 千葉県うみなり市幕張西１－１０－４", "千葉県うみなり市幕張西１－１０－４"),
            ("自宅住所:東京都みどり野区青葉台2-8-14  ", "東京都みどり野区青葉台2-8-14"),
            ("京都府かもがわ市三条通8-3", "京都府かもがわ市三条通8-3"),
        ];
        for (line, expected) in cases {
            assert_eq!(addresses(line), vec![span(line, expected)]);
        }
    }

    #[test]
    fn 郵便番号と都道府県が同じ行にあればそれぞれ住所とする() {
        let line = "〒330-0000 埼玉県さくら坂市本郷6-2-9";
        assert_eq!(addresses(line), vec![span(line, "〒330-0000"), span(line, "埼玉県さくら坂市本郷6-2-9")]);
    }

    #[test]
    fn 郵便番号だけの行の後に続く行を住所とする() {
        // 都道府県を省いた住所(直下の行)
        let page = FakePage::new(&["〒460-0000", "ひがしの市栄町4-9-1", "次の段落"]);
        assert_eq!(
            detect_page_addresses(&page),
            vec![Match::new(0, 0..9, MatchDetail::Address), Match::new(1, 0..12, MatchDetail::Address)]
        );
        // 郵便番号のラベル付き
        let page = FakePage::new(&["郵便番号 260-0000", "うみなり市幕張西1-10-4"]);
        assert_eq!(
            detect_page_addresses(&page),
            vec![Match::new(0, 5..13, MatchDetail::Address), Match::new(1, 0..14, MatchDetail::Address)]
        );
    }

    /// 観測の領域(x・y・幅・高さ。正規化座標・左下原点)。
    type Cell = (f64, f64, f64, f64);

    /// 観測の領域ごとに文字列を指定できる偽物のページ。
    struct GridPage {
        texts: Vec<SensitiveText>,
        boxes: Vec<NormalizedRect>,
    }

    impl GridPage {
        fn new(cells: &[(&str, Cell)]) -> Self {
            Self {
                texts: cells.iter().map(|(text, _)| SensitiveText::new((*text).to_string())).collect(),
                boxes: cells.iter().map(|&(_, (x, y, width, height))| NormalizedRect { x, y, width, height }).collect(),
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
        fn range_box(&self, _line: usize, _range: std::ops::Range<usize>) -> Option<NormalizedRect> {
            None
        }
    }

    #[test]
    fn 郵便番号だけの観測の近い右隣を住所とし遠い右隣は使わない() {
        // 近い右隣(間隔が行の高さ 0.03 の 2 倍以内)
        let near = "ひがしの市栄町4-9-1";
        let page = GridPage::new(&[("〒460-0000", (0.1, 0.5, 0.1, 0.03)), (near, (0.21, 0.5, 0.2, 0.03))]);
        assert_eq!(
            detect_page_addresses(&page),
            vec![Match::new(0, 0..9, MatchDetail::Address), Match::new(1, 0..12, MatchDetail::Address)]
        );
        // 遠い右隣(別の枠の観測)は使わず、直下の行を見る
        let page = GridPage::new(&[
            ("〒150-0000", (0.1, 0.5, 0.1, 0.03)),
            ("ログイン情報", (0.6, 0.5, 0.2, 0.03)),
            ("みどり野区青葉台2-8-14", (0.1, 0.45, 0.2, 0.03)),
        ]);
        assert_eq!(
            detect_page_addresses(&page),
            vec![Match::new(0, 0..9, MatchDetail::Address), Match::new(2, 0..14, MatchDetail::Address)]
        );
    }

    #[test]
    fn 二行目の建物名は手がかりが無ければ対象外() {
        // 都道府県で始まる行の次の行(建物名だけ)は拾わない(ARCH §5.3)
        let page = FakePage::new(&["大阪府なにわ台市本町1-22-7", "なにわ台ビルディング南館 12階"]);
        assert_eq!(detect_page_addresses(&page), vec![Match::new(0, 0..16, MatchDetail::Address)]);
    }

    #[test]
    fn 郵便番号の行の後でも住所の形でない行は対象外() {
        // 郵便番号以外の文字を含む行の後 / 次の行にかな漢字が無い
        let page = FakePage::new(&["〒460-0000 は旧番号です", "ひがしの市栄町4-9-1"]);
        assert_eq!(detect_page_addresses(&page), vec![Match::new(0, 0..9, MatchDetail::Address)]);
        let page = FakePage::new(&["〒460-0000", "TEL 052-000-0000"]);
        assert_eq!(detect_page_addresses(&page), vec![Match::new(0, 0..9, MatchDetail::Address)]);
    }

    #[test]
    fn 英語の住所を番地と通りの名前から検出する() {
        let cases = [
            ("1200 Example Ave, Suite 400, Springfield", "1200 Example Ave, Suite 400, Springfield"),
            ("Ship to: 350 Fifth Avenue, New York, NY 10118", "350 Fifth Avenue, New York, NY 10118"),
            ("10 Harbour View Rd.", "10 Harbour View Rd."),
            ("742 Evergreen Terrace", "742 Evergreen Terrace"),
            ("221B Baker Street, London NW1 6XE", "221B Baker Street, London NW1 6XE"),
        ];
        for (line, expected) in cases {
            assert_eq!(addresses(line), vec![span(line, expected)], "case {}", expected.len());
        }
    }

    #[test]
    fn 英語の住所の市_州_郵便番号の行を検出する() {
        for (line, expected) in [
            ("Springfield, IL 62704", "Springfield, IL 62704"),
            ("San Mateo, CA 94401-1234", "San Mateo, CA 94401-1234"),
        ] {
            assert_eq!(addresses(line), vec![span(line, expected)], "case {}", expected.len());
        }
    }

    #[test]
    fn 英語の住所の形でないものは対象外() {
        for line in ["Updated 3 Days ago", "Suite 400", "Room 12", "Released 2024 Road Map", "ID 12, CA 9"] {
            assert!(addresses(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 英語の住所の前の部屋番号を含める() {
        let cases = [
            ("Unit 12, 48 Fernhollow Road", "Unit 12, 48 Fernhollow Road"),
            ("Suite 400, 2200 Brindle Ave", "Suite 400, 2200 Brindle Ave"),
            ("Ship to: Apt 3B, 12 Elm St", "Apt 3B, 12 Elm St"),
            ("Flat 7 22 Harbour View Rd.", "Flat 7 22 Harbour View Rd."),
        ];
        for (line, expected) in cases {
            assert_eq!(addresses(line), vec![span(line, expected)], "case {}", expected.len());
        }
    }

    #[test]
    fn 英国式の郵便番号の行を住所とする() {
        let cases = [
            ("Ashbridge AB1 2CD, United Kingdom", "Ashbridge AB1 2CD, United Kingdom"),
            ("London SW1A 1AA", "London SW1A 1AA"),
            ("EC1A 1BB", "EC1A 1BB"),
            ("Post to: Little Hadham M1 1AE, UK", "Little Hadham M1 1AE, UK"),
        ];
        for (line, expected) in cases {
            assert_eq!(addresses(line), vec![span(line, expected)], "case {}", expected.len());
        }
        for line in ["AB1 2CDE", "XAB1 2CD", "Model 12 2CD", "SW1A1AA"] {
            assert!(addresses(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 番地で始まるローマ字の日本の住所を検出する() {
        let cases = [
            ("3-5-12 Kitahama, Sazanami-shi, Osaka 541-0000, Japan", "3-5-12 Kitahama, Sazanami-shi, Osaka 541-0000, Japan"),
            ("Office: 1-2-3 Marunouchi, Chiyoda-ku", "1-2-3 Marunouchi, Chiyoda-ku"),
        ];
        // 中の郵便番号(`541-0000`)は郵便番号の規則でも別に拾う
        for (line, expected) in cases {
            assert!(addresses(line).contains(&span(line, expected)), "case {}", expected.len());
        }
        for line in ["1-2-3 Go", "Step 1-2 Next, Done", "2026-10-09 Release, notes"] {
            assert!(addresses(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 丁目_番地_号と大字の住所を検出する() {
        let cases = [
            ("北浜二丁目3番18号", "北浜二丁目3番18号"),
            ("所在地 北浜2丁目3-18", "北浜2丁目3-18"),
            ("さざなみ市駿河台一丁目14番6号です", "さざなみ市駿河台一丁目14番6号"),
            ("本社は上野482番地の3にあります", "上野482番地の3"),
            ("宮前町12番5号", "宮前町12番5号"),
            ("くすのき市大字上野482-3", "くすのき市大字上野482-3"),
            ("字西原123番地", "字西原123番地"),
        ];
        for (line, expected) in cases {
            assert_eq!(addresses(line), vec![span(line, expected)], "case {}", expected.len());
        }
        for line in ["3丁目の夕日", "候補2番目", "1号機", "文字列123", "第3番", "問2番の答え"] {
            assert!(addresses(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 住所の行の後の郵便番号だけの行と折り返しの行を住所とする() {
        // 英語の住所の行の後に、郵便番号(+ 国名)だけの行が続く
        let page = FakePage::new(&["2200 Brindle Ave, Suite 9, Northfield, NV", "89000", "次の段落"]);
        let found = detect_page_addresses(&page);
        assert!(found.contains(&Match::new(1, 0..5, MatchDetail::Address)));
        let page = FakePage::new(&["3-5-12 Kitahama, Sazanami-shi, Osaka 541-", "0000, Japan"]);
        assert!(detect_page_addresses(&page).contains(&Match::new(1, 0..11, MatchDetail::Address)));
        // 日本語の住所の語の途中で折り返した行(行頭が長音・小書きの仮名)
        let page = FakePage::new(&["大阪府さざなみ市北浜二丁目3番18号 さざなみセンタ", "ービル7階"]);
        assert!(detect_page_addresses(&page).contains(&Match::new(1, 0..5, MatchDetail::Address)));
        // 住所でない行の後・郵便番号の形でない行は続けない
        for lines in [["Meeting notes, NV", "89000"], ["2200 Brindle Ave", "Thanks 2024"]] {
            let page = FakePage::new(&lines);
            assert!(!detect_page_addresses(&page).iter().any(|m| m.line == 1), "case {}", lines[1].len());
        }
    }

    #[test]
    fn 都道府県名だけ_都道府県名を含まない行は対象外() {
        for line in ["東京都", "京都", "大阪", "ひがしの市栄町4-9-1", "東京都 "] {
            assert!(addresses(line).is_empty());
        }
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
