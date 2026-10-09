//! 4 種の検出器を回して `Match`(行・UTF-16 範囲・種類・細分)を集める(ARCH_auto-masking §5.3)。
//! 入力は `RecognizedPage` 越しの行の文字列と位置だけで、読み取りの実装・Vision 系には依存しない。
//!
//! - 各行は `text::normalize` で全角→半角に 1 対 1 で正規化してから規則を当てる
//! - 検出器はバイト位置で見つけた範囲を `Line::to_match` に渡し、`Utf16Map` で UTF-16 範囲に直す
//! - 重複の除去・矩形への変換は `geometry`(AM-T09)の役目。ここでは完全に同じ結果だけを 1 つにする

mod contact;
mod credential;
mod financial;
mod identifier;
mod lexicon;

use std::ops::Range;

use super::layout::{column_below, same_row};
use super::text::{normalize, SensitiveText, Utf16Map};
use super::{Match, MatchDetail, RecognizedPage};

/// 正規化した 1 行。文字列は `SensitiveText` のまま持ち、検出規則を当てるときだけ借りる。
struct Line {
    /// `RecognizedPage` の行の番号
    index: usize,
    /// 正規化後の文字列(UTF-16 の位置は正規化前と同じ)
    text: SensitiveText,
    /// 正規化後の文字列のバイト位置 → UTF-16 位置
    map: Utf16Map,
}

impl Line {
    fn new(index: usize, original: &SensitiveText) -> Self {
        let text = normalize(original);
        let map = Utf16Map::new(text.as_str());
        Self { index, text, map }
    }

    /// 正規化後の文字列を借りる。戻り値を出力・保存・ログに渡さないこと。
    fn as_str(&self) -> &str {
        self.text.as_str()
    }

    /// バイト単位の範囲を UTF-16 単位の `Match` にする。空の範囲・文字の境界でない範囲は `None`。
    fn to_match(&self, bytes: Range<usize>, detail: MatchDetail) -> Option<Match> {
        let range = self.map.utf16_range(bytes)?;
        if range.is_empty() {
            return None;
        }
        Some(Match::new(self.index, range, detail))
    }
}

// ---- 文字の種類(人名・会社名・住所の規則で共有する) ----

fn is_kanji(c: char) -> bool {
    matches!(c, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}' | '々' | '〆')
}

fn is_hiragana(c: char) -> bool {
    matches!(c, '\u{3041}'..='\u{3096}' | '\u{309d}'..='\u{309e}')
}

/// カタカナ(半角を含む。長音 `ー` は `normalize` で `-` になるため別に扱う)。
fn is_katakana(c: char) -> bool {
    matches!(c, '\u{30a1}'..='\u{30fa}' | '\u{30fd}'..='\u{30ff}' | '\u{ff66}'..='\u{ff9d}')
}

fn is_kana_kanji(c: char) -> bool {
    is_kanji(c) || is_hiragana(c) || is_katakana(c)
}

/// カタカナの後に続く長音(正規化後の `-`)・中黒。
fn is_katakana_mark(c: char) -> bool {
    matches!(c, '-' | '・')
}

// ---- 表の見出しと列(手がかり語付きの番号・認証情報の規則で共有する) ----

/// 表の見出しの行とみなす観測の数の下限(ラベルと値の 2 列だけのフォームを除く)。
const MIN_HEADER_ROW_CELLS: usize = 3;

/// 表の見出しとみなす観測の文字数の上限(手がかり語だけの観測の上限と同じ)。
const MAX_HEADER_CELL_CHARS: usize = 20;

/// `lines[pos]` が表の見出しの行にあるか。同じ行に 3 つ以上の観測があり、そのすべてが短く(20 字以下)
/// 数字を含まないとき(値が同じ行に並ぶフォームは、値が数字を含むので除かれる)。
fn in_header_row(page: &dyn RecognizedPage, lines: &[Line], pos: usize) -> bool {
    let row = same_row(page, lines[pos].index);
    row.len() >= MIN_HEADER_ROW_CELLS
        && row.iter().all(|&index| {
            lines.iter().find(|l| l.index == index).is_some_and(|l| {
                let text = l.as_str().trim();
                !text.is_empty() && text.chars().count() <= MAX_HEADER_CELL_CHARS && !text.bytes().any(|b| b.is_ascii_digit())
            })
        })
}

/// 表の見出し `lines[pos]` の列の下に並ぶ観測(`lines` の位置。上から順)。見出しの行でなければ空。
fn column_cells(page: &dyn RecognizedPage, lines: &[Line], pos: usize) -> Vec<usize> {
    if !in_header_row(page, lines, pos) {
        return Vec::new();
    }
    column_below(page, lines[pos].index)
        .into_iter()
        .filter_map(|index| lines.iter().position(|l| l.index == index))
        .collect()
}

/// 検出器。ページ(行の位置。右隣・直下の観測を探す規則が使う)と正規化済みの全行を受け取る。
type Detector = fn(&dyn RecognizedPage, &[Line]) -> Vec<Match>;

/// 登録済みの検出器(①連絡先 → ②認証情報 → ③識別子 → ④金額・口座)。
/// ③識別子は手がかり語付きの番号・人名・会社名、①連絡先はメール・電話番号・住所。
const DETECTORS: [Detector; 4] = [contact::detect, credential::detect, identifier::detect, financial::detect];

/// ページ全体に全検出器を当て、行の番号・範囲の順に並べた結果を返す(完全に同じ結果は 1 つにする)。
pub(super) fn run(page: &dyn RecognizedPage) -> Vec<Match> {
    let lines: Vec<Line> =
        (0..page.line_count()).map(|index| Line::new(index, page.line_text(index))).collect();
    let mut matches: Vec<Match> =
        DETECTORS.iter().flat_map(|detector| detector(page, &lines)).collect();
    matches.sort_by_key(|m| (m.line, m.range.start, m.range.end, m.detail as u8));
    matches.dedup();
    matches
}

/// テスト用の偽物のページ(文字幅を UTF-16 単位で等分する)。`masking` 配下のテストから使う。
#[cfg(test)]
pub(in crate::masking) mod fake {
    use std::ops::Range;

    use super::super::text::SensitiveText;
    use super::super::{NormalizedRect, RecognizedPage};

    /// 行の左端・幅・高さ(正規化座標)。行は上から下へ `LINE_PITCH` ずつ並べる。
    const LEFT: f64 = 0.05;
    const WIDTH: f64 = 0.9;
    const HEIGHT: f64 = 0.04;
    const LINE_PITCH: f64 = 0.05;

    pub(in crate::masking) struct FakePage {
        lines: Vec<SensitiveText>,
    }

    impl FakePage {
        pub(in crate::masking) fn new(lines: &[&str]) -> Self {
            Self { lines: lines.iter().map(|line| SensitiveText::new((*line).to_string())).collect() }
        }

        fn utf16_len(&self, line: usize) -> usize {
            self.lines[line].as_str().encode_utf16().count()
        }
    }

    impl RecognizedPage for FakePage {
        fn line_count(&self) -> usize {
            self.lines.len()
        }

        fn line_text(&self, line: usize) -> &SensitiveText {
            &self.lines[line]
        }

        fn line_box(&self, line: usize) -> NormalizedRect {
            // Vision と同じ左下原点。0 行目がいちばん上
            let y = 1.0 - LINE_PITCH * (line as f64 + 1.0);
            NormalizedRect { x: LEFT, y, width: WIDTH, height: HEIGHT }
        }

        fn range_box(&self, line: usize, range: Range<usize>) -> Option<NormalizedRect> {
            let len = self.utf16_len(line);
            if range.start >= range.end || range.end > len {
                return None;
            }
            let unit = WIDTH / len as f64;
            let line_box = self.line_box(line);
            Some(NormalizedRect {
                x: LEFT + unit * range.start as f64,
                y: line_box.y,
                width: unit * range.len() as f64,
                height: HEIGHT,
            })
        }
    }
}

/// 検出器のテストで使う補助。
#[cfg(test)]
mod test_support {
    use std::ops::Range;

    use super::super::text::SensitiveText;
    use super::super::MatchDetail;
    use super::fake::FakePage;
    use super::{Detector, Line};

    /// 1 行だけに検出器を当て、指定した細分の UTF-16 範囲を返す。
    pub(super) fn ranges_in(detector: Detector, text: &str, detail: MatchDetail) -> Vec<Range<usize>> {
        let page = FakePage::new(&[text]);
        let lines = [Line::new(0, &SensitiveText::new(text.to_string()))];
        detector(&page, &lines)
            .into_iter()
            .filter(|m| m.detail == detail)
            .map(|m| m.range)
            .collect()
    }

    /// `line` の中の `needle`(最初に現れる位置)の UTF-16 範囲。テストの期待値を作るのに使う。
    pub(super) fn span(line: &str, needle: &str) -> Range<usize> {
        let byte = line.find(needle).expect("期待値の部分文字列が行に無い");
        let start = line[..byte].encode_utf16().count();
        start..start + needle.encode_utf16().count()
    }
}

#[cfg(test)]
mod tests {
    use super::super::{MaskKind, MatchDetail};
    use super::fake::FakePage;
    use super::test_support::span;
    use super::*;

    #[test]
    fn 空のページは空を返す() {
        let page = FakePage::new(&[]);
        assert!(run(&page).is_empty());
    }

    #[test]
    fn 候補の無い行だけなら空を返す() {
        let page = FakePage::new(&["お世話になっております。", "Meeting at 10:30", ""]);
        assert!(run(&page).is_empty());
    }

    #[test]
    fn 行の番号とutf16範囲と種類を返す() {
        let line0 = "件名: 定例会議";
        let line1 = "メール：ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏｍ";
        let line2 = "電話 ０３－１２３４－５６７８ まで";
        let page = FakePage::new(&[line0, line1, line2]);
        let matches = run(&page);
        assert_eq!(
            matches,
            vec![
                Match::new(1, span(line1, "ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏｍ"), MatchDetail::Email),
                Match::new(2, span(line2, "０３－１２３４－５６７８"), MatchDetail::Phone),
            ]
        );
        assert!(matches.iter().all(|m| m.kind == MaskKind::Contact));
    }

    #[test]
    fn 結果は行と範囲の順に並ぶ() {
        let page = FakePage::new(&[
            "090-1234-5678 / a@example.com",
            "〒100-0001",
            "b@example.jp 03-1234-5678",
        ]);
        let matches = run(&page);
        let keys: Vec<(usize, usize)> = matches.iter().map(|m| (m.line, m.range.start)).collect();
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        assert_eq!(keys, sorted);
        assert_eq!(matches.len(), 5);
    }

    #[test]
    fn 結果のutf16範囲で偽物のページから領域を求められる() {
        let line = "連絡先：ｈａｎａｋｏ＠ｅｘａｍｐｌｅ．ｊｐ";
        let page = FakePage::new(&[line]);
        let matches = run(&page);
        assert_eq!(matches.len(), 1);
        let rect = page.range_box(0, matches[0].range.clone()).expect("領域が求められなかった");
        let total = line.encode_utf16().count() as f64;
        let start = span(line, "ｈ").start as f64;
        assert!((rect.x - (0.05 + 0.9 / total * start)).abs() < 1e-9);
        assert!(rect.width > 0.0);
    }

    #[test]
    fn line_to_matchは空の範囲と文字の途中を拒む() {
        let line = Line::new(0, &SensitiveText::new("電話03".to_string()));
        assert_eq!(line.to_match(6..6, MatchDetail::Phone), None);
        assert_eq!(line.to_match(1..6, MatchDetail::Phone), None);
        assert_eq!(line.to_match(6..8, MatchDetail::Phone), Some(Match::new(0, 2..4, MatchDetail::Phone)));
    }

    #[test]
    fn 認証情報の検出器を登録している() {
        let query = "?code=7Hq2&uid=48213";
        let line = format!("https://portal.example.com/invite{query}");
        let page = FakePage::new(&[&line]);
        let matches = run(&page);
        assert_eq!(matches, vec![Match::new(0, span(&line, query), MatchDetail::UrlQuery)]);
        assert!(matches.iter().all(|m| m.kind == MaskKind::Credential));
    }

    #[test]
    fn 識別子の検出器を登録している() {
        let line = "社員番号 E-204871";
        let page = FakePage::new(&[line]);
        let matches = run(&page);
        assert_eq!(matches, vec![Match::new(0, span(line, "E-204871"), MatchDetail::LabeledNumber)]);
        assert!(matches.iter().all(|m| m.kind == MaskKind::Identifier));
    }

    #[test]
    fn 金額と口座の検出器を登録している() {
        let line = "普通 1234567 / 手数料 440円";
        let page = FakePage::new(&[line]);
        let matches = run(&page);
        assert_eq!(
            matches,
            vec![
                Match::new(0, span(line, "1234567"), MatchDetail::AccountNumber),
                Match::new(0, span(line, "440円"), MatchDetail::Amount),
            ]
        );
        assert!(matches.iter().all(|m| m.kind == MaskKind::Financial));
    }
}
