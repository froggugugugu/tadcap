//! Vision の正規化座標(左下原点)→ 画像のピクセル(左上原点)の変換、余白、画像範囲への収め、
//! 重複の除去(ARCH_auto-masking §5.3)。
//!
//! 流れ: `to_pixel_rect()`(外側へ丸める)→ `pad_and_clip()`(余白を足して画像範囲に収め、
//! `MaskCandidate` にする)→ `dedupe()`(包含・ほぼ同一の矩形をまとめる)。
//! 文字列は扱わない(矩形と種類だけ)。

use super::png::ImageSize;
use super::{MaskCandidate, MaskKind, NormalizedRect};

/// 余白の下限(ピクセル)。ARCH §5.3 の `max(2px, 行の高さ × 係数)` の `2px`。
pub(super) const MIN_PADDING_PX: i64 = 2;
/// 余白の行の高さに対する係数。ARCH §5.3 の【仮定】`0.2` を AM-T19 の評価で `0.25` に決めた
/// (形が決まっているものの検出率は 0.2〜0.3 で同じ、0.175 以下で下がる。境目から余裕を取る)。
pub(super) const PADDING_RATIO: f64 = 0.25;
/// 「ほぼ同じ矩形」とみなす重なりの割合(IoU = 共通部分 / 和集合)を分数で持つ(90%)。
/// 整数の面積で比べ、浮動小数の誤差を持ち込まない。
const NEAR_SAME_NUMERATOR: u64 = 9;
const NEAR_SAME_DENOMINATOR: u64 = 10;
/// 浮動小数の掛け算で生じる誤差(例: `0.3 * 10 = 3.0000000000000004`)で 1px 広がらないための許容幅。
const ROUNDING_EPSILON: f64 = 1e-6;

/// 画像のピクセル上の矩形(左上原点)。`right`・`bottom` は含まない端。
///
/// 余白を足す前・画像範囲に収める前の値なので、負の値や画像の外を取りうる(`i64`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PixelRect {
    pub(super) left: i64,
    pub(super) top: i64,
    pub(super) right: i64,
    pub(super) bottom: i64,
}

impl PixelRect {
    pub(super) fn width(&self) -> i64 {
        self.right - self.left
    }

    pub(super) fn height(&self) -> i64 {
        self.bottom - self.top
    }

    /// 幅か高さが 0 以下。
    fn is_empty(&self) -> bool {
        self.width() <= 0 || self.height() <= 0
    }
}

/// 正規化座標(0.0〜1.0・左下原点)を画像のピクセル(左上原点)へ変換する。
/// 端は外側へ丸める(左・上は切り捨て、右・下は切り上げ)ので、元の領域を必ず覆う。
pub(super) fn to_pixel_rect(rect: NormalizedRect, size: ImageSize) -> PixelRect {
    let width = f64::from(size.width);
    let height = f64::from(size.height);
    PixelRect {
        left: floor_outward(rect.x * width),
        right: ceil_outward((rect.x + rect.width) * width),
        // 左下原点 → 左上原点: 上端は 1 - (y + h)、下端は 1 - y
        top: floor_outward((1.0 - (rect.y + rect.height)) * height),
        bottom: ceil_outward((1.0 - rect.y) * height),
    }
}

/// 行の高さ(ピクセル)に応じた余白。`max(2px, 行の高さ × PADDING_RATIO)` を整数へ切り上げる。
pub(super) fn padding_for(line_height: i64) -> i64 {
    let scaled = ceil_outward(line_height.max(0) as f64 * PADDING_RATIO);
    scaled.max(MIN_PADDING_PX)
}

/// 候補の矩形に余白を足し、画像範囲に収めて `MaskCandidate` にする。
///
/// `line_height` は候補を含む行(観測)全体のピクセルの高さ。元の矩形の幅か高さが 0、
/// または画像の外に出て何も残らない場合は `None`(捨てる)。
pub(super) fn pad_and_clip(
    rect: PixelRect,
    line_height: i64,
    size: ImageSize,
    kind: MaskKind,
) -> Option<MaskCandidate> {
    if rect.is_empty() {
        return None;
    }
    let pad = padding_for(line_height);
    let image_width = i64::from(size.width);
    let image_height = i64::from(size.height);
    let left = rect.left.saturating_sub(pad).max(0);
    let top = rect.top.saturating_sub(pad).max(0);
    let right = rect.right.saturating_add(pad).min(image_width);
    let bottom = rect.bottom.saturating_add(pad).min(image_height);
    if right <= left || bottom <= top {
        return None;
    }
    Some(MaskCandidate {
        x: u32::try_from(left).ok()?,
        y: u32::try_from(top).ok()?,
        width: u32::try_from(right - left).ok()?,
        height: u32::try_from(bottom - top).ok()?,
        kind,
    })
}

/// 重複の除去(ARCH §5.3)。
///
/// - ほぼ同じ矩形(IoU 90% 以上)は 1 つにまとめる。矩形は両者を覆う外接矩形、種類は
///   「認証情報 > 金額・口座 > 連絡先 > 識別子」の順で優先する
/// - それ以外で、ある矩形が別の矩形に完全に含まれるなら小さい方を捨てる
/// - それ以外の重なりは両方残す(見逃しを避ける)
///
/// 変化がなくなるまで繰り返す。残った候補は入力の順を保つ(まとめた結果は前にある方の位置に置く)。
pub(super) fn dedupe(candidates: Vec<MaskCandidate>) -> Vec<MaskCandidate> {
    let mut items = candidates;
    while let Some(step) = find_reduction(&items) {
        match step {
            Reduction::Merge(i, j) => {
                items[i] = merge(items[i], items[j]);
                items.remove(j);
            }
            Reduction::Drop(k) => {
                items.remove(k);
            }
        }
    }
    items
}

/// `dedupe` の 1 手。添字は `i < j`。
enum Reduction {
    /// `i` と `j` をまとめて `i` に置き、`j` を消す
    Merge(usize, usize),
    /// `k` を消す(別の矩形に含まれている)
    Drop(usize),
}

/// 前から順に組を調べ、最初に見つかった 1 手を返す(決定論的)。ほぼ同一の判定を包含より先に行う。
fn find_reduction(items: &[MaskCandidate]) -> Option<Reduction> {
    for i in 0..items.len() {
        for j in (i + 1)..items.len() {
            let (a, b) = (&items[i], &items[j]);
            if is_near_same(a, b) {
                return Some(Reduction::Merge(i, j));
            }
            if contains(a, b) {
                return Some(Reduction::Drop(j));
            }
            if contains(b, a) {
                return Some(Reduction::Drop(i));
            }
        }
    }
    None
}

fn right_of(c: &MaskCandidate) -> u64 {
    u64::from(c.x) + u64::from(c.width)
}

fn bottom_of(c: &MaskCandidate) -> u64 {
    u64::from(c.y) + u64::from(c.height)
}

fn area(c: &MaskCandidate) -> u64 {
    u64::from(c.width) * u64::from(c.height)
}

fn intersection_area(a: &MaskCandidate, b: &MaskCandidate) -> u64 {
    let left = u64::from(a.x.max(b.x));
    let top = u64::from(a.y.max(b.y));
    let right = right_of(a).min(right_of(b));
    let bottom = bottom_of(a).min(bottom_of(b));
    right.saturating_sub(left) * bottom.saturating_sub(top)
}

/// `outer` が `inner` を完全に含む(端が一致してもよい)。
fn contains(outer: &MaskCandidate, inner: &MaskCandidate) -> bool {
    outer.x <= inner.x
        && outer.y <= inner.y
        && right_of(outer) >= right_of(inner)
        && bottom_of(outer) >= bottom_of(inner)
}

/// IoU(共通部分 / 和集合)が 90% 以上。
fn is_near_same(a: &MaskCandidate, b: &MaskCandidate) -> bool {
    let inter = intersection_area(a, b);
    if inter == 0 {
        return false;
    }
    let union = area(a) + area(b) - inter;
    inter * NEAR_SAME_DENOMINATOR >= union * NEAR_SAME_NUMERATOR
}

/// 2 つを覆う外接矩形に、優先度の高い方の種類を付ける。
fn merge(a: MaskCandidate, b: MaskCandidate) -> MaskCandidate {
    let left = a.x.min(b.x);
    let top = a.y.min(b.y);
    let right = right_of(&a).max(right_of(&b));
    let bottom = bottom_of(&a).max(bottom_of(&b));
    let kind = if priority(b.kind) > priority(a.kind) {
        b.kind
    } else {
        a.kind
    };
    MaskCandidate {
        x: left,
        y: top,
        // 入力はどちらも u32 の範囲に収まった矩形なので、外接矩形の幅・高さも u32 に収まる
        width: u32::try_from(right - u64::from(left)).unwrap_or(u32::MAX),
        height: u32::try_from(bottom - u64::from(top)).unwrap_or(u32::MAX),
        kind,
    }
}

/// 種類の優先度(大きいほど優先)。認証情報 > 金額・口座 > 連絡先 > 識別子。
fn priority(kind: MaskKind) -> u8 {
    match kind {
        MaskKind::Credential => 3,
        MaskKind::Financial => 2,
        MaskKind::Contact => 1,
        MaskKind::Identifier => 0,
    }
}

fn floor_outward(value: f64) -> i64 {
    (value + ROUNDING_EPSILON).floor() as i64
}

fn ceil_outward(value: f64) -> i64 {
    (value - ROUNDING_EPSILON).ceil() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: ImageSize = ImageSize {
        width: 1000,
        height: 500,
    };

    fn norm(x: f64, y: f64, width: f64, height: f64) -> NormalizedRect {
        NormalizedRect {
            x,
            y,
            width,
            height,
        }
    }

    fn px(left: i64, top: i64, right: i64, bottom: i64) -> PixelRect {
        PixelRect {
            left,
            top,
            right,
            bottom,
        }
    }

    fn cand(x: u32, y: u32, width: u32, height: u32, kind: MaskKind) -> MaskCandidate {
        MaskCandidate {
            x,
            y,
            width,
            height,
            kind,
        }
    }

    // ---- 座標の変換 ----

    #[test]
    fn 正規化座標の左下原点を画素の左上原点へ変換する() {
        let rect = to_pixel_rect(norm(0.1, 0.2, 0.3, 0.4), SIZE);
        // 上端 = (1 - 0.6) × 500 = 200、下端 = (1 - 0.2) × 500 = 400
        assert_eq!(rect, px(100, 200, 400, 400));
    }

    #[test]
    fn 画像の下端に接する領域は画素では下端に来る() {
        let rect = to_pixel_rect(norm(0.0, 0.0, 0.5, 0.1), SIZE);
        assert_eq!(rect, px(0, 450, 500, 500));
    }

    #[test]
    fn 端数は外側へ丸める() {
        // 左 123.4 → 123、右 223.4 → 224、上 (1 - 0.3011) × 500 = 349.45 → 349、下 (1 - 0.2011) × 500 = 399.45 → 400
        let rect = to_pixel_rect(norm(0.1234, 0.2011, 0.1, 0.1), SIZE);
        assert_eq!(rect, px(123, 349, 224, 400));
    }

    #[test]
    fn 浮動小数の誤差では1px広げない() {
        // (0.1 + 0.2) × 10 = 3.0000000000000004 だが 3 として扱う
        let rect = to_pixel_rect(
            norm(0.1, 0.0, 0.2, 1.0),
            ImageSize {
                width: 10,
                height: 10,
            },
        );
        assert_eq!((rect.left, rect.right), (1, 3));
        assert_eq!((rect.top, rect.bottom), (0, 10));
    }

    // ---- 余白 ----

    #[test]
    fn 余白は行の高さの25パーセントで下限は2px() {
        assert_eq!(padding_for(0), 2);
        assert_eq!(padding_for(5), 2); // 1.25 → 2(下限と同じ)
        assert_eq!(padding_for(4), 2); // 1.0 → 下限
        assert_eq!(padding_for(12), 3); // 3.0 ちょうどは 4 にしない
        assert_eq!(padding_for(20), 5);
        assert_eq!(padding_for(23), 6); // 5.75 → 切り上げ
    }

    #[test]
    fn 余白を上下左右に足す() {
        let c = pad_and_clip(px(100, 200, 400, 400), 20, SIZE, MaskKind::Contact);
        assert_eq!(c, Some(cand(95, 195, 310, 210, MaskKind::Contact)));
    }

    // ---- 画像範囲への収め ----

    #[test]
    fn 左端と上端の外へ出た分は0に収める() {
        let c = pad_and_clip(px(1, 0, 50, 20), 20, SIZE, MaskKind::Credential);
        assert_eq!(c, Some(cand(0, 0, 55, 25, MaskKind::Credential)));
    }

    #[test]
    fn 右端と下端を超えた分は画像の大きさに収める() {
        let c = pad_and_clip(px(950, 480, 999, 500), 20, SIZE, MaskKind::Financial);
        assert_eq!(c, Some(cand(945, 475, 55, 25, MaskKind::Financial)));
    }

    #[test]
    fn 負の座標から始まる矩形も収める() {
        let c = pad_and_clip(px(-30, -10, 20, 10), 10, SIZE, MaskKind::Contact);
        assert_eq!(c, Some(cand(0, 0, 23, 13, MaskKind::Contact)));
    }

    #[test]
    fn 幅0の矩形は捨てる() {
        assert_eq!(
            pad_and_clip(px(100, 100, 100, 120), 20, SIZE, MaskKind::Contact),
            None
        );
    }

    #[test]
    fn 高さ0の矩形は捨てる() {
        assert_eq!(
            pad_and_clip(px(100, 100, 150, 100), 20, SIZE, MaskKind::Contact),
            None
        );
    }

    #[test]
    fn 正規化で幅0の領域は変換後に捨てられる() {
        let rect = to_pixel_rect(norm(0.5, 0.5, 0.0, 0.1), SIZE);
        assert_eq!(pad_and_clip(rect, 20, SIZE, MaskKind::Contact), None);
    }

    #[test]
    fn 画像の外にしかない矩形は捨てる() {
        assert_eq!(
            pad_and_clip(px(1100, 10, 1200, 30), 20, SIZE, MaskKind::Contact),
            None
        );
        assert_eq!(
            pad_and_clip(px(10, -100, 50, -50), 20, SIZE, MaskKind::Contact),
            None
        );
    }

    // ---- 重複の除去 ----

    #[test]
    fn 完全に含まれる小さい矩形を捨てる() {
        let big = cand(0, 0, 200, 50, MaskKind::Contact);
        let small = cand(10, 10, 50, 20, MaskKind::Identifier);
        assert_eq!(dedupe(vec![small, big]), vec![big]);
        assert_eq!(dedupe(vec![big, small]), vec![big]);
    }

    #[test]
    fn 含まれる側の種類が優先でも重なり90未満なら大きい方を残す() {
        let big = cand(0, 0, 100, 100, MaskKind::Contact);
        let small = cand(0, 0, 100, 89, MaskKind::Credential);
        assert_eq!(dedupe(vec![big, small]), vec![big]);
    }

    #[test]
    fn 重なりがちょうど90ならまとめて優先する種類を残す() {
        let big = cand(0, 0, 100, 100, MaskKind::Contact);
        let small = cand(0, 0, 100, 90, MaskKind::Credential);
        assert_eq!(
            dedupe(vec![big, small]),
            vec![cand(0, 0, 100, 100, MaskKind::Credential)]
        );
    }

    #[test]
    fn ほぼ同じ矩形は外接矩形にまとめる() {
        // 共通部分 98×100、和集合 102×100 → IoU ≈ 0.96
        let a = cand(0, 0, 100, 100, MaskKind::Identifier);
        let b = cand(2, 0, 100, 100, MaskKind::Financial);
        assert_eq!(
            dedupe(vec![a, b]),
            vec![cand(0, 0, 102, 100, MaskKind::Financial)]
        );
    }

    #[test]
    fn 同じ矩形は種類の優先順で1つにする() {
        use MaskKind::*;
        // 認証情報 > 金額・口座 > 連絡先 > 識別子。入力の順に依らない
        let cases = [
            (Credential, Financial, Credential),
            (Credential, Contact, Credential),
            (Credential, Identifier, Credential),
            (Financial, Contact, Financial),
            (Financial, Identifier, Financial),
            (Contact, Identifier, Contact),
        ];
        for (high, low, expected) in cases {
            for (first, second) in [(high, low), (low, high)] {
                let out = dedupe(vec![cand(5, 5, 40, 10, first), cand(5, 5, 40, 10, second)]);
                assert_eq!(
                    out,
                    vec![cand(5, 5, 40, 10, expected)],
                    "{first:?} と {second:?}"
                );
            }
        }
    }

    #[test]
    fn それ以外の重なりは両方残す() {
        // 共通部分 80×100、和集合 120×100 → IoU ≈ 0.67、どちらも他方に含まれない
        let a = cand(0, 0, 100, 100, MaskKind::Contact);
        let b = cand(20, 0, 100, 100, MaskKind::Credential);
        assert_eq!(dedupe(vec![a, b]), vec![a, b]);
    }

    #[test]
    fn 離れた矩形と接するだけの矩形は両方残す() {
        let a = cand(0, 0, 50, 10, MaskKind::Contact);
        let b = cand(50, 0, 50, 10, MaskKind::Contact);
        let c = cand(300, 300, 10, 10, MaskKind::Identifier);
        assert_eq!(dedupe(vec![a, b, c]), vec![a, b, c]);
    }

    #[test]
    fn まとめた結果に含まれる矩形も続けて捨てる() {
        let a = cand(0, 0, 100, 100, MaskKind::Contact);
        let b = cand(2, 0, 100, 100, MaskKind::Contact);
        // a にも b にも単独では含まれないが、まとめた外接矩形 (0,0)-(102,100) には含まれる
        let c = cand(1, 10, 101, 20, MaskKind::Identifier);
        assert_eq!(
            dedupe(vec![a, b, c]),
            vec![cand(0, 0, 102, 100, MaskKind::Contact)]
        );
    }

    #[test]
    fn 残った候補は入力の順を保つ() {
        let a = cand(500, 0, 10, 10, MaskKind::Identifier);
        let b = cand(0, 0, 10, 10, MaskKind::Contact);
        let inner = cand(501, 1, 5, 5, MaskKind::Contact);
        let c = cand(100, 100, 10, 10, MaskKind::Financial);
        assert_eq!(dedupe(vec![a, b, inner, c]), vec![a, b, c]);
    }

    #[test]
    fn 空の入力は空を返す() {
        assert_eq!(dedupe(Vec::new()), Vec::new());
    }
}
