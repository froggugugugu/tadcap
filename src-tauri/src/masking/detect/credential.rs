//! ②認証情報: 接頭辞付きトークン・長いランダム列・手がかり語の値・URL のクエリ(FR-004)。
//!
//! 正規化(全角→半角)後の文字列に規則を当てる。正規表現は線形時間の `regex` クレートだけを使う。
//!
//! - URL のクエリ: `http(s)://` から空白・非 ASCII の手前までを URL とし、`?` 以降だけを返す(PRD §10 #3)。
//!   スキームの無いパス(`GET /export?from=...`)も、語頭の `/` から始まり `?` と `=` を含めば URL とみなす。
//!   読み取りで入った空白 1 つの後に `=`・`?` を含む塊が続けば URL の続きとする。`?` が誤読された
//!   (`?` が無く、パスに `=` がある)ときは、最初の `=` の前のキーとその直前の 1 文字からをクエリとする。
//!   URL の中(パス・クエリ)はトークン・ランダム列の規則の対象から外す
//! - 接頭辞付きトークン: 語頭の接頭辞(`lexicon.rs`)+ 本体(16 文字以上・英字と数字を両方含む)
//! - 長いランダム列: `[A-Za-z0-9_-]` の塊で 20 文字以上・英字と数字が混在し、文字の種類(小文字・大文字・数字)の
//!   切り替わりが 3 回以上あるもの。厳密な文字集合は求めない(誤読 `0`→`Q` などを許す)
//! - 読み取りで入った途中の空白(1 つずつ): 続く塊が英字と数字を含むか、大文字・小文字の切り替わりが 2 回以上
//!   あれば、1 つの列として扱う(何か所でも続ける)。末尾の `l`・`I` が `]`・`|` に誤読された 1 文字も含める
//! - 手がかり語の値: 手がかり語(英字はキーの一部でもよい)+ 区切り + ASCII の値(空白・非 ASCII の手前まで)。
//!   値の後に空白 1 つを挟んで英数字と記号(英字以外)を含む塊が続けば、読み取りで入った空白として値に含める。
//!   手がかり語だけの観測は、同じ行の右隣(無ければ直下の行)の観測を値とする(`layout.rs`)

use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use super::super::layout::{near_right_neighbor, next_line_below};
use super::super::text::{normalize, SensitiveText};
use super::super::{Match, MatchDetail, RecognizedPage};
use super::lexicon::{
    API_KEY_CUE_PATTERN, CODE_CUE_PATTERN, CREDENTIAL_CUES_ASCII, CREDENTIAL_CUES_JA, CREDENTIAL_WORD_CUES_ASCII,
    CUE_PARTICLES, TOKEN_PREFIXES,
};
use super::{column_cells, Line};

/// 接頭辞付きトークンの本体(接頭辞を除く・空白を除く)の最小の長さ。
const MIN_PREFIXED_BODY_LEN: usize = 16;
/// 長いランダム列の最小の長さ(空白を除く)。
const MIN_RANDOM_LEN: usize = 20;
/// 数字と英字を `MIN_SHORT_RANDOM_EACH` 個以上ずつ含むときの、ランダム列の最小の長さ(空白を除く)。
///
/// 16〜19 文字の ID(64 bit の 16 進など)を拾うため。リポジトリの文書・コード約 15 万語で数えると、
/// 長さだけ 16 に下げると大文字始まりの語に数字 1 つを挟んだ識別子が 43 件増えたが、
/// 数字と英字を 3 つ以上ずつ求めると 1 件(テスト用の架空の列)だけだった(2026-10-09 の一般化)。
const MIN_SHORT_RANDOM_LEN: usize = 16;
/// 短いランダム列(16〜19 文字)に求める数字・英字それぞれの最小の個数。
const MIN_SHORT_RANDOM_EACH: usize = 3;
/// 長いランダム列とみなす、文字の種類の切り替わりの最小回数(`-`・`_` をまたぐ切り替わりは数えない)。
const MIN_CLASS_CHANGES: usize = 3;
/// 手がかり語だけの観測(ラベル)とみなす文字数の上限。長い文は値を探さない。
const MAX_LABEL_CHARS: usize = 20;
/// 塊の続きとみなす、大文字・小文字・数字の切り替わりの最小回数(英字だけの塊。`aBc`・`Xy_Zw` など)。
const MIN_CONTINUATION_CHANGES: usize = 2;

/// スキーム付きの URL。空白・非 ASCII の手前まで(クエリの位置は `query_of` で決める)。
static URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)https?://[\x21-\x7e]+").expect("固定の正規表現が不正"));

/// スキームの無いパスだけの URL(1 番目のグループ)。語頭の `/` から始まり、`?` と `=` を含む。
static PATH_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:^|[\x20"'(=])(/[\x21-\x7e]*\?[\x21-\x7e]*=[\x21-\x7e]*)"#).expect("固定の正規表現が不正")
});

/// 英数字・`-`・`_` の塊(トークン・ランダム列の単位)。末尾の `]`・`|` 1 文字は `l`・`I` の誤読として含める。
static CHUNK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9_\-]+[\]|]?").expect("固定の正規表現が不正"));

/// 接頭辞付きトークン(1 番目のグループが接頭辞、2 番目が本体)。接頭辞の前は英数字でないこと。
/// 区切り(`_`・`-`)を含む接頭辞(`sk_live_`・`glpat-` など)は、読み取りの大文字・小文字の誤り(`sk_Live_`)を許す。
/// 区切りの無い接頭辞(`AKIA`・`AIza`・`SG.`)は大文字・小文字を区別する(普通の語と紛れないように)。
static PREFIXED: LazyLock<Regex> = LazyLock::new(|| {
    let mut prefixes: Vec<&str> = TOKEN_PREFIXES.to_vec();
    // 長い接頭辞を先に試す(左優先の選択で短い接頭辞に先に一致しないように)
    prefixes.sort_by_key(|p| std::cmp::Reverse(p.len()));
    let alternatives: Vec<String> = prefixes
        .iter()
        .map(|p| if p.contains(['_', '-']) { format!("(?i:{})", regex::escape(p)) } else { regex::escape(p) })
        .collect();
    Regex::new(&format!(
        r"(?:^|[^A-Za-z0-9])({})([A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)*)",
        alternatives.join("|")
    ))
    .expect("固定の正規表現が不正")
});

/// 接続文字列・URL の利用者情報の中のパスワード(`scheme://user:password@host` の `password`)。
static USERINFO_PASSWORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[a-z][a-z0-9+.\-]*://[^\x20/:@]+:(?P<password>[^\x20/@]+)@[a-z0-9]").expect("固定の正規表現が不正")
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

/// 英字の手がかり語を含むキー(`DB_PASSWORD`・`api key` など)、または語として独立した手がかり語(`PIN` など)の
/// 正規表現の断片。独立した語の前後は、使う側の正規表現の区切り(語頭・`:`・空白など)で区切られる。
fn ascii_key_pattern() -> String {
    format!(
        r"(?:[a-z0-9_.\-]*(?:{}|{API_KEY_CUE_PATTERN}|{CODE_CUE_PATTERN})[a-z0-9_.\-]*|{})",
        CREDENTIAL_CUES_ASCII.join("|"),
        CREDENTIAL_WORD_CUES_ASCII.join("|")
    )
}

/// 手がかり語(キー)+ 区切り + 値。区切りは `:`・`=`(前後の空白を許す)、助詞(「暗証番号は …」)、または空白だけ。
static LABELED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)(?:^|[^a-z0-9_.\-])(?P<key>{}|{})(?P<sep>\x20?[:=]\x20*|\x20*(?:{})\x20*[:=]?\x20*|\x20+)(?P<value>[\x21-\x7e]+)",
        ascii_key_pattern(),
        ja_cue_pattern(),
        CUE_PARTICLES.join("|")
    ))
    .expect("固定の正規表現が不正")
});

/// 英字の手がかり語そのもの(キーの一部ではない)。空白だけの区切りを許すかの判定に使う。
static EXACT_ASCII_CUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)^(?:{}|{API_KEY_CUE_PATTERN}|{CODE_CUE_PATTERN}|{})$",
        CREDENTIAL_CUES_ASCII.join("|"),
        CREDENTIAL_WORD_CUES_ASCII.join("|")
    ))
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
        let found_urls = find_urls(text);
        let urls: Vec<Range<usize>> = found_urls.iter().map(|(url, _)| url.clone()).collect();
        let queries = found_urls.into_iter().filter_map(|(_, query)| query);
        let tokens = find_prefixed_tokens(text, &urls);
        let excluded: Vec<Range<usize>> = urls.iter().chain(&tokens).cloned().collect();
        let randoms = find_random_strings(text, &excluded);
        let mut labeled = find_labeled_values(text);
        for password in find_userinfo_passwords(text) {
            if !overlaps_any(&password, &labeled) {
                labeled.push(password);
            }
        }
        has_own_value.push(!labeled.is_empty());

        let found = queries
            .map(|r| (r, MatchDetail::UrlQuery))
            .chain(tokens.into_iter().map(|r| (r, MatchDetail::PrefixedToken)))
            .chain(randoms.into_iter().map(|r| (r, MatchDetail::RandomString)))
            .chain(labeled.into_iter().map(|r| (r, MatchDetail::LabeledSecret)));
        matches.extend(found.filter_map(|(range, detail)| line.to_match(range, detail)));
    }

    for (pos, line) in lines.iter().enumerate().filter(|(_, line)| is_label_only(line.as_str())) {
        // 表の見出しなら列の下に並ぶ値を手がかり語の値とし、右隣(別の列の見出し)は値にしない
        let column = column_secrets(lines, &column_cells(page, lines, pos), &has_own_value);
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
        let range = trimmed_range(value.as_str());
        if !value.as_str().get(range.clone()).is_some_and(is_secret_like) {
            continue;
        }
        if let Some(found) = value.to_match(range, MatchDetail::LabeledSecret) {
            matches.push(found);
        }
    }
    matches
}

/// ラベルとは別の観測を値とするときの長さの下限(空白を除く)。「-」「N/A」などの空欄の表記を除く。
const MIN_SEPARATE_SECRET_LEN: usize = 4;

/// ラベルとは別の観測(右隣・直下・表の列)を値とするときの形: ASCII だけで 4 文字以上、かつ数字か記号を含むか
/// 大文字・小文字の切り替わりが 2 回以上ある。画面の見出し・メニューの項目名(「Webhook」「名前」)を除く。
fn is_secret_like(value: &str) -> bool {
    value.is_ascii()
        && non_space_len(value) >= MIN_SEPARATE_SECRET_LEN
        && (value.bytes().any(|b| b.is_ascii_digit() || b.is_ascii_punctuation())
            || class_changes(value) >= MIN_CONTINUATION_CHANGES)
}

/// 表の列の観測(`cells` は `lines` の位置)を上から順に手がかり語の値とする。観測全体(前後の空白を除く)が
/// 秘密の値の形(`is_secret_like`)の間だけ続ける(日本語の「未設定」や見出しで終わる)。
fn column_secrets(lines: &[Line], cells: &[usize], has_own_value: &[bool]) -> Vec<Match> {
    let mut found = Vec::new();
    for &pos in cells {
        let text = lines[pos].as_str();
        let range = trimmed_range(text);
        let Some(value) = text.get(range.clone()) else {
            break;
        };
        if !is_secret_like(value) || has_own_value[pos] || is_label_only(value) {
            break;
        }
        if let Some(m) = lines[pos].to_match(range, MatchDetail::LabeledSecret) {
            found.push(m);
        }
    }
    found
}

/// URL とそのクエリ(バイト範囲)。スキーム付きの URL と、スキームの無いパスだけの URL を左から順に返す。
fn find_urls(text: &str) -> Vec<(Range<usize>, Option<Range<usize>>)> {
    let mut urls: Vec<(Range<usize>, Option<Range<usize>>)> = Vec::new();
    for m in URL.find_iter(text) {
        if urls.last().is_some_and(|(url, _)| m.start() < url.end) {
            continue;
        }
        let url = m.start()..extend_across_space(text, m.end());
        // `://` の後(ホストの先頭)から `?` を探す
        let host = text.get(url.clone()).and_then(|u| u.find("://")).map_or(url.start, |p| url.start + p + 3);
        let query = query_of(text, &url, host);
        urls.push((url, query));
    }
    for caps in PATH_URL.captures_iter(text) {
        let Some(m) = caps.get(1) else {
            continue;
        };
        let url = m.start()..extend_across_space(text, m.end());
        if overlaps_any(&url, &urls.iter().map(|(u, _)| u.clone()).collect::<Vec<_>>()) {
            continue;
        }
        let query = query_of(text, &url, url.start);
        urls.push((url, query));
    }
    urls.sort_by_key(|(url, _)| url.start);
    urls
}

/// URL の後に空白 1 つを挟んで `=` か `?` を含む ASCII の塊が続くなら、読み取りで入った空白とみなして
/// URL の続きにする(何か所でも)。続けた後の終わりの位置を返す。
fn extend_across_space(text: &str, mut end: usize) -> usize {
    while text.as_bytes().get(end) == Some(&b' ') {
        let len = text.get(end + 1..).map_or(0, ascii_chunk_len);
        if len == 0 || !text.get(end + 1..end + 1 + len).is_some_and(|chunk| chunk.contains(['=', '?'])) {
            break;
        }
        end += 1 + len;
    }
    end
}

/// URL のクエリ(バイト範囲)。`from`(ホストまたはパスの先頭)以降の最初の `?` から URL の終わりまで。
/// `?` の後が空なら `None`。`?` が無ければ誤読とみなし、最初の `/` より後の最初の `=` の前のキー
/// (英字・`_`)と、その直前の 1 文字(`/` 以外。誤読された `?`)からをクエリとする。
fn query_of(text: &str, url: &Range<usize>, from: usize) -> Option<Range<usize>> {
    let body = text.get(from..url.end)?;
    if let Some(q) = body.find('?') {
        let start = from + q;
        return (start + 1 < url.end).then_some(start..url.end);
    }
    let slash = from + body.find('/')?;
    let eq = slash + text.get(slash..url.end)?.find('=')?;
    let key_start = text
        .get(slash + 1..eq)?
        .rfind(|c: char| !(c.is_ascii_alphabetic() || c == '_'))
        .map_or(slash + 1, |p| slash + 1 + p + 1);
    if key_start == eq {
        return None;
    }
    let start = if key_start > slash + 1 { key_start - 1 } else { key_start };
    Some(start..url.end)
}

/// 先頭から続く ASCII の記号・英数字(空白を除く)のバイト数。
fn ascii_chunk_len(text: &str) -> usize {
    text.bytes().take_while(|b| (0x21..=0x7e).contains(b)).count()
}

/// 接頭辞付きトークン(バイト範囲)。URL の中は対象外。本体の後に空白 1 つずつを挟んで続く塊も本体に含める。
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
        while let Some(next) = chunk_after_single_space(text, end) {
            let Some(next_text) = text.get(next.clone()) else {
                break;
            };
            if !continues_chunk(next_text) || TOKEN_PREFIXES.iter().any(|p| next_text.starts_with(p)) {
                break;
            }
            end = next.end;
        }
        // 本体の末尾の `]`・`|`(`l`・`I` の誤読)。続く空白の後の塊は上で見ているので、ここでは 1 文字だけ
        if matches!(text.as_bytes().get(end), Some(b']' | b'|')) {
            end += 1;
        }
        let Some(body_text) = text.get(body.start()..end) else {
            continue;
        };
        // 本体は英字と数字を含むか、英字だけでも大文字・小文字の切り替わりが多いこと(数字の無いランダムな本体)
        let random_body = is_token_like(body_text) || class_changes(body_text) >= MIN_CLASS_CHANGES;
        if non_space_len(body_text) >= MIN_PREFIXED_BODY_LEN && random_body {
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
        // 空白 1 つずつで続く塊を最後まで集め、ランダム列になる最も長いつながりを採る
        let mut last = i;
        while let Some(next) = chunks.get(last + 1) {
            let current = &chunks[last];
            let single_space = next.start == current.end + 1 && text.as_bytes().get(current.end) == Some(&b' ');
            let continues = |r: &Range<usize>| text.get(r.clone()).is_some_and(continues_chunk);
            if !(single_space && continues(current) && continues(next)) {
                break;
            }
            last += 1;
        }
        match (i..=last).rev().find(|&j| text.get(chunks[i].start..chunks[j].end).is_some_and(is_random)) {
            Some(j) => {
                found.push(chunks[i].start..chunks[j].end);
                i = j + 1;
            }
            None => i += 1,
        }
    }
    found
}

/// 空白をまたいで列の続きとみなす塊か(英字と数字を両方含む、または大文字・小文字・数字の切り替わりが多い)。
fn continues_chunk(text: &str) -> bool {
    is_token_like(text) || class_changes(text) >= MIN_CONTINUATION_CHANGES
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
            if !accepted {
                return None;
            }
            // `key=value;key=value` の形(接続文字列)では `;` の手前で値を終える
            let mut end = value.end();
            if sep.as_str().contains('=') {
                if let Some(semicolon) = value.as_str().find(';') {
                    end = value.start() + semicolon;
                    if end == value.start() {
                        return None;
                    }
                    return Some(value.start()..end);
                }
            }
            // 値の途中に読み取りで入った空白: 続く塊が英数字と英字以外(数字・記号)を含み、次のキーでない
            while text.as_bytes().get(end) == Some(&b' ') {
                let len = text.get(end + 1..).map_or(0, ascii_chunk_len);
                let Some(next) = text.get(end + 1..end + 1 + len) else {
                    break;
                };
                let continues = next.bytes().any(|b| b.is_ascii_alphanumeric())
                    && next.bytes().any(|b| !b.is_ascii_alphabetic())
                    && !next.contains([':', '=']);
                if !continues {
                    break;
                }
                end += 1 + next.len();
            }
            // 末尾の開き括弧(続く日本語の注記の始まり。「604918(毎月…」)は値に含めない
            let end = value.start() + text.get(value.start()..end)?.trim_end_matches(['(', '[', '{', '<']).len();
            (end > value.start()).then_some(value.start()..end)
        })
        .collect()
}

/// 接続文字列・URL の利用者情報の中のパスワード(バイト範囲)。
fn find_userinfo_passwords(text: &str) -> Vec<Range<usize>> {
    USERINFO_PASSWORD.captures_iter(text).filter_map(|caps| caps.name("password").map(|m| m.range())).collect()
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
/// 16〜19 文字は、数字と英字を 3 つ以上ずつ含むときだけ。
fn is_random(text: &str) -> bool {
    let len = non_space_len(text);
    let digits = text.bytes().filter(u8::is_ascii_digit).count();
    let letters = text.bytes().filter(u8::is_ascii_alphabetic).count();
    let long_enough = len >= MIN_RANDOM_LEN
        || (len >= MIN_SHORT_RANDOM_LEN && digits >= MIN_SHORT_RANDOM_EACH && letters >= MIN_SHORT_RANDOM_EACH);
    long_enough && is_token_like(text) && class_changes(text) >= MIN_CLASS_CHANGES
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

    /// 英小文字・英大文字だけが混ざった決定論的な列(数字を含まない)。
    fn letters(seed: usize, len: usize) -> String {
        (0..len).map(|i| char::from(ALPHABET[(seed + i * 7) % 52])).collect()
    }

    #[test]
    fn 本体が英字だけでも大文字小文字の切り替わりが多ければ接頭辞付きトークンとする() {
        let body = letters(3, 24);
        for prefix in ["rk_live_", "sk_test_", "ghp_"] {
            let line = format!("{prefix}{body}");
            assert_eq!(prefixed(&line), vec![whole(&line)], "case {}", prefix.len());
        }
    }

    #[test]
    fn 区切りのある接頭辞は大文字小文字の誤読を許す() {
        // 「sk_live_」が「sk_Live_」と読まれた形(区切り `_`・`-` を含む接頭辞だけ。AKIA などは区別する)
        let body = mixed(5, 24);
        for prefix in ["sk_Live_", "RK_LIVE_", "Glpat-"] {
            let line = format!("{prefix}{body}");
            assert_eq!(prefixed(&line), vec![whole(&line)], "case {}", prefix.len());
        }
        let line = format!("akia{}", mixed(5, 16).to_uppercase());
        assert!(prefixed(&line).is_empty());
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
    fn 十五文字以下と数字の少ない十九文字以下は対象外() {
        assert!(random(&mixed(3, 15)).is_empty());
        // 数字が 1〜2 個の大文字始まりの語の連なり(プログラムの識別子など)
        assert!(random("ConfigLoader2Value").is_empty());
        assert!(random("Html5Parser2Options").is_empty());
    }

    #[test]
    fn 十六から十九文字は数字と英字を3つ以上ずつ含めば検出する() {
        for text in [mixed(3, 19), hex(16), mixed(5, 17)] {
            assert_eq!(random(&text), vec![whole(&text)], "case {}", text.len());
        }
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
    fn 認証系の一般的な手がかり語の後の値を検出する() {
        let value = secret_value();
        let cases = [
            format!("PIN: {value}"),
            format!("PIN {value}"),
            format!("passcode={value}"),
            format!("passphrase: {value}"),
            format!("OTP {value}"),
            format!("Bearer {value}"),
            format!("private key: {value}"),
            format!("access_key={value}"),
            format!("API キー {value}"),
            format!("credentials: {value}"),
            format!("暗証番号 {value}"),
            format!("パスコード：{value}"),
            format!("ワンタイムパスワード {value}"),
            format!("認証コード {value}"),
            format!("確認コード: {value}"),
            format!("セキュリティコード {value}"),
            format!("シークレット: {value}"),
            format!("秘密鍵 {value}"),
            format!("アクセスキー {value}"),
            format!("APIキー: {value}"),
            format!("トークン {value}"),
        ];
        for line in &cases {
            assert_eq!(labeled(line), vec![span(line, &value)], "case {}", line.len());
        }
    }

    #[test]
    fn 手がかり語と値の間の助詞を許す() {
        let value = secret_value();
        for line in [format!("暗証番号は {value} です"), format!("パスワードは{value}"), format!("認証コードが {value}")] {
            assert_eq!(labeled(&line), vec![span(&line, &value)], "case {}", line.len());
        }
    }

    #[test]
    fn 復旧コードやワンタイムコードなどの手がかり語の後の値を検出する() {
        let value = secret_value();
        for key in [
            "Recovery code",
            "Backup code",
            "Verification code",
            "One-time code",
            "Auth code",
            "Activation code",
            "Invite code",
            "Temp password",
            "SMTP password",
            "passcode",
        ] {
            let line = format!("{key}: {value}");
            assert_eq!(labeled(&line), vec![span(&line, &value)], "case {}", key.len());
            let line = format!("{key} {value}");
            assert_eq!(labeled(&line), vec![span(&line, &value)], "case {}", key.len());
        }
        for key in ["解錠コード", "解除コード", "招待コード", "復旧コード", "リカバリーコード", "バックアップコード", "承認コード", "認証番号", "確認番号", "ワンタイムパスワード"] {
            let line = format!("{key}は{value}です");
            assert_eq!(labeled(&line), vec![span(&line, &value)], "case {}", key.len());
        }
        let line = "5 階会議室の解錠コードは604918(毎月1日に変更)";
        assert_eq!(labeled(line), vec![span(line, "604918")]);
    }

    #[test]
    fn パスワードの半濁点が濁点に読まれた見出しの列の値を検出する() {
        // 「パ」→「バ」の誤読(半濁点・濁点の取り違えは読み取りで一般的)
        let values = [mixed(3, 12), secret_value()];
        let refs: Vec<&str> = values.iter().map(String::as_str).collect();
        let page = header_table(["サービス", "バスワード", "備考"], &refs);
        assert_eq!(detect_page(&page, MatchDetail::LabeledSecret).len(), 2);
    }

    #[test]
    fn 接続文字列の中のパスワードを検出する() {
        let pw = secret_value().replace('#', "!");
        let cases = [
            format!("postgres://app:{pw}@db.example.com:5432/app"),
            format!("DATABASE_URL=mysql://root:{pw}@localhost/main"),
            format!("Server=db.example.com;User Id=sa;Password={pw};Encrypt=true"),
            format!("host=db.example.com user=app password={pw} sslmode=require"),
        ];
        for line in &cases {
            assert!(labeled(line).contains(&span(line, &pw)), "case {}", line.len());
        }
        // 利用者名だけで `:` の後が無い・`@` が無いものは対象外
        for line in ["https://user@example.com/path", "ssh://git.example.com:22/repo"] {
            assert!(labeled(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 一般化したコードの手がかり語でも値でないものは対象外() {
        for line in ["Postal code 123-4567", "QR code 2", "Source code 2024", "Recovery code sent", "Promo code"] {
            assert!(labeled(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 一般化した手がかり語でも値でないものは対象外() {
        let cases = [
            "Pin to top",          // 値が英字だけ
            "shipping: free",      // 手がかり語の一部(pin)を含む別の語
            "spinner 12",          // 語の一部
            "OTP sent",            // 値が英字だけ
            "トークンの有効期限",  // 値が無い
            "認証コードを送信しました",
        ];
        for line in cases {
            assert!(labeled(line).is_empty(), "case {}", line.len());
        }
    }

    #[test]
    fn 認証系のラベルだけの観測の右隣を値とする() {
        let value = secret_value();
        for label in ["管理者 PIN", "署名シークレット", "パスコード", "Access key", "秘密鍵:"] {
            let page = GridPage::new(&[(label, LEFT_CELL), (&value, RIGHT_CELL)]);
            assert_eq!(
                detect_page(&page, MatchDetail::LabeledSecret),
                vec![Match::new(1, whole(&value), MatchDetail::LabeledSecret)],
                "case {}",
                label.len()
            );
        }
    }

    #[test]
    fn ラベルの右隣や直下が秘密の値の形でなければ値にしない() {
        // 画面の見出し・メニューの「API キー」の下に並ぶ項目名や日本語の見出しは値にしない
        for value in ["Webhook", "名前", "abc", "Settings"] {
            let page = FakePage::new(&["API キー", value]);
            assert!(detect_page(&page, MatchDetail::LabeledSecret).is_empty(), "case {}", value.len());
        }
        // 数字・記号を含むか、大文字・小文字の切り替わりが 2 回以上あれば値とする
        for value in ["Zd56aQw7bY", "hunter-2", "xQpLmRtw"] {
            let page = FakePage::new(&["パスワード", value]);
            assert_eq!(
                detect_page(&page, MatchDetail::LabeledSecret),
                vec![Match::new(1, whole(value), MatchDetail::LabeledSecret)],
                "case {}",
                value.len()
            );
        }
    }

    #[test]
    fn 画面の端まで離れた右隣は値にしない() {
        // サイドバーの項目と表の右端の列のように、同じ高さでも離れた観測は別の領域
        let value = secret_value();
        let page = GridPage::new(&[("API キー", (0.01, 0.5, 0.03, 0.013)), (&value, (0.84, 0.5, 0.05, 0.013))]);
        assert!(detect_page(&page, MatchDetail::LabeledSecret).is_empty());
    }

    /// 表の見出しの行(3 列)と、2 列目の下に並ぶ値。
    fn header_table(headers: [&str; 3], values: &[&str]) -> GridPage {
        let mut cells: Vec<(&str, Cell)> = headers
            .iter()
            .enumerate()
            .map(|(i, h)| (*h, (0.1 + 0.3 * i as f64, 0.8, 0.12, 0.03)))
            .collect();
        for (row, value) in values.iter().enumerate() {
            cells.push((value, (0.37, 0.75 - 0.05 * row as f64, 0.2, 0.03)));
        }
        GridPage::new(&cells)
    }

    #[test]
    fn 表の見出しにだけ手がかり語がある列の値を検出する() {
        let values = [mixed(3, 12), mixed(11, 14), secret_value()];
        let refs: Vec<&str> = values.iter().map(String::as_str).collect();
        let page = header_table(["連携先", "署名シークレット", "状態"], &refs);
        let expected: Vec<Match> = values
            .iter()
            .enumerate()
            .map(|(i, v)| Match::new(3 + i, whole(v), MatchDetail::LabeledSecret))
            .collect();
        assert_eq!(detect_page(&page, MatchDetail::LabeledSecret), expected);
    }

    #[test]
    fn 表の見出しの列は日本語の値か離れた観測で終わる() {
        let value = mixed(3, 12);
        let page = header_table(["連携先", "パスワード", "状態"], &[&value, "未設定", "abc"]);
        assert_eq!(detect_page(&page, MatchDetail::LabeledSecret), vec![Match::new(3, whole(&value), MatchDetail::LabeledSecret)]);
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

    #[test]
    fn urlの途中に読み取りで入った空白をまたいでクエリを返す() {
        // クエリの途中の空白
        let query = "?lang=j a&user=8812";
        let line = format!("参考:https://docs.example.com/guide{query}");
        assert_eq!(url_query(&line), vec![span(&line, query)]);
        // パスの途中の空白(続きの塊が `?` を含む)
        let query = "?state=x8Kd02&prompt=consent";
        let line = format!("https://app.example.com/ callback{query}");
        assert_eq!(url_query(&line), vec![span(&line, query)]);
        // `=`・`?` を含まない続きは URL に含めない
        let line = "https://example.com/a?b=1 and more";
        assert_eq!(url_query(line), vec![span(line, "?b=1")]);
        assert!(url_query("https://example.com/path next").is_empty());
    }

    #[test]
    fn urlのはてなが誤読されたらキーの直前の1文字からをクエリとする() {
        // `?` が数字に読まれた形(`/i/1043?c=...` → `/i/10437c=...`)
        let line = "https://pay.example.com/i/10437c=C00918273&h=9fa1";
        assert_eq!(url_query(line), vec![span(line, "7c=C00918273&h=9fa1")]);
        // ホストの中の `=` やパスの無い URL は対象外のまま
        assert!(url_query("https://example.com").is_empty());
        assert!(url_query("https://example.com/=").is_empty());
    }

    #[test]
    fn スキームの無いパスのクエリを検出する() {
        let query = "?from=2026-09-01&key=Hn4wT9";
        let line = format!("2026-10-09T09:12:04Z INFO GET /export{query} 200");
        assert_eq!(url_query(&line), vec![span(&line, query)]);
        // `?` か `=` が無いパス、語の途中から始まるパスは対象外
        for line in ["GET /export 200", "GET /export?all 200", "例: example.com/a?b=1"] {
            assert!(url_query(line).is_empty());
        }
    }

    #[test]
    fn トークンの途中の空白が複数か所でも1件として検出する() {
        let line = format!("{}{} {} {}", TOKEN_PREFIXES[7], mixed(3, 6), mixed(5, 10), mixed(7, 12));
        assert_eq!(prefixed(&line), vec![whole(&line)]);
        // 接頭辞の直後に空白が入り、本体が短く分かれた形
        let line = format!("{}{} {}", TOKEN_PREFIXES[7], mixed(3, 2), mixed(5, 30));
        assert_eq!(prefixed(&line), vec![whole(&line)]);
    }

    #[test]
    fn トークンとランダム列の末尾の誤読された1文字を含める() {
        let line = format!("{}{}]", TOKEN_PREFIXES[7], mixed(3, 20));
        assert_eq!(prefixed(&line), vec![whole(&line)]);
        let line = format!("{}| {}", mixed(3, 16), mixed(5, 10));
        assert_eq!(random(&line), vec![whole(&line)]);
    }

    #[test]
    fn ランダム列の続きは大文字小文字の切り替わりの多い塊も含める() {
        // 英字だけでも大文字・小文字が 2 回以上切り替わる塊は続きとみなす
        let line = format!("{} xYz abC_DeF", mixed(3, 17));
        assert_eq!(random(&line), vec![whole(&line)]);
        // 普通の単語(切り替わり 1 回以下)は含めない
        let value = mixed(3, 24);
        let line = format!("{value} Hello world");
        assert_eq!(random(&line), vec![span(&line, &value)]);
    }

    #[test]
    fn 手がかり語の値の途中に読み取りで入った空白をまたぐ() {
        let head = mixed(2, 7);
        let line = format!("password: {head} XYZ&");
        assert_eq!(labeled(&line), vec![span(&line, &format!("{head} XYZ&"))]);
        // 英字だけの語・次のキー・記号だけの塊は含めない
        let value = secret_value();
        for tail in [" next", " DB_HOST=x1", " (初回)", " :"] {
            let line = format!("password: {value}{tail}");
            assert_eq!(labeled(&line), vec![span(&line, &value)]);
        }
    }

    // ---- UTF-16 範囲 ----

    #[test]
    fn 全角の行でutf16範囲が正しい() {
        // 全角の英数字・コロンは正規化してから判定し、範囲は正規化前の位置で返す
        let line = "パスワード：ａｂｃ１２３＃";
        assert_eq!(labeled(line), vec![span(line, "ａｂｃ１２３＃")]);
    }

    // ---- 多バイト文字の境界(AM-T25-F2。切り出しを `str::get` にした箇所の回帰) ----

    #[test]
    fn 絵文字や結合文字に隣り合ってもurlのクエリの範囲は変わらない() {
        // URL の後の空白の続き(`extend_across_space`)・クエリの切り出し(`query_of`)
        let cases = [
            ("https://example.com/a?id=1 😀=b", "?id=1"),
            ("😀https://example.com/a?id=1&k=v", "?id=1&k=v"),
            ("https://example.com/a?id=1 x=2\u{3099}", "?id=1 x=2"),
        ];
        for (line, expected) in cases {
            assert_eq!(url_query(line), vec![span(line, expected)], "case {}", line.len());
        }
    }

    #[test]
    fn 絵文字に隣り合っても手がかり語の値の範囲は変わらない() {
        // 値の後の空白の続き(`labeled_values` の `ascii_chunk_len`)
        let value = secret_value();
        let line = format!("password: {value} 😀");
        assert_eq!(labeled(&line), vec![span(&line, &value)]);
    }
}
