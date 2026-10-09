//! 機密情報の自動マスキング(ARCH_auto-masking §3〜§5)。
//!
//! ベース画像の PNG を受け取り、文字の読み取り(`ocr`)→ 候補の検出(`detect`)→ 矩形の確定
//! (`geometry`)までを端末内・メモリだけで行い、`Vec<MaskCandidate>` を返す。webview へ返るのは
//! 矩形と種類だけで、読み取った文字列はこのモジュールの外へ出さない(NFR-002)。
//!
//! - 外から使うのは `scan()`(AM-T18)・`MaskCandidate`・`MaskKind`・`ScanError` だけ(`pub(crate)`)。
//!   それ以外の型・関数は `pub` を付けず、このモジュールと子モジュールの中だけで使う(ARCH §3.3)
//! - 検出側(`detect`・`text`・`layout`・`geometry`)は Vision に依存しない。読み取りの結果は
//!   `RecognizedPage` トレイト越しに受け取る(既存の `CaptureProvider` と同じ作法、ARCH §3.2)
//! - このモジュールでは標準出力・標準エラー・ログへの出力を一切しない。テストの失敗メッセージにも文字列を出さない
//!
//! 子モジュールの `mod` 宣言はすべてここ(AM-T04)で済ませ、後続タスクが `mod.rs` を取り合わないようにする。

mod detect;
#[cfg(test)]
mod eval;
mod geometry;
mod layout;
#[cfg(target_os = "macos")]
mod ocr;
mod png;
/// `SensitiveText`(`Debug` を伏せ字にする)、全角→半角の 1 対 1 正規化、UTF-16 位置の対応。
///
/// `text.rs` には内側のドキュメントコメント(`//!`)を置かない。`SensitiveText` が `Display` を
/// 実装していないことを確かめるドキュメントテストが、`text.rs` を `include!` で取り込むため
/// (内側の属性は `include!` の中に書けない)。
mod text;

use std::ops::Range;

use serde::Serialize;

use png::ImageSize;
use text::SensitiveText;

/// webview へ返す候補 1 件。座標は画像の実ピクセル(整数・左上原点・余白込み・画像範囲内)。
///
/// IPC の戻り値の形(ARCH §5.4)そのもの。文字列を持たせない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct MaskCandidate {
    pub(crate) x: u32,
    pub(crate) y: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) kind: MaskKind,
}

/// 候補の種類(4 種)。JSON では小文字の `"contact" | "credential" | "identifier" | "financial"`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MaskKind {
    /// ①連絡先(メール・電話番号・住所)
    Contact,
    /// ②認証情報(トークン・パスワードの値・URL のクエリ等)
    Credential,
    /// ③識別子(手がかり語付きの番号・人名・会社名)
    Identifier,
    /// ④金額・口座(カード番号・口座番号・通貨付きの金額)
    Financial,
}

/// 読み取りの失敗。原因の詳細(入力の一部・`NSError` の説明文など)は持たせない(ARCH §12)。
///
/// IPC へは `commands::scan_sensitive_text` が固定文字列 `text_scan_failed` に変換する(AM-T18)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScanError {
    /// PNG として解釈できない(署名違い・IHDR の不正・途中で切れている・幅/高さが 0)
    InvalidPng,
    /// 本文のサイズか、幅/高さが上限を超えている
    ImageTooLarge,
    /// Vision の読み取りに失敗した(AM-T10)
    RecognitionFailed,
}

/// 画像上の領域。Vision の正規化座標(0.0〜1.0・**左下原点**)のまま持つ。
/// ピクセル(左上原点)への変換は `geometry`(AM-T09)が行う。
#[derive(Debug, Clone, Copy, PartialEq)]
struct NormalizedRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// 文字の読み取り結果(1 ページ分)。検出側はこのトレイト越しにだけ結果を読む。
///
/// 本物は `ocr::VisionPage`(AM-T10)、テストでは文字幅を等分した偽物を使う(AM-T11)。
/// 行の番号は `0..line_count()`。範囲外の番号は渡さない(呼び出し側が保証する)。
trait RecognizedPage {
    /// 行(Vision の観測)の数。
    fn line_count(&self) -> usize;
    /// 行の文字列。正規化前の読み取り結果そのもの。
    fn line_text(&self, line: usize) -> &SensitiveText;
    /// 行全体の領域。
    fn line_box(&self, line: usize) -> NormalizedRect;
    /// 行の一部(UTF-16 単位の範囲)の領域。求められなければ `None`。
    fn range_box(&self, line: usize, range: Range<usize>) -> Option<NormalizedRect>;
}

/// 検出の細分(ARCH §5.3 の表の「細分」)。評価(AM-T19)で細分ごとに集計するために持つ。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum MatchDetail {
    Email,
    Phone,
    Address,
    PrefixedToken,
    RandomString,
    LabeledSecret,
    UrlQuery,
    LabeledNumber,
    PersonName,
    CompanyName,
    CardNumber,
    AccountNumber,
    Amount,
}

impl MatchDetail {
    /// 細分が属する種類。
    fn kind(self) -> MaskKind {
        match self {
            Self::Email | Self::Phone | Self::Address => MaskKind::Contact,
            Self::PrefixedToken | Self::RandomString | Self::LabeledSecret | Self::UrlQuery => {
                MaskKind::Credential
            }
            Self::LabeledNumber | Self::PersonName | Self::CompanyName => MaskKind::Identifier,
            Self::CardNumber | Self::AccountNumber | Self::Amount => MaskKind::Financial,
        }
    }
}

/// 検出器の結果 1 件。文字列は持たず、行の番号と UTF-16 単位の範囲だけを持つ。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Match {
    /// `RecognizedPage` の行の番号
    line: usize,
    /// 行の中の範囲(UTF-16 単位。Vision の `NSRange` と同じ単位)
    range: Range<usize>,
    kind: MaskKind,
    detail: MatchDetail,
}

impl Match {
    /// `kind` は `detail` から決める(種類と細分の食い違いを作らせない)。
    fn new(line: usize, range: Range<usize>, detail: MatchDetail) -> Self {
        Self { line, range, kind: detail.kind(), detail }
    }
}

/// ベース画像の PNG から機密情報の候補を読み取る(ARCH §7.1 手順 5)。
///
/// `png::validate` を必ず先に行い、形・大きさが不正なら Vision を呼ばずに失敗する。続けて
/// `ocr::recognize` → `scan_page`(検出 → 矩形の確定 → 重複除去)を 1 つの `autoreleasepool` の中で
/// 済ませる。読み取った文字列と Vision のオブジェクト(`VisionPage`)はここを抜けるときにすべて破棄され、
/// 戻り値は矩形と種類だけ(ARCH §12)。`VisionPage` は `Send` でないので、呼び出し側は 1 つのスレッド
/// (`spawn_blocking` の中)でこの関数を最後まで実行する。
pub(crate) fn scan(png: &[u8]) -> Result<Vec<MaskCandidate>, ScanError> {
    let size = png::validate(png)?;
    recognize_and_detect(png, size)
}

/// PNG の幅・高さ(IHDR)。経過時間の記録(`commands.rs`、ARCH §12)に画像の大きさだけを載せるために使う。
/// 形・大きさが不正なら `None`。画像は展開しない(チャンクの見出しをたどるだけ)。
pub(crate) fn image_size(png: &[u8]) -> Option<(u32, u32)> {
    png::validate(png).ok().map(|size| (size.width, size.height))
}

/// `scan()` の読み取り以降(macOS: Vision)。
#[cfg(target_os = "macos")]
fn recognize_and_detect(png: &[u8], size: ImageSize) -> Result<Vec<MaskCandidate>, ScanError> {
    objc2::rc::autoreleasepool(|_| {
        let page = ocr::recognize(png)?;
        Ok(scan_page(&page, size))
    })
}

/// `scan()` の読み取り以降(macOS 以外: 文字の読み取りの手段が無いので常に失敗する)。
#[cfg(not(target_os = "macos"))]
fn recognize_and_detect(_png: &[u8], _size: ImageSize) -> Result<Vec<MaskCandidate>, ScanError> {
    Err(ScanError::RecognitionFailed)
}

/// 読み取り結果 1 ページから候補の矩形を確定する(`detect::run` → `range_box` → `geometry`)。
///
/// 各 `Match` の部分範囲の領域を `to_pixel_rect` でピクセルにし、その行全体の高さに比例した余白を
/// `pad_and_clip` で足して画像範囲に収め、最後に `dedupe` で包含・ほぼ同一の矩形をまとめる。
/// 部分範囲の領域が求められない `Match`・画像の外に出て何も残らない矩形は捨てる。
/// Vision に依存しないので、偽物のページでテストできる。
fn scan_page(page: &dyn RecognizedPage, size: ImageSize) -> Vec<MaskCandidate> {
    let candidates = detect::run(page)
        .into_iter()
        .filter_map(|m| {
            let part = page.range_box(m.line, m.range.clone())?;
            let line_height = geometry::to_pixel_rect(page.line_box(m.line), size).height();
            geometry::pad_and_clip(geometry::to_pixel_rect(part, size), line_height, size, m.kind)
        })
        .collect();
    geometry::dedupe(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_candidateはjsonで数値とkindだけを持つ() {
        let candidate = MaskCandidate { x: 1, y: 2, width: 30, height: 40, kind: MaskKind::Contact };
        let json = serde_json::to_string(&candidate).expect("シリアライズに失敗した");
        assert_eq!(json, r#"{"x":1,"y":2,"width":30,"height":40,"kind":"contact"}"#);
    }

    #[test]
    fn mask_kindはjsonで小文字の4種になる() {
        let cases = [
            (MaskKind::Contact, "\"contact\""),
            (MaskKind::Credential, "\"credential\""),
            (MaskKind::Identifier, "\"identifier\""),
            (MaskKind::Financial, "\"financial\""),
        ];
        for (kind, expected) in cases {
            let json = serde_json::to_string(&kind).expect("シリアライズに失敗した");
            assert_eq!(json, expected);
        }
    }

    #[test]
    fn scan_errorのdebugは変種名だけで入力を含まない() {
        let cases = [
            (ScanError::InvalidPng, "InvalidPng"),
            (ScanError::ImageTooLarge, "ImageTooLarge"),
            (ScanError::RecognitionFailed, "RecognitionFailed"),
        ];
        for (err, expected) in cases {
            assert_eq!(format!("{err:?}"), expected);
        }
    }

    #[test]
    fn 細分はarchの表どおりの種類に属する() {
        use MatchDetail::*;
        let cases = [
            (Email, MaskKind::Contact),
            (Phone, MaskKind::Contact),
            (Address, MaskKind::Contact),
            (PrefixedToken, MaskKind::Credential),
            (RandomString, MaskKind::Credential),
            (LabeledSecret, MaskKind::Credential),
            (UrlQuery, MaskKind::Credential),
            (LabeledNumber, MaskKind::Identifier),
            (PersonName, MaskKind::Identifier),
            (CompanyName, MaskKind::Identifier),
            (CardNumber, MaskKind::Financial),
            (AccountNumber, MaskKind::Financial),
            (Amount, MaskKind::Financial),
        ];
        for (detail, kind) in cases {
            assert_eq!(detail.kind(), kind, "{detail:?}");
        }
    }

    #[test]
    fn matchの種類は細分から決まる() {
        let m = Match::new(3, 2..9, MatchDetail::CardNumber);
        assert_eq!(m.line, 3);
        assert_eq!(m.range, 2..9);
        assert_eq!(m.detail, MatchDetail::CardNumber);
        assert_eq!(m.kind, MaskKind::Financial);
    }

    /// 1 行だけの偽物のページ。`RecognizedPage` を `&dyn` で使えること(オブジェクト安全)を確かめる。
    struct OneLinePage {
        text: SensitiveText,
    }

    impl RecognizedPage for OneLinePage {
        fn line_count(&self) -> usize {
            1
        }
        fn line_text(&self, _line: usize) -> &SensitiveText {
            &self.text
        }
        fn line_box(&self, _line: usize) -> NormalizedRect {
            NormalizedRect { x: 0.1, y: 0.5, width: 0.8, height: 0.1 }
        }
        fn range_box(&self, _line: usize, range: Range<usize>) -> Option<NormalizedRect> {
            // 4 文字の行を等分する(UTF-16 単位)
            let unit = 0.8 / 4.0;
            Some(NormalizedRect {
                x: 0.1 + unit * range.start as f64,
                y: 0.5,
                width: unit * range.len() as f64,
                height: 0.1,
            })
        }
    }

    // ---- scan_page(AM-T18)----

    use super::detect::fake::FakePage;

    /// 偽物のページの 0 行目(20 文字)。メールアドレスは UTF-16 の 5..20。
    const MAIL_LINE: &str = "Mail abc@example.com";
    const SIZE_1000: ImageSize = ImageSize { width: 1000, height: 1000 };

    #[test]
    fn scan_pageは偽物のページから余白込みの矩形と種類を返す() {
        // 偽物のページ: 行は左端 0.05・幅 0.9・高さ 0.04、0 行目の上端は 0.01(左上原点)。
        // 1000x1000 では 0 行目が y=10..50(高さ 40 → 余白 max(2, 40×0.25)=10)、
        // 20 文字の等分で 1 文字 45px なので、5..20 は x=275..950。
        let page = FakePage::new(&[MAIL_LINE, "plain words only here"]);
        let candidates = scan_page(&page, SIZE_1000);
        assert_eq!(
            candidates,
            vec![MaskCandidate { x: 265, y: 0, width: 695, height: 60, kind: MaskKind::Contact }]
        );
    }

    #[test]
    fn scan_pageの矩形は画像の範囲に収まる() {
        // 100x100 では 0 行目が y=1..5(高さ 4 → 余白 2)。上は -1 になるので 0 に収める。
        let size = ImageSize { width: 100, height: 100 };
        let page = FakePage::new(&[MAIL_LINE]);
        let candidates = scan_page(&page, size);
        assert_eq!(candidates.len(), 1);
        let c = candidates[0];
        assert_eq!((c.y, c.height), (0, 7));
        assert!(c.width >= 1 && c.height >= 1);
        assert!(c.x + c.width <= size.width && c.y + c.height <= size.height);
    }

    /// 全行を 0 行目と同じ位置に重ねる偽物のページ。同じ矩形の重複除去を確かめる。
    struct StackedPage(FakePage);

    impl RecognizedPage for StackedPage {
        fn line_count(&self) -> usize {
            self.0.line_count()
        }
        fn line_text(&self, line: usize) -> &SensitiveText {
            self.0.line_text(line)
        }
        fn line_box(&self, _line: usize) -> NormalizedRect {
            self.0.line_box(0)
        }
        fn range_box(&self, line: usize, range: Range<usize>) -> Option<NormalizedRect> {
            let part = self.0.range_box(line, range)?;
            Some(NormalizedRect { y: self.0.line_box(0).y, ..part })
        }
    }

    #[test]
    fn scan_pageは重なった同じ矩形を1つにまとめる() {
        let page = StackedPage(FakePage::new(&[MAIL_LINE, MAIL_LINE, MAIL_LINE]));
        let candidates = scan_page(&page, SIZE_1000);
        assert_eq!(
            candidates,
            vec![MaskCandidate { x: 265, y: 0, width: 695, height: 60, kind: MaskKind::Contact }]
        );
    }

    #[test]
    fn scan_pageは何も見つからなければ空を返す() {
        let page = FakePage::new(&["plain words only here", "nothing to hide"]);
        assert!(scan_page(&page, SIZE_1000).is_empty());
        let empty = FakePage::new(&[]);
        assert!(scan_page(&empty, SIZE_1000).is_empty());
    }

    #[test]
    fn scan_pageの戻り値のjsonは数値の4キーとkindだけを持つ() {
        let page = FakePage::new(&[MAIL_LINE, "plain words only here"]);
        let candidates = scan_page(&page, SIZE_1000);
        assert!(!candidates.is_empty());
        let json = serde_json::to_value(&candidates).expect("シリアライズに失敗した");
        let items = json.as_array().expect("配列でない");
        for item in items {
            let object = item.as_object().expect("オブジェクトでない");
            let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(keys, ["height", "kind", "width", "x", "y"]);
            for key in ["x", "y", "width", "height"] {
                assert!(object[key].is_u64(), "{key} が整数でない");
            }
            assert!(object["kind"].is_string());
        }
    }

    #[test]
    fn scanはpngでない入力を読み取りの前に弾く() {
        // `png::validate` が先に走るので、Vision を呼ばずに失敗する(通常の `cargo test` で走る)
        assert_eq!(scan(b"not a png"), Err(ScanError::InvalidPng));
        assert_eq!(scan(b""), Err(ScanError::InvalidPng));
    }

    /// 架空データの評価画像(AM-T05)。
    fn fixture_png(name: &str) -> Vec<u8> {
        let path = format!("{}/../eval/masking/images/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read(path).expect("評価画像を読めなかった")
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "実機の Vision を使う(macOS)"]
    fn scanは評価画像から画像の内側の候補を1件以上返す() {
        let png = fixture_png("billing.fhd.light.png");
        let size = png::validate(&png).expect("評価画像が PNG でない");
        let candidates = scan(&png).expect("読み取りに失敗した");
        assert!(!candidates.is_empty(), "候補が 0 件");
        for (i, c) in candidates.iter().enumerate() {
            assert!(c.width >= 1 && c.height >= 1, "候補 {i} が空");
            assert!(c.x + c.width <= size.width, "候補 {i} が右にはみ出す");
            assert!(c.y + c.height <= size.height, "候補 {i} が下にはみ出す");
        }
    }

    #[test]
    fn scanは途中で切れたpngをvisionへ渡さず失敗にする() {
        let png = fixture_png("billing.fhd.light.png");
        assert_eq!(scan(&png[..png.len() / 2]), Err(ScanError::InvalidPng));
    }

    #[test]
    fn recognized_pageはdynで使える() {
        let page = OneLinePage { text: SensitiveText::new("abcd".to_string()) };
        let page: &dyn RecognizedPage = &page;
        assert_eq!(page.line_count(), 1);
        assert_eq!(page.line_text(0).as_str().chars().count(), 4);
        assert_eq!(page.line_box(0).width, 0.8);
        let part = page.range_box(0, 1..3).expect("範囲の領域が求められなかった");
        assert!((part.x - 0.3).abs() < 1e-9);
        assert!((part.width - 0.4).abs() < 1e-9);
    }
}
