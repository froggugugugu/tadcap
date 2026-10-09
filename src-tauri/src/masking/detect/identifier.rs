//! ③識別子: 手がかり語付きの番号・人名・会社名(FR-005・FR-007)。手がかり語付きの番号は AM-T16、人名は AM-T21、会社名は AM-T22 で実装する。
//!
//! 正規化(全角→半角)後の文字列に規則を当てる。正規表現は線形時間の `regex` クレートだけを使う。
//!
//! - 手がかり語付きの番号: 手がかり語(`lexicon.rs`)+ 区切り + 英数字の値(`-`・`_` を含んでよい。数字を 1 つ以上含む)。
//!   値は空白・日本語・記号の手前で終わる。英字の手がかり語(「ID」「User ID」)は語の一部でないこと、
//!   値との間に空白か `:`・`=`・`#` があること
//! - 手がかり語だけの観測(数字を含まない短いラベル)は、同じ行の右隣(無ければ直下の行)の観測の先頭の値を番号とする

use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use super::super::layout::{next_line_below, right_neighbor};
use super::super::text::{normalize, SensitiveText};
use super::super::{Match, MatchDetail, RecognizedPage};
use super::lexicon::{CUED_NUMBER_CUES_ASCII, CUED_NUMBER_CUES_JA};
use super::Line;

/// 手がかり語だけの観測(ラベル)とみなす文字数の上限。長い文は値を探さない。
const MAX_LABEL_CHARS: usize = 20;

/// 日本語の手がかり語を行と同じ規則で正規化し、長いものを先にした正規表現の選択肢(長音 `ー` は `-` になる)。
fn ja_cue_pattern() -> String {
    let mut cues: Vec<String> = CUED_NUMBER_CUES_JA
        .iter()
        .map(|cue| normalize(&SensitiveText::new((*cue).to_string())).as_str().to_string())
        .collect();
    cues.sort_by_key(|cue| std::cmp::Reverse(cue.len()));
    cues.iter().map(|cue| regex::escape(cue)).collect::<Vec<_>>().join("|")
}

/// 番号の値(英数字で始まり、英数字・`_`・`-` が続く)。
const VALUE_PATTERN: &str = r"[a-z0-9][a-z0-9_\-]*";

/// 手がかり語 + 区切り + 値。英字の手がかり語は前が英数字でないこと。
static CUED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)(?:(?P<ja>{ja})|(?:^|[^a-z0-9_])(?P<en>{en}))(?P<sep>\x20*[:=#]\x20*|\x20*)(?P<value>{VALUE_PATTERN})",
        ja = ja_cue_pattern(),
        en = CUED_NUMBER_CUES_ASCII.join("|"),
    ))
    .expect("固定の正規表現が不正")
});

/// 手がかり語を含む観測(英字の手がかり語は語の一部でないこと)。
static LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i){ja}|(?:^|[^a-z0-9_])(?:{en})(?:$|[^a-z0-9_])",
        ja = ja_cue_pattern(),
        en = CUED_NUMBER_CUES_ASCII.join("|"),
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

    for line in lines.iter().filter(|line| is_label_only(line.as_str())) {
        let Some(neighbor) = right_neighbor(page, line.index).or_else(|| next_line_below(page, line.index))
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
    matches
}

/// 同じ行の手がかり語の後の番号(バイト範囲)。
fn find_cued_numbers(text: &str) -> Vec<Range<usize>> {
    CUED.captures_iter(text)
        .filter_map(|caps| {
            let (sep, value) = (caps.name("sep")?, caps.name("value")?);
            // 英字の手がかり語は値との間に区切りが要る(`IDE`・`idx1` などを除く)
            if caps.name("en").is_some() && sep.as_str().is_empty() {
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
    fn 手がかり語だけの観測の右隣の観測を値とする() {
        for (label, value) in [("会員番号", "M-55-01928"), ("ID", "A7731"), ("社員番号", "E-551902"), ("顧客ID:", "CU88301")]
        {
            let page = GridPage::new(&[(label, LEFT_CELL), (value, RIGHT_CELL)]);
            assert_eq!(detect_page(&page), vec![Match::new(1, 0..value.len(), MatchDetail::LabeledNumber)]);
        }
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
}
