//! 手がかり語・接頭辞・敬称・会社の種類などの定数と、埋め込み辞書の読み込み(ARCH_auto-masking §5.3)。
//! ①連絡先(AM-T11)・②認証情報(AM-T14)の定数を置く。他の種類の定数は各検出器のタスクで足す。

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
