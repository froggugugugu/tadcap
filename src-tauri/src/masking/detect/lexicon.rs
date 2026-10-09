//! 手がかり語・接頭辞・敬称・会社の種類などの定数と、埋め込み辞書の読み込み(ARCH_auto-masking §5.3)。
//! ①連絡先(AM-T11)・②認証情報(AM-T14)・③手がかり語付きの番号と④金額・口座(AM-T16)・③人名(AM-T21)・
//! ③会社名と①住所(AM-T22)の定数を置く。
//!
//! 辞書(`../lexicon/*.txt`)は `include_str!` でバイナリに埋め込み、実行時に何も読まない・取得しない。
//! 中身は承認済みの報告書(`output/reports/security/SECURITY_auto-masking-lexicon_*.md`)の SHA-256 とバイト一致させる。

use std::collections::HashSet;
use std::sync::LazyLock;

/// 郵便番号の前に付く記号。
pub(super) const POSTAL_MARK: char = '〒';

/// 日本の国番号(`+81` の数字部分)。
pub(super) const JP_COUNTRY_CODE: &str = "81";

/// 11 桁になる番号の先頭(国内表記)。携帯・PHS(070・080・090)、IP 電話(050)、
/// M2M 等(020)、フリーダイヤルの 0800。これ以外の `0` 始まりは 10 桁(固定・0120・0570 等)。
pub(super) const ELEVEN_DIGIT_PHONE_PREFIXES: [&str; 6] = ["020", "050", "070", "080", "090", "0800"];

/// ②認証情報: 接頭辞付きトークンの接頭辞(大文字・小文字を区別する)。製品名・サービス名は書かない。
/// 評価用画像の接頭辞の一覧(`eval/masking/pages/fixture.js` の `PREFIXES`)をすべて含める。
pub(super) const TOKEN_PREFIXES: [&str; 21] = [
    "sk_live_", "sk_test_", "rk_live_", "rk_test_", "pk_live_", "pk_test_", "sk-proj-", "ghp_", "gho_", "ghu_",
    "ghs_", "ghr_", "github_pat_", "glpat-", "xoxb-", "xoxp-", "AKIA", "AIza", "npm_", "hf_", "SG.",
];

/// ②認証情報: 英字の手がかり語(大文字・小文字を区別しない)。`KEY=VALUE` のキーに含まれる場合も手がかりとする。
pub(super) const CREDENTIAL_CUES_ASCII: [&str; 5] = ["password", "pass", "pwd", "secret", "token"];

/// ②認証情報: 「api key」の手がかり(正規表現の断片)。間の空白・`_`・`-` の有無を許す。
pub(super) const API_KEY_CUE_PATTERN: &str = r"api[\x20_\-]?key";

/// ②認証情報: 日本語の手がかり語。
pub(super) const CREDENTIAL_CUES_JA: [&str; 2] = ["パスワード", "暗証番号"];

/// ③識別子: 手がかり語付きの番号の日本語の手がかり語。比較前に行と同じ `normalize` を通す。
pub(super) const CUED_NUMBER_CUES_JA: [&str; 6] = ["社員番号", "社員ID", "顧客番号", "顧客ID", "会員番号", "お客様番号"];

/// ③識別子: 手がかり語付きの番号の英字の手がかり(正規表現の断片・大文字小文字を区別しない)。
/// 「User ID」は間の空白・`_`・`-` の有無を許す。長いものを先に書く。
pub(super) const CUED_NUMBER_CUES_ASCII: [&str; 2] = [r"user[\x20_\-]?id", "id"];

/// ④金額・口座: 口座番号の手がかり語。比較前に行と同じ `normalize` を通す。
pub(super) const ACCOUNT_CUES: [&str; 4] = ["口座番号", "口座", "普通", "当座"];

/// ④金額・口座: 口座番号の前に付く預金の種類(「普通」「普通預金」など)。比較前に `normalize` を通す。
pub(super) const ACCOUNT_TYPES: [&str; 2] = ["普通", "当座"];

/// ④金額・口座: 預金の種類の後に続く語(「普通預金」)。
pub(super) const ACCOUNT_TYPE_SUFFIX: &str = "預金";

/// ④金額・口座: 数値の前に付く通貨記号・単位。全角の `￥` `＄` は `normalize` で `¥`(U+00A5)・`$` になる。
pub(super) const CURRENCY_PREFIXES: [&str; 4] = ["\u{a5}", "$", "USD", "JPY"];

/// ④金額・口座: 数値の後に付く通貨の単位。「円」の前の「万」「億」「千」は金額の一部とする。
pub(super) const CURRENCY_SUFFIXES: [&str; 3] = ["円", "USD", "JPY"];

/// ④金額・口座: 「円」の前に付く数の単位。
pub(super) const YEN_MULTIPLIERS: [&str; 3] = ["千", "万", "億"];

/// ③識別子(人名): 名前の後に付く敬称。直前のかな漢字列を人名とする。
pub(super) const HONORIFICS: [&str; 4] = ["様", "さん", "氏", "殿"];

/// ③識別子(人名): 敬称の直前に来ても人名ではない語(「お客様」「皆さん」「仕様」「同様」など)。
pub(super) const HONORIFIC_NON_NAMES: [&str; 12] =
    ["客", "皆", "みな", "みんな", "仕", "同", "模", "多", "異", "一", "各", "両"];

/// ③識別子(人名): 値が人名になる日本語のラベル。比較前に行と同じ `normalize` を通す。長いものを先に書く。
/// 「ログイン中」は画面上部の利用者名の表示(AM-T23)。
pub(super) const PERSON_LABELS_JA: [&str; 7] = ["ログイン中", "担当者", "差出人", "氏名", "名前", "担当", "宛名"];

/// ③識別子(人名): 表の見出しなら下に並ぶ値を人名とするラベル(AM-T23)。比較前に `normalize` を通す。
/// 「名前」「Name」は人以外(キー・ファイルなど)の名前の列にも使われるため含めない。
pub(super) const PERSON_COLUMN_LABELS_JA: [&str; 3] = ["担当者", "氏名", "担当"];

/// ③識別子(人名): 値が人名になる英字のラベル(大文字・小文字を区別しない)。「contact」は AM-T23 で追加。
pub(super) const PERSON_LABELS_ASCII: [&str; 2] = ["contact", "name"];

/// ③識別子(人名): 英字の人名の前に付く敬称・呼びかけ(正規表現の断片・大文字小文字を区別する)。
pub(super) const ENGLISH_NAME_TITLES: [&str; 4] = [r"Mrs\.?", r"Mr\.?", r"Ms\.?", "Dear"];

/// ③識別子(人名): 読点(`,`)を挟んで英字の人名の前に付く挨拶(大文字・小文字を区別しない。AM-T23)。
pub(super) const ENGLISH_NAME_GREETINGS: [&str; 3] = ["welcome", "hello", "hi"];

/// ③識別子(会社名): 日本語の会社の種類。前後に続く名前の列と合わせて会社名とする。
/// 比較前に行と同じ `normalize` を通す(全角の括弧は半角になる)。㈱・㈲は 1 文字のまま。
pub(super) const COMPANY_TYPES_JA: [&str; 10] =
    ["株式会社", "有限会社", "合同会社", "合資会社", "合名会社", "(株)", "(有)", "(同)", "㈱", "㈲"];

/// ③識別子(会社名): 会社の種類の直後に来ると名前ではないとみなすひらがな(助詞)。
pub(super) const COMPANY_NAME_PARTICLES: [char; 9] = ['の', 'は', 'が', 'を', 'に', 'で', 'と', 'も', 'へ'];

/// ③識別子(会社名): 英字の会社の種類(正規表現の断片・大文字小文字を区別する)。前に大文字始まりの語が要る。
/// 長いものを先に書く。`.` の有無・`Co.,` と `Ltd` の間の空白の有無・末尾の `.` が `,` と読まれた形を許す。
pub(super) const COMPANY_SUFFIXES_ASCII: [&str; 5] =
    [r"Co\.?\x20?,?\x20?Ltd\b[.,]?", r"Inc\b[.,]?", r"Ltd\b[.,]?", r"LLC\b", r"Corp\b[.,]?"];

/// ③識別子(会社名): 値が会社名になる日本語のラベル。比較前に `normalize` を通す。長いものを先に書く。
pub(super) const COMPANY_LABELS_JA: [&str; 3] = ["会社名", "勤務先", "社名"];

/// ③識別子(会社名): 値が会社名になる英字のラベル(大文字・小文字を区別しない)。
pub(super) const COMPANY_LABELS_ASCII: [&str; 1] = ["company"];

/// ①連絡先(住所): 郵便番号の前に付くラベル。郵便番号だけの行の判定に使う。
pub(super) const POSTAL_LABELS: [&str; 1] = ["郵便番号"];

/// 埋め込み辞書の 1 行 1 語を読む。`#` で始まる行(由来の注記)と空行を飛ばし、前後の空白を除く。
fn lexicon_words(text: &'static str) -> HashSet<&'static str> {
    text.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')).collect()
}

/// 日本の姓(漢字)。1 字の姓は手がかり語なしの規則では使わない(SECURITY_auto-masking-lexicon の決定 #2)。
pub(super) static SURNAMES_JA: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| lexicon_words(include_str!("../lexicon/surnames-ja.txt")));

/// 日本の姓のローマ字(小文字)。
pub(super) static SURNAMES_ROMAJI: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| lexicon_words(include_str!("../lexicon/surnames-romaji.txt")));

/// 日本の名のローマ字(小文字)。
pub(super) static GIVEN_NAMES_ROMAJI: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| lexicon_words(include_str!("../lexicon/given-names-romaji.txt")));

/// 都道府県(47 件)。①住所の規則(都道府県名で始まる行の残り)で使う。
pub(super) static PREFECTURES: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| lexicon_words(include_str!("../lexicon/prefectures.txt")));

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{lexicon_words, GIVEN_NAMES_ROMAJI, PREFECTURES, SURNAMES_JA, SURNAMES_ROMAJI};

    // 失敗時に辞書の語を表示しないよう、比較は件数・真偽値だけで行う。

    #[test]
    fn 辞書の件数が承認済みの報告書の値と一致する() {
        // SECURITY_auto-masking-lexicon_2026-10-09_1303.md の語数(先頭の注記行を除く)
        assert_eq!(SURNAMES_JA.len(), 767);
        assert_eq!(SURNAMES_ROMAJI.len(), 835);
        assert_eq!(GIVEN_NAMES_ROMAJI.len(), 408);
        assert_eq!(PREFECTURES.len(), 47);
    }

    #[test]
    fn 注記の行と空行を飛ばし前後の空白を除く() {
        let words = lexicon_words("# 由来の注記\n\n  alpha \nbeta\n\n");
        assert!(words == HashSet::from(["alpha", "beta"]), "読み込んだ語が期待と違う");
    }

    #[test]
    fn 辞書の語の文字種と長さが報告書の上限に収まる() {
        let all = [&*SURNAMES_JA, &*SURNAMES_ROMAJI, &*GIVEN_NAMES_ROMAJI, &*PREFECTURES];
        assert!(all.iter().all(|words| words.iter().all(|w| !w.is_empty() && !w.starts_with('#'))));
        assert!(SURNAMES_JA.iter().all(|w| (1..=4).contains(&w.chars().count())));
        for words in [&*SURNAMES_ROMAJI, &*GIVEN_NAMES_ROMAJI] {
            assert!(words.iter().all(|w| w.len() <= 16 && w.bytes().all(|b| b.is_ascii_lowercase())));
        }
        assert!(PREFECTURES.iter().all(|w| ["都", "道", "府", "県"].iter().any(|s| w.ends_with(s))));
    }

    #[test]
    fn 一字の姓を含む() {
        // 1 字の姓は辞書に残し、敬称・ラベルの規則では使う(手がかり語なしの規則でだけ除く)
        assert!(SURNAMES_JA.iter().any(|w| w.chars().count() == 1));
    }
}
