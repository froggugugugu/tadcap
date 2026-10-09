//! Vision の呼び出し(`objc2-vision`)。`RecognizedPage` を実装し、`autoreleasepool` の中で完結させる
//! (ARCH_auto-masking §5.1)。macOS 専用。
//!
//! - 設定は精度優先(`Accurate`)・言語 `ja-JP` → `en-US`・言語補正は既定オフ(ARCH §1.4・§5.3)
//! - 行ごとに文字列(`SensitiveText`)・行の領域・`VNRecognizedText` を持ち、部分範囲の領域
//!   (`boundingBoxForRange:error:`)は `VNRecognizedText` が生きている間に `range_box` で求める
//! - Vision を呼ぶ箇所は `autoreleasepool` で包み、Objective-C 側の一時オブジェクトをその場で解放する。
//!   さらに `objc2::exception::catch` で包み、Objective-C の例外を `ScanError::RecognitionFailed` に変換する
//!   (ARCH §12)。例外・`NSError` の中身は読まずに捨てる(説明文に入力の一部が入りうるため)
//! - `VisionPage` は `Send` ではない(`Retained` を持つため)。`scan()` の 1 スレッドの中だけで使い、
//!   使い終えたら破棄する(状態・キャッシュに残さない。ARCH §12)

use std::ops::Range;
use std::panic::AssertUnwindSafe;

use objc2::exception;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2::AllocAnyThread;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSRange, NSString};
use objc2_vision::{
    VNImageOption, VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedText, VNRequest,
    VNRequestTextRecognitionLevel,
};

use super::text::SensitiveText;
use super::{NormalizedRect, RecognizedPage, ScanError};

/// 読み取りの言語(優先順)。日本語を先に置く(ARCH §1.4)。
const RECOGNITION_LANGUAGES: [&str; 2] = ["ja-JP", "en-US"];

/// 言語補正を使うか。既定はオフ(速く、トークン・番号を辞書の語へ寄せない)。評価(AM-T19)で決める。
pub(super) const USES_LANGUAGE_CORRECTION: bool = false;

/// 1 行(Vision の観測 1 件)の読み取り結果。
struct VisionLine {
    /// 第 1 候補の文字列
    text: SensitiveText,
    /// 行全体の領域(観測の `boundingBox`)
    bounds: NormalizedRect,
    /// 文字列の長さ(UTF-16 単位。`NSString::length`。Vision の `NSRange` と同じ単位)
    utf16_len: usize,
    /// 部分範囲の領域を求めるために持ち続ける第 1 候補
    candidate: Retained<VNRecognizedText>,
}

/// Vision の読み取り結果 1 ページ分。
pub(super) struct VisionPage {
    lines: Vec<VisionLine>,
}

impl RecognizedPage for VisionPage {
    fn line_count(&self) -> usize {
        self.lines.len()
    }

    fn line_text(&self, line: usize) -> &SensitiveText {
        &self.lines[line].text
    }

    fn line_box(&self, line: usize) -> NormalizedRect {
        self.lines[line].bounds
    }

    fn range_box(&self, line: usize, range: Range<usize>) -> Option<NormalizedRect> {
        let line = self.lines.get(line)?;
        if range.is_empty() || range.end > line.utf16_len {
            return None;
        }
        let ns_range = NSRange::new(range.start, range.len());
        let candidate = &line.candidate;
        autoreleasepool(|_| {
            exception::catch(AssertUnwindSafe(|| {
                // SAFETY: `candidate` は `self` が持つ `Retained` で、この呼び出しの間は生きている。
                // 範囲は上で文字列の内側(UTF-16 単位・空でない)に限っている。`VNRecognizedText` は
                // 読み取り専用で、`VisionPage` が `Send` でないため生成したスレッドからだけ呼ばれる。
                let observation = unsafe { candidate.boundingBoxForRange_error(ns_range) }.ok()?;
                // SAFETY: `observation` は直前に受け取った `Retained` で、この式の間は生きている。
                // `boundingBox` は値(`CGRect`)を返すだけの読み取り専用のプロパティ。
                to_normalized(unsafe { observation.boundingBox() })
            }))
            .ok()
            .flatten()
        })
    }
}

/// PNG のバイト列を Vision で読み取る。
///
/// PNG の形・大きさの確認(`png::validate`)は呼び出し側(`scan()`)が先に行う前提。
/// Vision の失敗・例外はすべて `ScanError::RecognitionFailed` にする(原因の詳細は持たせない)。
pub(super) fn recognize(png: &[u8]) -> Result<VisionPage, ScanError> {
    autoreleasepool(|_| {
        exception::catch(AssertUnwindSafe(|| perform(png)))
            .unwrap_or(Err(ScanError::RecognitionFailed))
    })
}

/// Vision の要求を作って同期で実行し、行ごとの結果を集める。
fn perform(png: &[u8]) -> Result<VisionPage, ScanError> {
    let data = NSData::with_bytes(png);
    let options = NSDictionary::<VNImageOption, AnyObject>::new();
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &options,
    );

    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    let languages: Vec<Retained<NSString>> =
        RECOGNITION_LANGUAGES.iter().map(|lang| NSString::from_str(lang)).collect();
    request.setRecognitionLanguages(&NSArray::from_retained_slice(&languages));
    request.setUsesLanguageCorrection(USES_LANGUAGE_CORRECTION);

    let as_request: &VNRequest = &request;
    let requests = NSArray::from_slice(&[as_request]);
    // `performRequests` は要求を終えるまで戻らない(同期)。`NSError` の中身は捨てる。
    handler.performRequests_error(&requests).map_err(|_| ScanError::RecognitionFailed)?;

    let Some(observations) = request.results() else {
        return Err(ScanError::RecognitionFailed);
    };
    let mut lines = Vec::with_capacity(observations.count());
    for observation in observations.iter() {
        let Some(candidate) = observation.topCandidates(1).firstObject() else {
            continue;
        };
        let string = candidate.string();
        let utf16_len = string.length();
        if utf16_len == 0 {
            continue;
        }
        // SAFETY: `observation` は `results()` の配列から取り出した `Retained` で、この式の間は生きている。
        // `boundingBox` は値(`CGRect`)を返すだけの読み取り専用のプロパティ。
        let Some(bounds) = to_normalized(unsafe { observation.boundingBox() }) else {
            continue;
        };
        lines.push(VisionLine {
            text: SensitiveText::new(string.to_string()),
            bounds,
            utf16_len,
            candidate,
        });
    }
    Ok(VisionPage { lines })
}

/// Vision の `CGRect`(正規化座標・左下原点)を `NormalizedRect` にする。有限でない・負の大きさなら `None`。
fn to_normalized(rect: objc2_core_foundation::CGRect) -> Option<NormalizedRect> {
    let r = NormalizedRect {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width,
        height: rect.size.height,
    };
    let finite = [r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite());
    (finite && r.width >= 0.0 && r.height >= 0.0).then_some(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 架空データの評価画像(AM-T05。明るいテーマのフル HD)。
    fn fixture_png() -> Vec<u8> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../eval/masking/images/billing.fhd.light.png");
        std::fs::read(path).expect("評価画像を読めなかった")
    }

    /// 正規化座標の矩形が画像(0.0〜1.0)の内側にあるか。Vision の誤差を `EPS` だけ許す。
    fn is_inside_unit(r: NormalizedRect) -> bool {
        const EPS: f64 = 1e-6;
        r.width >= 0.0
            && r.height >= 0.0
            && r.x >= -EPS
            && r.y >= -EPS
            && r.x + r.width <= 1.0 + EPS
            && r.y + r.height <= 1.0 + EPS
    }

    /// `inner` が `outer` の内側にあるか。部分範囲の領域は「UI 用で厳密ではない」ため `tol` だけ許す。
    fn is_inside(inner: NormalizedRect, outer: NormalizedRect, tol: f64) -> bool {
        inner.x >= outer.x - tol
            && inner.y >= outer.y - tol
            && inner.x + inner.width <= outer.x + outer.width + tol
            && inner.y + inner.height <= outer.y + outer.height + tol
    }

    fn utf16_len(page: &VisionPage, line: usize) -> usize {
        page.line_text(line).as_str().encode_utf16().count()
    }

    #[test]
    #[ignore = "実機の Vision を使う(macOS)"]
    fn 評価画像から1行以上読み取り各行の領域が画像の内側にある() {
        let page = recognize(&fixture_png()).expect("読み取りに失敗した");
        assert!(page.line_count() >= 1, "行の数: {}", page.line_count());
        for line in 0..page.line_count() {
            assert!(is_inside_unit(page.line_box(line)), "行 {line} の領域が画像の外");
            assert!(utf16_len(&page, line) > 0, "行 {line} が空");
        }
    }

    #[test]
    #[ignore = "実機の Vision を使う(macOS)"]
    fn 部分範囲の領域は行の領域の内側にある() {
        let page = recognize(&fixture_png()).expect("読み取りに失敗した");
        let mut checked = 0;
        for line in 0..page.line_count() {
            let len = utf16_len(&page, line);
            if len < 2 {
                continue;
            }
            let outer = page.line_box(line);
            let tol = outer.height * 0.5;
            for range in [0..len / 2, len / 2..len, 0..len] {
                let part = page
                    .range_box(line, range.clone())
                    .unwrap_or_else(|| panic!("行 {line} の範囲 {range:?} の領域が求められなかった"));
                assert!(is_inside_unit(part), "行 {line} の範囲 {range:?} が画像の外");
                assert!(is_inside(part, outer, tol), "行 {line} の範囲 {range:?} が行の外");
            }
            checked += 1;
        }
        assert!(checked >= 1, "確かめた行が無い");
    }

    #[test]
    #[ignore = "実機の Vision を使う(macOS)"]
    fn 行の外の範囲と空の範囲はnoneになる() {
        let page = recognize(&fixture_png()).expect("読み取りに失敗した");
        assert!(page.line_count() >= 1);
        let len = utf16_len(&page, 0);
        assert!(page.range_box(0, 0..len + 1).is_none(), "行より長い範囲");
        assert!(page.range_box(0, len..len + 1).is_none(), "行の末尾より後ろ");
        assert!(page.range_box(0, 0..0).is_none(), "空の範囲");
    }

    #[test]
    #[ignore = "実機の Vision を使う(macOS)"]
    fn pngでないバイト列はscan_errorになりパニックしない() {
        let cases: [&[u8]; 3] = [b"", b"not a png", &[0u8; 64]];
        for (i, bytes) in cases.iter().enumerate() {
            let result = recognize(bytes);
            assert!(matches!(result, Err(ScanError::RecognitionFailed)), "ケース {i}");
        }
    }

    /// 途中で切れた PNG は Vision が途中まで解読して結果を返すことがある(実機で確認)。
    /// 切れた入力を弾くのは `scan()` の `png::validate` の役目なので、ここではパニックしないことだけを見る。
    #[test]
    #[ignore = "実機の Vision を使う(macOS)"]
    fn 途中で切れたpngでもパニックしない() {
        let png = fixture_png();
        for cut in [16, 64, png.len() / 2] {
            match recognize(&png[..cut]) {
                Ok(page) => {
                    for line in 0..page.line_count() {
                        assert!(is_inside_unit(page.line_box(line)), "{cut} バイト: 行 {line} が画像の外");
                    }
                }
                Err(err) => assert_eq!(err, ScanError::RecognitionFailed, "{cut} バイト"),
            }
        }
    }
}
