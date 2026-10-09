//! ②認証情報: 接頭辞付きトークン・長いランダム列・手がかり語の値・URL のクエリ(FR-004)。
//!
//! 正規化(全角→半角)後の文字列に規則を当てる。正規表現は線形時間の `regex` クレートだけを使う。
//!
//! - URL のクエリ: `http(s)://` から空白・非 ASCII の手前までを URL とし、`?` 以降だけを返す(PRD §10 #3)。
//!   URL の中(パス・クエリ)はトークン・ランダム列の規則の対象から外す
//! - 接頭辞付きトークン: 語頭の接頭辞(`lexicon.rs`)+ 本体(16 文字以上・英字と数字を両方含む)
//! - 長いランダム列: `[A-Za-z0-9_-]` の塊で 20 文字以上・英字と数字が混在し、文字の種類(小文字・大文字・数字)の
//!   切り替わりが 3 回以上あるもの。厳密な文字集合は求めない(誤読 `0`→`Q` などを許す)
//! - 読み取りで入った途中の空白 1 つ: 両側が英字と数字を含む塊なら、1 つの列として扱う
//! - 手がかり語の値: 手がかり語(英字はキーの一部でもよい)+ 区切り + ASCII の値(空白・非 ASCII の手前まで)。
//!   手がかり語だけの観測は、同じ行の右隣(無ければ直下の行)の観測を値とする(`layout.rs`)

use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use super::super::layout::{next_line_below, right_neighbor};
use super::super::text::{normalize, SensitiveText};
use super::super::{Match, MatchDetail, RecognizedPage};
use super::lexicon::{API_KEY_CUE_PATTERN, CREDENTIAL_CUES_ASCII, CREDENTIAL_CUES_JA, TOKEN_PREFIXES};
use super::Line;

/// 接頭辞付きトークンの本体(接頭辞を除く・空白を除く)の最小の長さ。
const MIN_PREFIXED_BODY_LEN: usize = 16;
/// 長いランダム列の最小の長さ(空白を除く)。
const MIN_RANDOM_LEN: usize = 20;
/// 長いランダム列とみなす、文字の種類の切り替わりの最小回数(`-`・`_` をまたぐ切り替わりは数えない)。
const MIN_CLASS_CHANGES: usize = 3;
/// 手がかり語だけの観測(ラベル)とみなす文字数の上限。長い文は値を探さない。
const MAX_LABEL_CHARS: usize = 20;

/// URL(1 番目のグループがクエリ)。ホスト・パスは `?` を除く ASCII の記号・英数字。
static URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)https?://[\x21-\x3e\x40-\x7e]+(\?[\x21-\x7e]+)?").expect("固定の正規表現が不正")
});

/// 英数字・`-`・`_` の塊(トークン・ランダム列の単位)。
static CHUNK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9_\-]+").expect("固定の正規表現が不正"));

/// 接頭辞付きトークン(1 番目のグループが接頭辞、2 番目が本体)。接頭辞の前は英数字でないこと。
static PREFIXED: LazyLock<Regex> = LazyLock::new(|| {
    let mut prefixes: Vec<&str> = TOKEN_PREFIXES.to_vec();
    // 長い接頭辞を先に試す(左優先の選択で短い接頭辞に先に一致しないように)
    prefixes.sort_by_key(|p| std::cmp::Reverse(p.len()));
    let alternatives: Vec<String> = prefixes.iter().map(|p| regex::escape(p)).collect();
    Regex::new(&format!(
        r"(?:^|[^A-Za-z0-9])({})([A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)*)",
        alternatives.join("|")
    ))
    .expect("固定の正規表現が不正")
});

/// 日本語の手がかり語を、行と同じ規則で正規化したもの(長音 `ー` は `-` になる)。
static JA_CUES: LazyLock<Vec<String>> = LazyLock::new(|| {
    CREDENTIAL_CUES_JA
        .iter()
        .map(|cue| normalize(&SensitiveText::new((*cue).to_string())).as_str().to_string())
        .collect()
});

/// 日本語の手がかり語の正規表現の断片(正規化後の形)。
fn ja_cue_pattern() -> String {
    JA_CUES.iter().map(|cue| regex::escape(cue)).collect::<Vec<_>>().join("|")
}

/// 英字の手がかり語を含むキー(`DB_PASSWORD`・`api key` など)の正規表現の断片。
fn ascii_key_pattern() -> String {
    format!(r"[a-z0-9_.\-]*(?:{}|{API_KEY_CUE_PATTERN})[a-z0-9_.\-]*", CREDENTIAL_CUES_ASCII.join("|"))
}

/// 手がかり語(キー)+ 区切り + 値。区切りは `:`・`=`(前後の空白を許す)または空白だけ。
static LABELED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)(?:^|[^a-z0-9_.\-])(?P<key>{}|{})(?P<sep>\x20?[:=]\x20*|\x20+)(?P<value>[\x21-\x7e]+)",
        ascii_key_pattern(),
        ja_cue_pattern()
    ))
    .expect("固定の正規表現が不正")
});

/// 英字の手がかり語そのもの(キーの一部ではない)。空白だけの区切りを許すかの判定に使う。
static EXACT_ASCII_CUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)^(?:{}|{API_KEY_CUE_PATTERN})$", CREDENTIAL_CUES_ASCII.join("|")))
        .expect("固定の正規表現が不正")
});

/// 手がかり語で終わる観測(ラベル)。末尾の `:`・`=` を許す。前後の空白を除いた文字列に当てる。
static LABEL_ONLY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)^(?:(?:.*[^a-z0-9_.\-])?{}|.*(?:{}))\x20?[:=]?$",
        ascii_key_pattern(),
        ja_cue_pattern()
    ))
    .expect("固定の正規表現が不正")
});

/// ②認証情報の検出器。行ごとの規則に加え、ラベルの観測から右隣・直下の観測を値として探す。
pub(super) fn detect(page: &dyn RecognizedPage, lines: &[Line]) -> Vec<Match> {
    let mut matches = Vec::new();
    // 自分の行の中で手がかり語の値が見つかった観測(ラベルの値として行全体を返さない)
    let mut has_own_value = Vec::with_capacity(lines.len());
    for line in lines {
        let text = line.as_str();
        let urls: Vec<Range<usize>> = URL.find_iter(text).map(|m| m.range()).collect();
        let queries = URL.captures_iter(text).filter_map(|c| c.get(1)).map(|m| m.range());
        let tokens = find_prefixed_tokens(text, &urls);
        let excluded: Vec<Range<usize>> = urls.iter().chain(&tokens).cloned().collect();
        let randoms = find_random_strings(text, &excluded);
        let labeled = find_labeled_values(text);
        has_own_value.push(!labeled.is_empty());

        let found = queries
            .map(|r| (r, MatchDetail::UrlQuery))
            .chain(tokens.into_iter().map(|r| (r, MatchDetail::PrefixedToken)))
            .chain(randoms.into_iter().map(|r| (r, MatchDetail::RandomString)))
            .chain(labeled.into_iter().map(|r| (r, MatchDetail::LabeledSecret)));
        matches.extend(found.filter_map(|(range, detail)| line.to_match(range, detail)));
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
        if let Some(found) = value.to_match(trimmed_range(value.as_str()), MatchDetail::LabeledSecret) {
            matches.push(found);
        }
    }
    matches
}

/// 接頭辞付きトークン(バイト範囲)。URL の中は対象外。本体の後に空白 1 つを挟んで続く塊も本体に含める。
fn find_prefixed_tokens(text: &str, urls: &[Range<usize>]) -> Vec<Range<usize>> {
    let mut found: Vec<Range<usize>> = Vec::new();
    for caps in PREFIXED.captures_iter(text) {
        let (Some(prefix), Some(body)) = (caps.get(1), caps.get(2)) else {
            continue;
        };
        let start = prefix.start();
        if urls.iter().any(|u| u.contains(&start)) || found.last().is_some_and(|r| start < r.end) {
            continue;
        }
        let mut end = body.end();
        if let Some(next) = chunk_after_single_space(text, end) {
            let next_text = &text[next.clone()];
            if is_token_like(next_text) && !TOKEN_PREFIXES.iter().any(|p| next_text.starts_with(p)) {
                end = next.end;
            }
        }
        let body_text = &text[body.start()..end];
        if non_space_len(body_text) >= MIN_PREFIXED_BODY_LEN && is_token_like(body_text) {
            found.push(start..end);
        }
    }
    found
}

/// 長いランダム列(バイト範囲)。`excluded`(URL・接頭辞付きトークン)に重なる塊は対象外。
fn find_random_strings(text: &str, excluded: &[Range<usize>]) -> Vec<Range<usize>> {
    let chunks: Vec<Range<usize>> =
        CHUNK.find_iter(text).map(|m| m.range()).filter(|r| !overlaps_any(r, excluded)).collect();
    let mut found = Vec::new();
    let mut i = 0;
    while i < chunks.len() {
        let current = chunks[i].clone();
        if let Some(next) = chunks.get(i + 1) {
            let joined = current.start..next.end;
            let single_space = next.start == current.end + 1 && text.as_bytes()[current.end] == b' ';
            if single_space
                && is_token_like(&text[current.clone()])
                && is_token_like(&text[next.clone()])
                && is_random(&text[joined.clone()])
            {
                found.push(joined);
                i += 2;
                continue;
            }
        }
        if is_random(&text[current.clone()]) {
            found.push(current);
        }
        i += 1;
    }
    found
}

/// 手がかり語の値(バイト範囲)。空白だけの区切りは、英字の手がかり語そのもの(キーの一部でない)で
/// 値が英字以外を含むとき、または日本語の手がかり語のときだけ認める(`Password Reset` などを除く)。
fn find_labeled_values(text: &str) -> Vec<Range<usize>> {
    LABELED
        .captures_iter(text)
        .filter_map(|caps| {
            let (key, sep, value) = (caps.name("key")?, caps.name("sep")?, caps.name("value")?);
            if value.as_str().starts_with([':', '=']) {
                return None;
            }
            let explicit_separator = sep.as_str().contains([':', '=']);
            let accepted = explicit_separator
                || JA_CUES.iter().any(|cue| cue == key.as_str())
                || (EXACT_ASCII_CUE.is_match(key.as_str())
                    && value.as_str().chars().any(|c| !c.is_ascii_alphabetic()));
            accepted.then(|| value.range())
        })
        .collect()
}

/// 観測全体が手がかり語のラベル(「管理者パスワード」「Webhook secret」「API_KEY:」など)か。
fn is_label_only(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= MAX_LABEL_CHARS && LABEL_ONLY.is_match(trimmed)
}

/// `end` の直後が空白 1 つと塊なら、その塊のバイト範囲。
fn chunk_after_single_space(text: &str, end: usize) -> Option<Range<usize>> {
    if text.as_bytes().get(end) != Some(&b' ') {
        return None;
    }
    CHUNK.find_at(text, end + 1).filter(|m| m.start() == end + 1).map(|m| m.range())
}

/// 英字と数字を両方含む。
fn is_token_like(text: &str) -> bool {
    text.bytes().any(|b| b.is_ascii_alphabetic()) && text.bytes().any(|b| b.is_ascii_digit())
}

/// 長いランダム列の条件(空白を除いて 20 文字以上・英字と数字が混在・種類の切り替わり 3 回以上)。
fn is_random(text: &str) -> bool {
    non_space_len(text) >= MIN_RANDOM_LEN && is_token_like(text) && class_changes(text) >= MIN_CLASS_CHANGES
}

/// 隣り合う英数字の種類(小文字・大文字・数字)が切り替わる回数。`-`・`_`・空白で区切られた所は数えない
/// (`screenshot-2026-10-09` のような、単語と数字を区切って並べた列を除くため)。
fn class_changes(text: &str) -> usize {
    let mut previous: Option<u8> = None;
    let mut changes = 0;
    for b in text.bytes() {
        let class = match b {
            b'a'..=b'z' => 0,
            b'A'..=b'Z' => 1,
            b'0'..=b'9' => 2,
            _ => {
                previous = None;
                continue;
            }
        };
        if previous.is_some_and(|p| p != class) {
            changes += 1;
        }
        previous = Some(class);
    }
    changes
}

fn non_space_len(text: &str) -> usize {
    text.bytes().filter(|&b| b != b' ').count()
}

fn overlaps_any(range: &Range<usize>, others: &[Range<usize>]) -> bool {
    others.iter().any(|o| range.start < o.end && o.start < range.end)
}

/// 前後の空白を除いた部分のバイト範囲。
fn trimmed_range(text: &str) -> Range<usize> {
    let start = text.len() - text.trim_start().len();
    let end = text.trim_end().len();
    start..end.max(start)
}

#[cfg(test)]
mod tests {
    use std::ops::Range;

    use super::super::super::text::SensitiveText;
    use super::super::super::{Match, MatchDetail, NormalizedRect, RecognizedPage};
    use super::super::fake::FakePage;
    use super::super::lexicon::TOKEN_PREFIXES;
    use super::super::test_support::{ranges_in, span};
    use super::super::Line;
    use super::detect;

    // 失敗時に文字列を表示しないよう、比較は UTF-16 範囲(数値)だけで行う。
    // トークン形の文字列はソースに完全な形を書かず、実行時に接頭辞と本体を連結して作る(決定 #5)。

    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const HEX: &[u8] = b"0123456789abcdef";

    /// 英小文字・英大文字・数字が混ざった決定論的な列(`seed` を変えると別の列になる)。
    fn mixed(seed: usize, len: usize) -> String {
        (0..len).map(|i| char::from(ALPHABET[(seed + i * 7) % ALPHABET.len()])).collect()
    }

    /// 16 進の決定論的な列。
    fn hex(len: usize) -> String {
        (0..len).map(|i| char::from(HEX[(1 + i * 5) % HEX.len()])).collect()
    }

    /// 手がかり語の後に置く値(記号を含む短い列)。
    fn secret_value() -> String {
        format!("{}#{}", mixed(2, 4), mixed(9, 4))
    }

    fn prefixed(text: &str) -> Vec<Range<usize>> {
        ranges_in(detect, text, MatchDetail::PrefixedToken)
    }

    fn random(text: &str) -> Vec<Range<usize>> {
        ranges_in(detect, text, MatchDetail::RandomString)
    }

    fn labeled(text: &str) -> Vec<Range<usize>> {
        ranges_in(detect, text, MatchDetail::LabeledSecret)
    }

    fn url_query(text: &str) -> Vec<Range<usize>> {
        ranges_in(detect, text, MatchDetail::UrlQuery)
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

    // ---- 接頭辞付きトークン ----

    #[test]
    fn 一覧のすべての接頭辞のトークンを検出する() {
        for prefix in TOKEN_PREFIXES {
            let line = format!("{prefix}{}", mixed(3, 24));
            assert_eq!(prefixed(&line), vec![whole(&line)]);
        }
    }

    #[test]
    fn 行の中のトークンを前後の文字を含めずに検出する() {
        let token = format!("{}{}", TOKEN_PREFIXES[0], mixed(5, 24));
        let line = format!("本番 決済 {token} 2026-08-02");
        assert_eq!(prefixed(&line), vec![span(&line, &token)]);
        let line = format!("共有用トークン(期限 24 時間): {token}。");
        assert_eq!(prefixed(&line), vec![span(&line, &token)]);
    }

    #[test]
    fn 数字の組とハイフンを含む本体のトークンを検出する() {
        let prefix = TOKEN_PREFIXES.iter().find(|p| p.ends_with('-') && p.len() == 5).expect("接頭辞が無い");
        let line = format!("{prefix}123456789012-1234567890123-{}", mixed(1, 24));
        assert_eq!(prefixed(&line), vec![whole(&line)]);
    }

    #[test]
    fn トークンの誤読と途中の空白1つを許す() {
        // 本体の数字 0 が Q に誤読されても、本体の途中に空白が 1 つ入っても 1 件として検出する
        let body = mixed(3, 20).replace('0', "Q");
        let line = format!("{}{body}", TOKEN_PREFIXES[16]);
        assert_eq!(prefixed(&line), vec![whole(&line)]);
        let line = format!("{}{} {}", TOKEN_PREFIXES[7], mixed(3, 12), mixed(5, 12));
        assert_eq!(prefixed(&line), vec![whole(&line)]);
    }

    #[test]
    fn トークンの形でないものは接頭辞付きとして扱わない() {
        let prefix = TOKEN_PREFIXES[0];
        let cases = [
            format!("{prefix}{}", mixed(3, 8)),          // 本体が短い
            format!("{prefix}abcdefghijklmnopqrstuvwx"), // 本体が英字だけ
            format!("x{prefix}{}", mixed(3, 24)),        // 英字の途中から始まる
        ];
        for line in &cases {
            assert!(prefixed(line).is_empty());
        }
    }

    // ---- 長いランダム列 ----

    #[test]
    fn 二十文字以上の英数字混在の列を検出する() {
        let value = mixed(3, 20);
        assert_eq!(random(&value), vec![whole(&value)]);
        let line = format!("お問い合わせ番号: {}", mixed(7, 28));
        assert_eq!(random(&line), vec![span(&line, &mixed(7, 28))]);
    }

    #[test]
    fn ハイフンとアンダースコアを含む列を検出する() {
        let value = format!("{}-{}_{}", mixed(3, 10), mixed(5, 6), mixed(9, 8));
        let line = format!("Client ID {value}");
        assert_eq!(random(&line), vec![span(&line, &value)]);
    }

    #[test]
    fn 十九文字以下は対象外() {
        assert!(random(&mixed(3, 19)).is_empty());
    }

    #[test]
    fn 英字だけと数字だけの列は対象外() {
        for line in ["abcdefghijklmnopqrstuvwxyzABCD", "123456789012345678901234", "ABCDEFGHIJ-KLMNOPQRST-UVWX"] {
            assert!(random(line).is_empty());
        }
    }

    #[test]
    fn 単語と日付を連ねた列は対象外() {
        for line in ["screenshot-2026-10-09-at-12-30-45", "release_v2_build_20261009_final"] {
            assert!(random(line).is_empty());
        }
    }

    #[test]
    fn 十六進の列の誤読を許す() {
        let value = hex(40).replacen('0', "Q", 1);
        let line = format!("署名鍵 {value}");
        assert_eq!(random(&line), vec![span(&line, &value)]);
    }

    #[test]
    fn 途中の空白1つは1件として検出し2つ以上は分ける() {
        let line = format!("{} {}", mixed(3, 12), mixed(5, 12));
        assert_eq!(random(&line), vec![whole(&line)]);
        let line = format!("{}  {}", mixed(3, 12), mixed(5, 12));
        assert!(random(&line).is_empty());
    }

    #[test]
    fn ランダム列の後の普通の単語は含めない() {
        let value = mixed(3, 24);
        let line = format!("{value} and more");
        assert_eq!(random(&line), vec![span(&line, &value)]);
    }

    #[test]
    fn 接頭辞付きトークンはランダム列として重ねて返さない() {
        let line = format!("{}{}", TOKEN_PREFIXES[7], mixed(3, 30));
        assert!(random(&line).is_empty());
    }

    // ---- 手がかり語の値 ----

    #[test]
    fn 手がかり語と区切りの後の値を検出する() {
        let value = secret_value();
        let cases = [
            format!("password: {value}"),
            format!("Password:{value}"),
            format!("初期パスワード：{value}"),
            format!("暗証番号={value}"),
            format!("pwd = {value}"),
            format!("pass: {value}"),
            format!("secret= {value}"),
            format!("Token: {value}"),
            format!("api key: {value}"),
            format!("API Key={value}"),
            format!("パスワード {value}"),
            format!("password {value}"),
        ];
        for line in &cases {
            assert_eq!(labeled(line), vec![span(line, &value)]);
        }
    }

    #[test]
    fn キーに手がかり語を含むkey_valueの値を検出する() {
        let value = secret_value();
        let cases = [
            format!("API_KEY={value}"),
            format!("DB_PASSWORD={value}"),
            format!("export ACCESS_TOKEN={value}"),
            format!("client_secret: {value}"),
            format!("smtp.pass={value}"),
        ];
        for line in &cases {
            assert_eq!(labeled(line), vec![span(line, &value)]);
        }
    }

    #[test]
    fn 値は空白と日本語の手前で終わる() {
        let value = secret_value();
        let line = format!("password: {value} (初回ログイン後に変更)");
        assert_eq!(labeled(&line), vec![span(&line, &value)]);
        let line = format!("パスワード:{value}です");
        assert_eq!(labeled(&line), vec![span(&line, &value)]);
    }

    #[test]
    fn 手がかり語の値でないものは対象外() {
        let cases = [
            "Password Reset",                 // 空白区切りで値が英字だけ
            "token の期限は 24 時間です",     // 値が日本語
            "パスワードを変更してください",   // 区切りも値も無い
            "passport 12345",                 // 手がかり語を含む別の語(空白区切り)
            "password:",                      // 値が無い
            "Meeting at 10:30",
        ];
        for line in cases {
            assert!(labeled(line).is_empty());
        }
    }

    #[test]
    fn 手がかり語だけの観測の右隣の観測を値とする() {
        let value = secret_value();
        for label in ["管理者パスワード", "Webhook secret", "pwd", "api key:", "API_KEY", "暗証番号："] {
            let page = GridPage::new(&[(label, LEFT_CELL), (&value, RIGHT_CELL)]);
            assert_eq!(
                detect_page(&page, MatchDetail::LabeledSecret),
                vec![Match::new(1, whole(&value), MatchDetail::LabeledSecret)]
            );
        }
    }

    #[test]
    fn 右隣が無ければ直下の行を値とする() {
        let value = format!("  {}  ", secret_value());
        let page = FakePage::new(&["パスワード", &value, "次の行"]);
        assert_eq!(
            detect_page(&page, MatchDetail::LabeledSecret),
            vec![Match::new(1, span(&value, value.trim()), MatchDetail::LabeledSecret)]
        );
    }

    #[test]
    fn 右隣の観測が自分で手がかり語の値を持つなら値の部分だけを返す() {
        let value = secret_value();
        let cell = format!("password: {value}");
        let page = GridPage::new(&[("初期パスワード", LEFT_CELL), (&cell, RIGHT_CELL)]);
        assert_eq!(
            detect_page(&page, MatchDetail::LabeledSecret),
            vec![Match::new(1, span(&cell, &value), MatchDetail::LabeledSecret)]
        );
    }

    #[test]
    fn 手がかり語で終わらない観測や長い文は値を探さない() {
        let page = FakePage::new(&["パスワードを忘れた場合はこちら", "abc123"]);
        assert!(detect_page(&page, MatchDetail::LabeledSecret).is_empty());
        let page = FakePage::new(&["ログイン画面でパスワードを入力したあとに表示される確認用のパスワード", "abc123"]);
        assert!(detect_page(&page, MatchDetail::LabeledSecret).is_empty());
    }

    // ---- URL のクエリ ----

    #[test]
    fn urlのクエリ部分だけを検出する() {
        let query = "?code=7Hq2xV9m&uid=48213";
        let line = format!("https://portal.example.com/invite{query}");
        assert_eq!(url_query(&line), vec![span(&line, query)]);
        let query = "?lang=ja&user=8812";
        let line = format!("参考: http://docs.example.com/guide{query} を参照");
        assert_eq!(url_query(&line), vec![span(&line, query)]);
        let query = "?t=8fK2&exp=1730000000";
        let line = format!("リンク:https://login.example.org/magic{query}です");
        assert_eq!(url_query(&line), vec![span(&line, query)]);
    }

    #[test]
    fn クエリの無いurlは対象外() {
        for line in ["https://example.com/path/to/page", "https://example.com/?", "?q=1 だけ", "例: example.com/a?b=1"] {
            assert!(url_query(line).is_empty());
        }
    }

    #[test]
    fn urlのパス部分はトークンやランダム列として返さない() {
        let line = format!("https://hooks.example.net/in/{}/{}?v=2", mixed(3, 24), TOKEN_PREFIXES[7]);
        assert!(random(&line).is_empty());
        assert!(prefixed(&line).is_empty());
        assert_eq!(url_query(&line), vec![span(&line, "?v=2")]);
    }

    // ---- UTF-16 範囲 ----

    #[test]
    fn 全角の行でutf16範囲が正しい() {
        // 全角の英数字・コロンは正規化してから判定し、範囲は正規化前の位置で返す
        let line = "パスワード：ａｂｃ１２３＃";
        assert_eq!(labeled(line), vec![span(line, "ａｂｃ１２３＃")]);
    }
}
