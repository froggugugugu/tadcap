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

/// ②認証情報: 英字の手がかり語(大文字・小文字を区別しない)。`KEY=VALUE` のキーに含まれる場合も手がかりとする
/// (`DB_PASSWORD`・`client_secret` など)。部分一致で別の語に当たらない語だけを置く。
/// 「passphrase」「passcode」は `pass` に含まれる。「credential」は 2026-10-09 の一般化で追加。
pub(super) const CREDENTIAL_CUES_ASCII: [&str; 6] = ["password", "pass", "pwd", "secret", "token", "credential"];

/// ②認証情報: 「〜 key」の形の手がかり(正規表現の断片)。間の空白・`_`・`-` の有無を許す。
/// 「api key」に加え、鍵の種類として一般的な access・private・secret・signing・license を置く(2026-10-09 の一般化)。
pub(super) const API_KEY_CUE_PATTERN: &str = r"(?:api|access|private|secret|signing|license)[\x20_\-]?key";

/// ②認証情報: 語として独立しているときだけ手がかりにする英字の語(大文字・小文字を区別しない)。
/// 部分一致にすると別の語(`shipping` の `pin` など)に当たるため、キーの一部としては扱わない(2026-10-09 の一般化)。
pub(super) const CREDENTIAL_WORD_CUES_ASCII: [&str; 4] = ["pin", "otp", "bearer", "mfa"];

/// ②認証情報: 日本語の手がかり語。比較前に行と同じ `normalize` を通す(長音 `ー` は `-` になる)。
/// 認証に使う値の一般的な呼び名を体系的に置く(2026-10-09 の一般化。評価画像の語を足したものではない)。
pub(super) const CREDENTIAL_CUES_JA: [&str; 16] = [
    "パスワード",
    "暗証番号",
    "パスコード",
    "パスフレーズ",
    "ワンタイムコード",
    "認証コード",
    "確認コード",
    "セキュリティコード",
    "シークレット",
    "秘密鍵",
    "アクセスキー",
    "APIキー",
    "API キー",
    "認証キー",
    "トークン",
    "合言葉",
];

/// ②・③: 手がかり語と値の間に入る助詞(「会員番号は 12345」「暗証番号が …」)。
pub(super) const CUE_PARTICLES: [&str; 3] = ["は", "が", "も"];

/// ③識別子: 手がかり語付きの番号の日本語の手がかり語は「対象 + 番号の語」の組み合わせで作る(2026-10-09 の一般化)。
/// 対象は業務画面で番号が振られる一般的なもの(取引・契約・人・受付)。比較前に行と同じ `normalize` を通す。
pub(super) const CUED_NUMBER_SUBJECTS_JA: [&str; 31] = [
    // 取引
    "注文", "受注", "発注", "契約", "請求", "請求書", "見積", "伝票", "取引", "案件",
    // 問い合わせ・受付
    "問い合わせ", "問合せ", "問合わせ", "お問い合わせ", "受付", "予約", "申込", "申し込み", "管理", "整理",
    // 人・組織
    "会員", "登録", "取引先", "顧客", "お客様", "患者", "社員", "職員", "従業員", "利用者", "ユーザー",
];

/// ③識別子: 日本語の対象の後に付く番号の語。対象との間の空白 1 つを許し、大文字・小文字を区別しない。
/// 比較前に `normalize` を通す。`No.` の `.` と `#` は語の一部として扱う(値との間の区切りが無くてよい)。
pub(super) const CUED_NUMBER_KINDS_JA: [&str; 7] = ["番号", "No.", "No", "ID", "コード", "CD", "#"];

/// ③識別子: 英字の対象(正規表現の断片・大文字小文字を区別しない)。後に番号の語(`CUED_NUMBER_KINDS_ASCII`)が要る。
pub(super) const CUED_NUMBER_SUBJECTS_ASCII: [&str; 18] = [
    "order", "invoice", "account", "acct", "customer", "client", "member", "membership", "employee", "staff",
    "ticket", "case", "contract", "booking", "reservation", "reference", "patient", "registration",
];

/// ③識別子: 英字の対象の後に付く番号の語(正規表現の断片)。間の空白・`_`・`-` の有無を許す。
pub(super) const CUED_NUMBER_KINDS_ASCII: &str = r"(?:[\x20_\-]?(?:number|num|no\.|no|id)|\x20?#)";

/// ③識別子: 対象の無い英字の手がかり(正規表現の断片・大文字小文字を区別しない)。
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

/// ③識別子(会社名): 日本語の会社・法人の種類。前後に続く名前の列と合わせて会社名とする。
/// 比較前に行と同じ `normalize` を通す(全角の括弧は半角になる)。㈱・㈲は 1 文字のまま。
/// 会社法の会社に加え、法人格の種類(一般・公益法人、医療・福祉・学校・NPO・独立行政法人、士業の法人)と
/// その略称を置く(2026-10-09 の一般化)。銀行・信用金庫などの業態名は会社の種類ではないので置かない。
pub(super) const COMPANY_TYPES_JA: [&str; 39] = [
    "株式会社", "有限会社", "合同会社", "合資会社", "合名会社", "相互会社", "(株)", "(有)", "(同)", "(資)", "㈱", "㈲",
    "一般社団法人", "一般財団法人", "公益社団法人", "公益財団法人", "医療法人社団", "医療法人財団", "医療法人",
    "社会福祉法人", "学校法人", "NPO法人", "特定非営利活動法人", "独立行政法人", "国立研究開発法人", "宗教法人",
    "弁護士法人", "税理士法人", "監査法人", "司法書士法人", "行政書士法人", "社会保険労務士法人",
    "(一社)", "(一財)", "(公社)", "(公財)", "(医)", "(社福)", "(特非)",
];

/// ③識別子(会社名): 会社の種類の直後に来ると名前ではないとみなすひらがな(助詞)。
pub(super) const COMPANY_NAME_PARTICLES: [char; 9] = ['の', 'は', 'が', 'を', 'に', 'で', 'と', 'も', 'へ'];

/// ③識別子(会社名): 英字の会社の種類(正規表現の断片・大文字小文字を区別する)。前に大文字始まりの語が要る。
/// 長いものを先に書く。`.` の有無・`Co.,` と `Ltd` の間の空白の有無・末尾の `.` が `,` と読まれた形を許す。
/// 英米の略称に加え、欧州・アジアで一般的な法人の種類(GmbH・AG・S.A.・B.V.・N.V.・Pte. Ltd.・Pty Ltd・PLC・LLP など)と
/// 略さない形(Corporation・Incorporated・Limited)を置く(2026-10-09 の一般化)。2 文字の語は誤検出を避けて AG だけ。
pub(super) const COMPANY_SUFFIXES_ASCII: [&str; 20] = [
    r"Co\.?\x20?,?\x20?Ltd\b[.,]?",
    r"Pte\.?\x20Ltd\b[.,]?",
    r"Pty\.?\x20Ltd\b[.,]?",
    r"Sdn\.?\x20Bhd\b[.,]?",
    r"Corporation\b",
    r"Incorporated\b",
    r"Limited\b",
    r"Inc\b[.,]?",
    r"Ltd\b[.,]?",
    r"LLC\b",
    r"LLP\b",
    r"PLC\b",
    r"Corp\b[.,]?",
    r"GmbH\b",
    r"AG\b",
    r"S\.A\.(?:S\.)?",
    r"S\.p\.A\.",
    r"S\.r\.l\.",
    r"B\.V\.",
    r"N\.V\.",
];

/// ③識別子(会社名): 値が会社名になる日本語のラベル。比較前に `normalize` を通す。長いものを先に書く。
pub(super) const COMPANY_LABELS_JA: [&str; 3] = ["会社名", "勤務先", "社名"];

/// ③識別子(会社名): 値が会社名になる英字のラベル(大文字・小文字を区別しない)。
pub(super) const COMPANY_LABELS_ASCII: [&str; 1] = ["company"];

/// ①連絡先(英語の住所): 通りの種類(正規表現の断片・大文字小文字を区別する)。略称の後の `.` は任意。
/// 米英で一般的な種類を置く(2026-10-09 の一般化)。
pub(super) const STREET_SUFFIXES: [&str; 30] = [
    "Street", "St", "Avenue", "Ave", "Road", "Rd", "Boulevard", "Blvd", "Lane", "Ln", "Drive", "Dr", "Way", "Court", "Ct",
    "Place", "Pl", "Square", "Sq", "Parkway", "Pkwy", "Highway", "Hwy", "Terrace", "Ter", "Circle", "Cir", "Trail",
    "Crescent", "Plaza",
];

/// ①連絡先(英語の住所): 米国の州・特別区の 2 文字の略称(「市, 州 郵便番号」の行の判定に使う)。
pub(super) const US_STATE_CODES: [&str; 51] = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
    "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
    "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
];

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
