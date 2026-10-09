//! 行の幾何: 同じ行の右隣・直下の行を探す(表のラベルと値の対応付け。ARCH_auto-masking §5.3)。
//!
//! Vision は表のラベル(「社員番号」)と値(「EMP-004521」)を別の行(観測)として返すため、
//! 手がかり語だけの観測から値の観測を位置で探す。座標は正規化座標(左下原点)のまま比べる。
//! 文字列は読まない(`line_box()` だけを使う)。

use super::{NormalizedRect, RecognizedPage};

/// `line` と同じ行(縦の中心が `line` の高さの範囲に入る)で、右側にある最も近い観測。
///
/// 「右側」は観測の左端が `line` の右端以上にあること。ただし読み取りの領域の誤差で
/// わずかに重なる場合を許し、`line` の高さ × `MAX_OVERLAP_RATIO` までの重なりは右側とみなす。
/// 距離は左端と `line` の右端の差(重なると負)。距離が等しければ番号の小さい方。見つからなければ `None`。
pub(super) fn right_neighbor<P: RecognizedPage + ?Sized>(page: &P, line: usize) -> Option<usize> {
    let label = page.line_box(line);
    let label_right = label.x + label.width;
    let min_left = label_right - label.height * MAX_OVERLAP_RATIO - EPSILON;
    nearest(
        (0..page.line_count())
            .filter(|&i| i != line)
            .map(|i| (i, page.line_box(i)))
            .filter(|(_, rect)| center_within(rect, &label) && rect.x >= min_left)
            .map(|(i, rect)| (i, rect.x - label_right)),
    )
}

/// ラベルの値とみなす右隣の観測との間隔の上限(ラベルの高さに対する倍率。正規化座標)。
///
/// フォームのラベルと値の間隔は文字の高さの数倍(評価画像の設定画面で約 5 倍)。画面の端から端まで離れた観測
/// (サイドバーの項目と表の右端の列など。約 60 倍)は別の領域とみなす。広いフォームを考えて 15 倍
/// (16:9 の画像で実ピクセルの約 27 倍)とする。
const MAX_LABEL_VALUE_GAP_RATIO: f64 = 15.0;

/// `right_neighbor` のうち、間隔がラベルの高さ × `MAX_LABEL_VALUE_GAP_RATIO` 以内のもの。
pub(super) fn near_right_neighbor<P: RecognizedPage + ?Sized>(page: &P, line: usize) -> Option<usize> {
    let label = page.line_box(line);
    right_neighbor(page, line)
        .filter(|&i| page.line_box(i).x - (label.x + label.width) <= label.height * MAX_LABEL_VALUE_GAP_RATIO)
}

/// 右隣として許すラベルとの重なり(ラベルの高さに対する割合)。
///
/// 正規化座標の横と縦は画像の幅・高さで別々に割られているため、横長の画像では実ピクセルの許容幅が
/// 高さ × 割合 より広くなる(16:9 で約 1.8 倍)。それでも 1 文字の幅より狭い。
const MAX_OVERLAP_RATIO: f64 = 0.25;

/// `line` の直下の行で、左端が `line` の左端に最も近い観測。
///
/// 縦の中心が `line` の下端より下にある観測のうち、上端が最も高いもの(最も近い行)を基準に、
/// その行(縦の中心が基準の高さの範囲に入る観測)の中から左端の差が最も小さいものを選ぶ。
/// 差が等しければ番号の小さい方。見つからなければ `None`。
pub(super) fn next_line_below<P: RecognizedPage + ?Sized>(page: &P, line: usize) -> Option<usize> {
    let label = page.line_box(line);
    // 左下原点なので「下」は y が小さい側。縦の中心がラベルの下端より下にある観測だけを候補にする
    let below: Vec<(usize, NormalizedRect)> = (0..page.line_count())
        .filter(|&i| i != line)
        .map(|i| (i, page.line_box(i)))
        .filter(|(_, rect)| center_y(rect) < label.y)
        .collect();
    // 上端(y + 高さ)が最も高い観測 = ラベルに最も近い行の基準
    let (_, row) = below
        .iter()
        .copied()
        .max_by(|(ia, a), (ib, b)| top_of(a).total_cmp(&top_of(b)).then(ib.cmp(ia)))?;
    nearest(
        below
            .iter()
            .filter(|(_, rect)| center_within(rect, &row))
            .map(|&(i, rect)| (i, (rect.x - label.x).abs())),
    )
}

/// `line` と同じ行(縦の中心が `line` の高さの範囲に入る)の観測の番号(`line` 自身を含む・番号の順)。
pub(super) fn same_row<P: RecognizedPage + ?Sized>(page: &P, line: usize) -> Vec<usize> {
    let row = page.line_box(line);
    (0..page.line_count()).filter(|&i| i == line || center_within(&page.line_box(i), &row)).collect()
}

/// 表の列としてたどる行の数の上限。
const MAX_COLUMN_ROWS: usize = 50;

/// 列の続きとみなす、前の観測との縦の間隔の上限(前の観測の高さに対する倍率)。
/// 表の行の間隔(セルの上下の余白)は文字の高さより狭いのが一般的なので、1.5 倍を超えたら別の塊とみなす。
const MAX_COLUMN_GAP_RATIO: f64 = 1.5;

/// 列の見出し `header` の下に並ぶ観測の番号(上から順)。
///
/// 横の範囲が見出しと重なる観測のうち、前の観測(最初は見出し)より下で上端が最も高いものを順にたどる
/// (同じ高さなら見出しとの重なりが大きい方)。前の観測との縦の間隔が前の観測の高さ × `MAX_COLUMN_GAP_RATIO`
/// を超えたら終わる。見出しが中央寄せで値が左寄せ(またはその逆)でも重なりで同じ列とみなす。
pub(super) fn column_below<P: RecognizedPage + ?Sized>(page: &P, header: usize) -> Vec<usize> {
    let head = page.line_box(header);
    let overlap = |rect: &NormalizedRect| (rect.x + rect.width).min(head.x + head.width) - rect.x.max(head.x);
    let mut cells = Vec::new();
    let mut prev = head;
    for _ in 0..MAX_COLUMN_ROWS {
        let next = (0..page.line_count())
            .filter(|&i| i != header && !cells.contains(&i))
            .map(|i| (i, page.line_box(i)))
            .filter(|(_, rect)| center_y(rect) < prev.y && overlap(rect) > EPSILON)
            .max_by(|(ia, a), (ib, b)| {
                top_of(a).total_cmp(&top_of(b)).then(overlap(a).total_cmp(&overlap(b))).then(ib.cmp(ia))
            });
        let Some((i, rect)) = next else {
            break;
        };
        if prev.y - top_of(&rect) > prev.height * MAX_COLUMN_GAP_RATIO {
            break;
        }
        cells.push(i);
        prev = rect;
    }
    cells
}

/// 比較の誤差の許容幅(正規化座標)。
const EPSILON: f64 = 1e-9;

fn center_y(rect: &NormalizedRect) -> f64 {
    rect.y + rect.height / 2.0
}

fn top_of(rect: &NormalizedRect) -> f64 {
    rect.y + rect.height
}

/// `rect` の縦の中心が `row` の高さの範囲(端を含む)に入る。
fn center_within(rect: &NormalizedRect, row: &NormalizedRect) -> bool {
    let center = center_y(rect);
    center >= row.y - EPSILON && center <= top_of(row) + EPSILON
}

/// (番号, 距離) のうち距離が最小のもの。距離が等しければ番号の小さい方。
fn nearest(candidates: impl Iterator<Item = (usize, f64)>) -> Option<usize> {
    candidates
        .min_by(|(ia, da), (ib, db)| da.total_cmp(db).then(ia.cmp(ib)))
        .map(|(i, _)| i)
}

#[cfg(test)]
mod tests {
    use std::ops::Range;

    use super::super::text::SensitiveText;
    use super::*;

    /// 行の領域だけを持つ偽物のページ。文字列は空。
    struct BoxesPage {
        boxes: Vec<NormalizedRect>,
        empty: SensitiveText,
    }

    impl BoxesPage {
        fn new(boxes: &[(f64, f64, f64, f64)]) -> Self {
            Self {
                boxes: boxes
                    .iter()
                    .map(|&(x, y, width, height)| NormalizedRect {
                        x,
                        y,
                        width,
                        height,
                    })
                    .collect(),
                empty: SensitiveText::new(String::new()),
            }
        }
    }

    impl RecognizedPage for BoxesPage {
        fn line_count(&self) -> usize {
            self.boxes.len()
        }
        fn line_text(&self, _line: usize) -> &SensitiveText {
            &self.empty
        }
        fn line_box(&self, line: usize) -> NormalizedRect {
            self.boxes[line]
        }
        fn range_box(&self, _line: usize, _range: Range<usize>) -> Option<NormalizedRect> {
            None
        }
    }

    /// ラベル: 左端 0.1・右端 0.3、縦は 0.50〜0.55(左下原点)
    const LABEL: (f64, f64, f64, f64) = (0.1, 0.5, 0.2, 0.05);

    // ---- right_neighbor ----

    #[test]
    fn 同じ行の右側で最も近い観測を返す() {
        let page = BoxesPage::new(&[
            LABEL,
            (0.6, 0.5, 0.2, 0.05),  // 1: 右側・遠い
            (0.35, 0.5, 0.2, 0.05), // 2: 右側・近い
        ]);
        assert_eq!(right_neighbor(&page, 0), Some(2));
    }

    #[test]
    fn 左側の観測は右隣にしない() {
        let page = BoxesPage::new(&[
            (0.0, 0.5, 0.05, 0.05), // 0: ラベルより左
            LABEL,                  // 1
        ]);
        assert_eq!(right_neighbor(&page, 1), None);
    }

    #[test]
    fn 縦の中心がラベルの高さの外にある観測は対象外() {
        let page = BoxesPage::new(&[
            LABEL,
            (0.35, 0.56, 0.2, 0.05), // 1: 中心 0.585 > 0.55(上へずれている)
            (0.35, 0.44, 0.2, 0.05), // 2: 中心 0.465 < 0.50(下へずれている)
            (0.7, 0.51, 0.2, 0.05),  // 3: 中心 0.535(少しずれているが範囲内)
        ]);
        assert_eq!(right_neighbor(&page, 0), Some(3));
    }

    #[test]
    fn 高さの違う観測でも縦の中心が範囲内なら同じ行とみなす() {
        let page = BoxesPage::new(&[
            LABEL,
            (0.4, 0.45, 0.2, 0.15), // 1: 中心 0.525。ラベルより背が高い
        ]);
        assert_eq!(right_neighbor(&page, 0), Some(1));
    }

    #[test]
    fn ラベルとわずかに重なる観測も右隣とみなす() {
        // ラベルの右端 0.3・高さ 0.05。重なりが高さの 25%(0.0125)までなら右隣
        let page = BoxesPage::new(&[LABEL, (0.29, 0.5, 0.2, 0.05)]);
        assert_eq!(right_neighbor(&page, 0), Some(1));
        let page = BoxesPage::new(&[LABEL, (0.3 - 0.0125, 0.5, 0.2, 0.05)]);
        assert_eq!(right_neighbor(&page, 0), Some(1));
    }

    #[test]
    fn ラベルと大きく重なる観測は右隣にしない() {
        // 重なりが高さの 25% を超える(0.015 = 30%)/ ラベルと同じ位置
        let page = BoxesPage::new(&[LABEL, (0.285, 0.5, 0.2, 0.05), (0.1, 0.5, 0.2, 0.05)]);
        assert_eq!(right_neighbor(&page, 0), None);
    }

    #[test]
    fn 右隣が無ければnone() {
        let page = BoxesPage::new(&[LABEL, (0.1, 0.3, 0.2, 0.05)]);
        assert_eq!(right_neighbor(&page, 0), None);
        assert_eq!(right_neighbor(&BoxesPage::new(&[LABEL]), 0), None);
    }

    #[test]
    fn 右隣の距離が同じなら番号の小さい方() {
        let page = BoxesPage::new(&[
            LABEL,
            (0.4, 0.52, 0.2, 0.02), // 1
            (0.4, 0.50, 0.2, 0.02), // 2: 1 と左端が同じ
        ]);
        assert_eq!(right_neighbor(&page, 0), Some(1));
    }

    // ---- next_line_below ----

    #[test]
    fn 直下の行で左端が近い観測を返す() {
        let page = BoxesPage::new(&[
            LABEL,
            (0.5, 0.43, 0.2, 0.05),  // 1: 直下の行・左端が遠い
            (0.12, 0.43, 0.2, 0.05), // 2: 直下の行・左端が近い
            (0.1, 0.30, 0.2, 0.05),  // 3: さらに下の行(左端は一致)
        ]);
        assert_eq!(next_line_below(&page, 0), Some(2));
    }

    #[test]
    fn 上の行と同じ行は直下にしない() {
        let page = BoxesPage::new(&[
            (0.1, 0.6, 0.2, 0.05),  // 0: 上の行
            LABEL,                  // 1
            (0.35, 0.5, 0.2, 0.05), // 2: 同じ行の右隣
        ]);
        assert_eq!(next_line_below(&page, 1), None);
    }

    #[test]
    fn 直下の行の高さが揃っていなくても同じ行として左端で選ぶ() {
        let page = BoxesPage::new(&[
            LABEL,
            (0.6, 0.44, 0.2, 0.05), // 1: 上端 0.49(最も近い)・左端が遠い
            (0.1, 0.43, 0.2, 0.05), // 2: 上端 0.48・中心 0.455 は 1 の高さ 0.44〜0.49 の範囲内
        ]);
        assert_eq!(next_line_below(&page, 0), Some(2));
    }

    #[test]
    fn 直下の行が無ければnone() {
        assert_eq!(next_line_below(&BoxesPage::new(&[LABEL]), 0), None);
    }

    // ---- near_right_neighbor ----

    #[test]
    fn 近い右隣だけを返し離れた右隣は返さない() {
        // ラベルの右端 0.3・高さ 0.05。間隔の上限は高さ × 15 = 0.75
        let page = BoxesPage::new(&[LABEL, (0.5, 0.5, 0.2, 0.05)]);
        assert_eq!(near_right_neighbor(&page, 0), Some(1));
        let page = BoxesPage::new(&[(0.0, 0.5, 0.02, 0.02), (0.9, 0.5, 0.05, 0.02)]);
        assert_eq!(near_right_neighbor(&page, 0), None);
        assert_eq!(right_neighbor(&page, 0), Some(1));
    }

    // ---- same_row / column_below ----

    #[test]
    fn 同じ行の観測を自分を含めて返す() {
        let page = BoxesPage::new(&[
            LABEL,
            (0.4, 0.51, 0.1, 0.04), // 1: 同じ行
            (0.4, 0.40, 0.1, 0.05), // 2: 下の行
            (0.0, 0.50, 0.05, 0.05), // 3: 左側の同じ行
        ]);
        assert_eq!(same_row(&page, 0), vec![0, 1, 3]);
    }

    #[test]
    fn 見出しと横に重なる観測を上から順にたどる() {
        // 見出し 0.1〜0.3。値は左に寄って幅が広い(中央寄せの見出し)
        let page = BoxesPage::new(&[
            LABEL,
            (0.05, 0.40, 0.4, 0.05),  // 1: 2 行目
            (0.05, 0.46, 0.4, 0.035), // 2: 1 行目
            (0.5, 0.46, 0.2, 0.035),  // 3: 隣の列(重ならない)
            (0.05, 0.34, 0.4, 0.05),  // 4: 3 行目
        ]);
        assert_eq!(column_below(&page, 0), vec![2, 1, 4]);
    }

    #[test]
    fn 列は離れた観測の手前で終わる() {
        let page = BoxesPage::new(&[
            LABEL,
            (0.1, 0.44, 0.2, 0.05), // 1: 直下
            (0.1, 0.20, 0.2, 0.05), // 2: 大きく離れている
        ]);
        assert_eq!(column_below(&page, 0), vec![1]);
        assert!(column_below(&BoxesPage::new(&[LABEL, (0.1, 0.2, 0.2, 0.05)]), 0).is_empty());
    }

    #[test]
    fn dynのページでも使える() {
        let page = BoxesPage::new(&[LABEL, (0.35, 0.5, 0.2, 0.05), (0.1, 0.43, 0.2, 0.05)]);
        let page: &dyn RecognizedPage = &page;
        assert_eq!(right_neighbor(page, 0), Some(1));
        assert_eq!(next_line_below(page, 0), Some(2));
    }
}
