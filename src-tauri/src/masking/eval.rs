//! 実機の Vision を通して検出率を測る評価ハーネス(`#[ignore]`。ARCH_auto-masking §10.3・AM-T19)。
//! テストビルドでだけコンパイルする。
//!
//! - `eval/masking/truth.json` の全画像を `scan()` と同じ処理(`png::validate` → `ocr::recognize` →
//!   `scan_page`)に通し、正解の矩形が候補の矩形の**和**に 100% 覆われたら検出とする(TASK #4・PRD §10 #10)
//! - 数え方は画像ごと(TASK #3)。1 つの正解(`target`)が複数行にまたがる場合は、全行が覆われたときだけ検出
//! - 誤検出はどの正解とも重ならない候補(参考値。PRD NFR-003)
//! - 読み取った文字列は扱わない。判定・出力は矩形・種類・細分・画像名だけ(NFR-002)。標準出力にも書かない
//! - 生データは `testreport/masking/eval-<日付>[-<ラベル>].json`、まとめは
//!   `output/reports/masking/eval-<日付>[-<ラベル>].md`(ラベルは環境変数 `MASK_EVAL_LABEL`。調整前後の比較用)
//! - 環境変数 `MASK_EVAL_SET=holdout` で、調整に使っていないホールドアウト(`eval/masking/holdout/`)を測る。
//!   ラベルの既定は `holdout`(本番の出力を上書きしない)。95% の判定は本番セットだけで行い、ホールドアウトは記録だけ

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{MaskCandidate, MatchDetail};

/// 形が決まっているもの(目標 95%。TASK #6 で届くまで止める)。
const FIXED_SHAPE_DETAILS: [&str; 9] = [
    "email",
    "phone",
    "prefixed_token",
    "random_string",
    "cue_value",
    "url_query",
    "card",
    "account",
    "amount",
];
/// 固有名詞・手がかり語付きの番号(目標 70%。TASK #6 で記録して人間が判断)。
const NAMED_DETAILS: [&str; 5] = ["cued_number", "person_ja", "person_en", "company", "address"];

/// 解像度 × テーマの列の順(表の列)。
const VARIANTS: [(&str, &str); 4] =
    [("fhd", "light"), ("fhd", "dark"), ("retina", "light"), ("retina", "dark")];

/// 評価セット。本番(調整に使う)とホールドアウト(調整に使わない確認用)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EvalSet {
    Default,
    Holdout,
    /// 規則の一般化の後に初めて測る 2 つ目のホールドアウト(`eval/masking/holdout2/`)
    Holdout2,
    /// 書式の対応を広げた後に初めて測る最終確認用(`eval/masking/holdout3/`)
    Holdout3,
}

impl EvalSet {
    /// 環境変数 `MASK_EVAL_SET` の値から。未設定・空・`default` は本番。未知の名前は `None`。
    fn parse(value: Option<&str>) -> Option<Self> {
        match value.map(str::trim) {
            None | Some("" | "default") => Some(Self::Default),
            Some("holdout") => Some(Self::Holdout),
            Some("holdout2") => Some(Self::Holdout2),
            Some("holdout3") => Some(Self::Holdout3),
            Some(_) => None,
        }
    }

    /// リポジトリのルートからの置き場所(`truth.json` と `images/` がある)。
    fn dir(self) -> &'static str {
        match self {
            Self::Default => "eval/masking",
            Self::Holdout => "eval/masking/holdout",
            Self::Holdout2 => "eval/masking/holdout2",
            Self::Holdout3 => "eval/masking/holdout3",
        }
    }

    /// 出力名のラベル。`MASK_EVAL_LABEL` があればそれ、無ければホールドアウトは `holdout`(本番を上書きしない)。
    fn label(self, env_label: Option<String>) -> Option<String> {
        env_label.or_else(|| match self {
            Self::Default => None,
            Self::Holdout => Some("holdout".to_string()),
            Self::Holdout2 => Some("holdout2".to_string()),
            Self::Holdout3 => Some("holdout3".to_string()),
        })
    }

    /// 規則の調整に使っていない確認用のセットか(95% の判定をせず記録だけにする)。
    fn is_holdout(self) -> bool {
        self != Self::Default
    }
}

/// 細分の目標(%)。未知の細分は `None`。
fn target_percent(detail: &str) -> Option<u32> {
    if FIXED_SHAPE_DETAILS.contains(&detail) {
        Some(95)
    } else if NAMED_DETAILS.contains(&detail) {
        Some(70)
    } else {
        None
    }
}

/// `truth.json` の細分名 → Rust の `MatchDetail`(ARCH §5.3)。人名は日本語・英字とも `PersonName`。
fn match_detail_of(detail: &str) -> Option<MatchDetail> {
    let mapped = match detail {
        "email" => MatchDetail::Email,
        "phone" => MatchDetail::Phone,
        "address" => MatchDetail::Address,
        "prefixed_token" => MatchDetail::PrefixedToken,
        "random_string" => MatchDetail::RandomString,
        "cue_value" => MatchDetail::LabeledSecret,
        "url_query" => MatchDetail::UrlQuery,
        "cued_number" => MatchDetail::LabeledNumber,
        "person_ja" | "person_en" => MatchDetail::PersonName,
        "company" => MatchDetail::CompanyName,
        "card" => MatchDetail::CardNumber,
        "account" => MatchDetail::AccountNumber,
        "amount" => MatchDetail::Amount,
        _ => return None,
    };
    Some(mapped)
}

/// 画像のピクセル上の矩形(左上原点・右端と下端は含まない)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Rect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl Rect {
    fn right(&self) -> u64 {
        u64::from(self.x) + u64::from(self.width)
    }

    fn bottom(&self) -> u64 {
        u64::from(self.y) + u64::from(self.height)
    }

    fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }

    fn intersects(&self, other: &Rect) -> bool {
        u64::from(self.x.max(other.x)) < self.right().min(other.right())
            && u64::from(self.y.max(other.y)) < self.bottom().min(other.bottom())
    }
}

impl From<MaskCandidate> for Rect {
    fn from(c: MaskCandidate) -> Self {
        Self { x: c.x, y: c.y, width: c.width, height: c.height }
    }
}

/// `target` が `covers` の和で 100% 覆われるか(TASK #4: 複数の候補の和でもよい)。
///
/// `target` の内側を候補の端の座標で格子に切り、各マスが 1 つ以上の候補に完全に含まれるかを調べる。
/// 空の `target` は覆われているとみなす。
fn covered_by_union(target: Rect, covers: &[Rect]) -> bool {
    if target.is_empty() {
        return true;
    }
    let (left, top, right, bottom) = (u64::from(target.x), u64::from(target.y), target.right(), target.bottom());
    let relevant: Vec<&Rect> = covers.iter().filter(|c| !c.is_empty() && c.intersects(&target)).collect();
    let mut xs = vec![left, right];
    let mut ys = vec![top, bottom];
    for c in &relevant {
        for x in [u64::from(c.x), c.right()] {
            if left < x && x < right {
                xs.push(x);
            }
        }
        for y in [u64::from(c.y), c.bottom()] {
            if top < y && y < bottom {
                ys.push(y);
            }
        }
    }
    xs.sort_unstable();
    xs.dedup();
    ys.sort_unstable();
    ys.dedup();
    ys.windows(2).all(|row| {
        xs.windows(2).all(|col| {
            relevant.iter().any(|c| {
                u64::from(c.x) <= col[0] && c.right() >= col[1] && u64::from(c.y) <= row[0] && c.bottom() >= row[1]
            })
        })
    })
}

/// 見逃しの内訳(調整の手がかり)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    /// 候補の和で 100% 覆われた
    Detected,
    /// 重なる候補はあるが、はみ出しがある(余白・位置の問題)
    Partial,
    /// 重なる候補が 1 つも無い(規則・読み取りの問題)
    NoOverlap,
}

/// 正解 1 件(複数行なら全行)の判定。
fn judge(regions: &[Rect], candidates: &[Rect]) -> Outcome {
    if regions.iter().all(|r| covered_by_union(*r, candidates)) {
        Outcome::Detected
    } else if regions.iter().any(|r| candidates.iter().any(|c| c.intersects(r))) {
        Outcome::Partial
    } else {
        Outcome::NoOverlap
    }
}

/// どの正解とも重ならない候補の数(誤検出。参考値)。
fn count_false_positives(candidates: &[Rect], truths: &[Rect]) -> usize {
    candidates.iter().filter(|c| !truths.iter().any(|t| t.intersects(c))).count()
}

/// 検出数 / 総数。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
struct Tally {
    hit: u32,
    total: u32,
}

impl Tally {
    fn add(&mut self, detected: bool) {
        self.total += 1;
        if detected {
            self.hit += 1;
        }
    }

    /// 検出率(%)。0 件なら `None`。
    fn percent(&self) -> Option<f64> {
        (self.total > 0).then(|| f64::from(self.hit) * 100.0 / f64::from(self.total))
    }

    /// 目標(%)以上か。整数で比べる(`hit * 100 >= target * total`)。
    fn meets(&self, target: u32) -> bool {
        self.total > 0 && u64::from(self.hit) * 100 >= u64::from(target) * u64::from(self.total)
    }
}

/// 判定 1 件の集計キー。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Judged {
    detail: String,
    variant: String,
    theme: String,
    detected: bool,
}

/// 細分ごと・(細分, 解像度, テーマ)ごとの集計。
#[derive(Debug, Default, PartialEq)]
struct Summary {
    by_detail: BTreeMap<String, Tally>,
    by_cell: BTreeMap<(String, String, String), Tally>,
}

fn summarize(judged: &[Judged]) -> Summary {
    let mut summary = Summary::default();
    for j in judged {
        summary.by_detail.entry(j.detail.clone()).or_default().add(j.detected);
        summary
            .by_cell
            .entry((j.detail.clone(), j.variant.clone(), j.theme.clone()))
            .or_default()
            .add(j.detected);
    }
    summary
}

// ---- 正解データ(truth.json。文字列は含まれない)----

#[derive(Debug, Deserialize)]
struct Truth {
    images: Vec<TruthImage>,
}

#[derive(Debug, Deserialize)]
struct TruthImage {
    file: String,
    variant: String,
    theme: String,
    width: u32,
    height: u32,
    regions: Vec<TruthRegion>,
}

#[derive(Debug, Deserialize)]
struct TruthRegion {
    target: String,
    detail: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl TruthRegion {
    fn rect(&self) -> Rect {
        Rect { x: self.x, y: self.y, width: self.width, height: self.height }
    }
}

/// 正解を `target` ごとにまとめる(出現順を保つ)。
fn group_targets(regions: &[TruthRegion]) -> Vec<(&str, &str, Vec<Rect>)> {
    let mut groups: Vec<(&str, &str, Vec<Rect>)> = Vec::new();
    for r in regions {
        match groups.iter_mut().find(|(target, _, _)| *target == r.target) {
            Some((_, _, rects)) => rects.push(r.rect()),
            None => groups.push((r.target.as_str(), r.detail.as_str(), vec![r.rect()])),
        }
    }
    groups
}

// ---- 生データ(testreport/masking/eval-*.json)----

#[derive(Debug, Serialize)]
struct RawReport {
    environment: Environment,
    images: Vec<RawImage>,
}

#[derive(Debug, Serialize)]
struct Environment {
    date: String,
    os_version: String,
    machine: String,
    uses_language_correction: bool,
    padding_ratio: f64,
    min_padding_px: i64,
}

#[derive(Debug, Serialize)]
struct RawImage {
    file: String,
    variant: String,
    theme: String,
    candidates: Vec<RawCandidate>,
    false_positives: usize,
    targets: Vec<RawTarget>,
}

#[derive(Debug, Serialize)]
struct RawCandidate {
    rect: Rect,
    kind: super::MaskKind,
}

#[derive(Debug, Serialize)]
struct RawTarget {
    target: String,
    detail: String,
    regions: Vec<Rect>,
    outcome: Outcome,
    /// 正解と重なる検出結果の細分(余白込みの矩形で判定。`MatchDetail` の名前)
    overlapping_details: Vec<String>,
    /// 期待どおりの細分(`match_detail_of`)の検出結果が重なったか
    expected_detail_fired: bool,
    /// はみ出しの量(px。左・上・右・下)。最も多く重なる候補との差。検出・重なり無しなら `None`
    shortfall: Option<[u32; 4]>,
}

/// 最も多く重なる候補に対する、正解のはみ出し(左・上・右・下)。
fn shortfall(region: Rect, candidates: &[Rect]) -> Option<[u32; 4]> {
    let best = candidates.iter().filter(|c| c.intersects(&region)).max_by_key(|c| {
        let w = region.right().min(c.right()).saturating_sub(u64::from(region.x.max(c.x)));
        let h = region.bottom().min(c.bottom()).saturating_sub(u64::from(region.y.max(c.y)));
        w * h
    })?;
    let gap = |a: u64, b: u64| u32::try_from(a.saturating_sub(b)).unwrap_or(u32::MAX);
    Some([
        gap(u64::from(best.x), u64::from(region.x)),
        gap(u64::from(best.y), u64::from(region.y)),
        gap(region.right(), best.right()),
        gap(region.bottom(), best.bottom()),
    ])
}

/// UNIX 時刻(秒)→ UTC の日付 `YYYY-MM-DD`(日付ライブラリを足さないための自前の変換)。
fn utc_date(unix_seconds: u64) -> String {
    let days = i64::try_from(unix_seconds / 86_400).unwrap_or(0);
    // H. Hinnant の civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// まとめ(Markdown)。細分 × (フル HD / Retina × 明 / 暗)の検出率と、誤検出の件数。
fn render_markdown(
    env: &Environment,
    summary: &Summary,
    false_positives: &BTreeMap<(String, String), usize>,
    set: EvalSet,
) -> String {
    let pct = |t: Option<&Tally>| match t {
        Some(t) => match t.percent() {
            Some(p) => format!("{p:.1}% ({}/{})", t.hit, t.total),
            None => "-".to_string(),
        },
        None => "-".to_string(),
    };
    let mut md = String::new();
    md.push_str(&format!("# 自動マスキングの検出率({})\n\n", env.date));
    md.push_str("> `masking::eval::masking_eval` が生成(読み取った文字列は含まない)。\n\n");
    if set.is_holdout() {
        md.push_str(&format!("> 評価セット: ホールドアウト(`{}/`。規則の調整に使っていない画面)。判定は参考。\n\n", set.dir()));
    }
    md.push_str("## 環境\n\n");
    md.push_str(&format!("- macOS: {} / 機種: {}\n", env.os_version, env.machine));
    md.push_str(&format!(
        "- 言語補正: {} / 余白: max({}px, 行の高さ × {})\n\n",
        if env.uses_language_correction { "オン" } else { "オフ" },
        env.min_padding_px,
        env.padding_ratio
    ));
    md.push_str("## 細分ごとの検出率\n\n");
    md.push_str("| 細分 | 目標 | フルHD・明 | フルHD・暗 | Retina・明 | Retina・暗 | 合計 | 判定 |\n");
    md.push_str("| ---- | ---- | ---------- | ---------- | ---------- | ---------- | ---- | ---- |\n");
    for detail in FIXED_SHAPE_DETAILS.iter().chain(NAMED_DETAILS.iter()) {
        let target = target_percent(detail).unwrap_or(0);
        let total = summary.by_detail.get(*detail);
        let mut row = format!("| {detail} | {target}% |");
        for (variant, theme) in VARIANTS {
            let key = ((*detail).to_string(), variant.to_string(), theme.to_string());
            row.push_str(&format!(" {} |", pct(summary.by_cell.get(&key))));
        }
        let verdict = match total {
            Some(t) if t.meets(target) => "達成",
            Some(_) => "未達",
            None => "-",
        };
        row.push_str(&format!(" {} | {verdict} |\n", pct(total)));
        md.push_str(&row);
    }
    md.push_str("\n## 誤検出(どの正解とも重ならない候補。参考値)\n\n");
    md.push_str("| フルHD・明 | フルHD・暗 | Retina・明 | Retina・暗 | 合計 |\n| ---- | ---- | ---- | ---- | ---- |\n|");
    let mut sum = 0;
    for (variant, theme) in VARIANTS {
        let n = false_positives.get(&(variant.to_string(), theme.to_string())).copied().unwrap_or(0);
        sum += n;
        md.push_str(&format!(" {n} |"));
    }
    md.push_str(&format!(" {sum} |\n"));
    md
}

/// 端末の情報(`sw_vers`・`sysctl`)。取れなければ `unknown`。
fn system_value(program: &str, args: &[&str]) -> String {
    std::process::Command::new(program)
        .args(args)
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "実機の Vision を使う評価(macOS。cargo test masking::eval -- --ignored)"]
fn masking_eval() {
    use super::{detect, geometry, ocr, png, scan_page, RecognizedPage};

    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
    let set = EvalSet::parse(std::env::var("MASK_EVAL_SET").ok().as_deref())
        .expect("MASK_EVAL_SET は default か holdout");
    let set_dir = set.dir();
    let truth: Truth = serde_json::from_str(
        &std::fs::read_to_string(format!("{root}/{set_dir}/truth.json")).expect("truth.json を読めなかった"),
    )
    .expect("truth.json の形が不正");
    assert!(!truth.images.is_empty(), "truth.json に画像が無い");

    let date = std::env::var("MASK_EVAL_DATE").unwrap_or_else(|_| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        utc_date(now)
    });
    let env = Environment {
        date: date.clone(),
        os_version: system_value("sw_vers", &["-productVersion"]),
        machine: system_value("sysctl", &["-n", "hw.model"]),
        uses_language_correction: ocr::USES_LANGUAGE_CORRECTION,
        padding_ratio: geometry::PADDING_RATIO,
        min_padding_px: geometry::MIN_PADDING_PX,
    };

    let mut judged = Vec::new();
    let mut raw_images = Vec::new();
    let mut false_positives: BTreeMap<(String, String), usize> = BTreeMap::new();

    for image in &truth.images {
        let bytes = std::fs::read(format!("{root}/{set_dir}/images/{}", image.file)).expect("評価画像を読めなかった");
        let size = png::validate(&bytes).expect("評価画像が PNG でない");
        assert_eq!((size.width, size.height), (image.width, image.height), "{} の大きさが truth と違う", image.file);

        // `scan()` と同じ処理。加えて、細分の内訳を見るために検出結果ごとの矩形(余白込み)も求める。
        // 読み取り結果(`VisionPage`)はこの `autoreleasepool` の中で破棄する。
        let (scanned, detail_rects) = objc2::rc::autoreleasepool(|_| {
            let page = ocr::recognize(&bytes).expect("読み取りに失敗した");
            let scanned: Vec<MaskCandidate> = scan_page(&page, size);
            let detail_rects: Vec<(MatchDetail, Rect)> = detect::run(&page)
                .into_iter()
                .filter_map(|m| {
                    let part = page.range_box(m.line, m.range.clone())?;
                    let line_height = geometry::to_pixel_rect(page.line_box(m.line), size).height();
                    let c = geometry::pad_and_clip(geometry::to_pixel_rect(part, size), line_height, size, m.kind)?;
                    Some((m.detail, Rect::from(c)))
                })
                .collect();
            (scanned, detail_rects)
        });
        let candidates: Vec<Rect> = scanned.iter().copied().map(Rect::from).collect();

        let truths: Vec<Rect> = image.regions.iter().map(TruthRegion::rect).collect();
        let fp = count_false_positives(&candidates, &truths);
        *false_positives.entry((image.variant.clone(), image.theme.clone())).or_default() += fp;

        let mut targets = Vec::new();
        for (target, detail, regions) in group_targets(&image.regions) {
            let expected = match_detail_of(detail).unwrap_or_else(|| panic!("未知の細分: {detail}"));
            let outcome = judge(&regions, &candidates);
            let mut overlapping: Vec<MatchDetail> = detail_rects
                .iter()
                .filter(|(_, r)| regions.iter().any(|t| t.intersects(r)))
                .map(|(d, _)| *d)
                .collect();
            overlapping.dedup();
            let expected_detail_fired = overlapping.contains(&expected);
            let mut names: Vec<String> = overlapping.iter().map(|d| format!("{d:?}")).collect();
            names.sort_unstable();
            names.dedup();
            let gap = match outcome {
                Outcome::Partial => regions.iter().find(|r| !covered_by_union(**r, &candidates)).and_then(|r| shortfall(*r, &candidates)),
                _ => None,
            };
            judged.push(Judged {
                detail: detail.to_string(),
                variant: image.variant.clone(),
                theme: image.theme.clone(),
                detected: outcome == Outcome::Detected,
            });
            targets.push(RawTarget {
                target: target.to_string(),
                detail: detail.to_string(),
                regions,
                outcome,
                overlapping_details: names,
                expected_detail_fired,
                shortfall: gap,
            });
        }
        raw_images.push(RawImage {
            file: image.file.clone(),
            variant: image.variant.clone(),
            theme: image.theme.clone(),
            candidates: scanned.iter().map(|c| RawCandidate { rect: Rect::from(*c), kind: c.kind }).collect(),
            false_positives: fp,
            targets,
        });
    }

    let summary = summarize(&judged);
    let suffix = set.label(std::env::var("MASK_EVAL_LABEL").ok()).map(|l| format!("-{l}")).unwrap_or_default();
    let raw = RawReport { environment: env, images: raw_images };
    std::fs::create_dir_all(format!("{root}/testreport/masking")).expect("出力先を作れなかった");
    std::fs::create_dir_all(format!("{root}/output/reports/masking")).expect("出力先を作れなかった");
    std::fs::write(
        format!("{root}/testreport/masking/eval-{date}{suffix}.json"),
        serde_json::to_string_pretty(&raw).expect("生データのシリアライズに失敗した"),
    )
    .expect("生データを書けなかった");
    std::fs::write(
        format!("{root}/output/reports/masking/eval-{date}{suffix}.md"),
        render_markdown(&raw.environment, &summary, &false_positives, set),
    )
    .expect("まとめを書けなかった");

    // 形が決まっているものは 95% 以上(TASK #6: 届くまで止める)。固有名詞側は記録だけ。
    // ホールドアウトは合わせ込みの確認用なので記録だけ(止めない)。
    if set.is_holdout() {
        return;
    }
    let missing: Vec<String> = FIXED_SHAPE_DETAILS
        .iter()
        .filter_map(|d| {
            let t = summary.by_detail.get(*d).copied().unwrap_or_default();
            (!t.meets(95)).then(|| format!("{d} {}/{}", t.hit, t.total))
        })
        .collect();
    assert!(missing.is_empty(), "95% 未達の細分: {missing:?}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: u32, y: u32, width: u32, height: u32) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn 正解を完全に覆う候補があれば覆われている() {
        let target = rect(10, 10, 20, 5);
        assert!(covered_by_union(target, &[rect(10, 10, 20, 5)]));
        assert!(covered_by_union(target, &[rect(0, 0, 100, 100)]));
    }

    #[test]
    fn 一px_でもはみ出せば覆われていない() {
        let target = rect(10, 10, 20, 5);
        // 左・上・右・下にそれぞれ 1px 足りない
        assert!(!covered_by_union(target, &[rect(11, 10, 19, 5)]));
        assert!(!covered_by_union(target, &[rect(10, 11, 20, 4)]));
        assert!(!covered_by_union(target, &[rect(10, 10, 19, 5)]));
        assert!(!covered_by_union(target, &[rect(10, 10, 20, 4)]));
        assert!(!covered_by_union(target, &[]));
    }

    #[test]
    fn 二つの候補の和で覆えば覆われている() {
        let target = rect(10, 10, 20, 5);
        // 左半分と右半分(境界で接する)
        assert!(covered_by_union(target, &[rect(0, 0, 20, 20), rect(20, 0, 20, 20)]));
        // 上下に分かれて重なる
        assert!(covered_by_union(target, &[rect(5, 8, 30, 5), rect(5, 12, 30, 5)]));
    }

    #[test]
    fn 二つの候補の間に隙間があれば覆われていない() {
        let target = rect(10, 10, 20, 5);
        assert!(!covered_by_union(target, &[rect(0, 0, 19, 20), rect(20, 0, 20, 20)]));
        // L 字の欠け(右下の角だけ空く)
        assert!(!covered_by_union(target, &[rect(10, 10, 20, 3), rect(10, 10, 15, 5)]));
    }

    #[test]
    fn 複数行の正解は全行が覆われたときだけ検出になる() {
        let lines = [rect(10, 10, 50, 10), rect(10, 30, 30, 10)];
        assert_eq!(judge(&lines, &[rect(5, 5, 60, 40)]), Outcome::Detected);
        assert_eq!(judge(&lines, &[rect(5, 5, 60, 20)]), Outcome::Partial);
        assert_eq!(judge(&lines, &[rect(200, 200, 5, 5)]), Outcome::NoOverlap);
    }

    #[test]
    fn 誤検出はどの正解とも重ならない候補だけを数える() {
        let truths = [rect(10, 10, 10, 10)];
        let candidates = [rect(5, 5, 10, 10), rect(20, 10, 5, 5), rect(100, 100, 5, 5)];
        // 2 件目は右端で接するだけ(重なりなし)
        assert_eq!(count_false_positives(&candidates, &truths), 2);
    }

    #[test]
    fn 細分ごとと解像度テーマごとに集計する() {
        let j = |detail: &str, variant: &str, theme: &str, detected: bool| Judged {
            detail: detail.to_string(),
            variant: variant.to_string(),
            theme: theme.to_string(),
            detected,
        };
        let summary = summarize(&[
            j("email", "fhd", "light", true),
            j("email", "fhd", "dark", false),
            j("email", "fhd", "dark", true),
            j("card", "retina", "light", true),
        ]);
        assert_eq!(summary.by_detail["email"], Tally { hit: 2, total: 3 });
        assert_eq!(summary.by_detail["card"], Tally { hit: 1, total: 1 });
        let key = |d: &str, v: &str, t: &str| (d.to_string(), v.to_string(), t.to_string());
        assert_eq!(summary.by_cell[&key("email", "fhd", "dark")], Tally { hit: 1, total: 2 });
        assert_eq!(summary.by_cell[&key("email", "fhd", "light")], Tally { hit: 1, total: 1 });
    }

    #[test]
    fn 目標の判定は整数で比べる() {
        assert!(Tally { hit: 19, total: 20 }.meets(95));
        assert!(!Tally { hit: 18, total: 20 }.meets(95));
        assert!(Tally { hit: 7, total: 10 }.meets(70));
        assert!(!Tally::default().meets(70));
    }

    #[test]
    fn truthの細分はすべてmatch_detailと目標に対応する() {
        let names = FIXED_SHAPE_DETAILS.iter().chain(NAMED_DETAILS.iter());
        for name in names {
            assert!(match_detail_of(name).is_some(), "{name}");
            assert!(target_percent(name).is_some(), "{name}");
        }
        assert_eq!(match_detail_of("cue_value"), Some(MatchDetail::LabeledSecret));
        assert_eq!(match_detail_of("cued_number"), Some(MatchDetail::LabeledNumber));
        assert_eq!(match_detail_of("unknown"), None);
    }

    #[test]
    fn 評価セットは環境変数で切り替え_既定は本番() {
        assert_eq!(EvalSet::parse(None), Some(EvalSet::Default));
        assert_eq!(EvalSet::parse(Some("")), Some(EvalSet::Default));
        assert_eq!(EvalSet::parse(Some("default")), Some(EvalSet::Default));
        assert_eq!(EvalSet::parse(Some("holdout")), Some(EvalSet::Holdout));
        assert_eq!(EvalSet::parse(Some("pages")), None);
        assert_eq!(EvalSet::Default.dir(), "eval/masking");
        assert_eq!(EvalSet::Holdout.dir(), "eval/masking/holdout");
        assert_eq!(EvalSet::parse(Some("holdout2")), Some(EvalSet::Holdout2));
        assert_eq!(EvalSet::Holdout2.dir(), "eval/masking/holdout2");
        assert_eq!(EvalSet::parse(Some("holdout3")), Some(EvalSet::Holdout3));
        assert_eq!(EvalSet::Holdout3.dir(), "eval/masking/holdout3");
    }

    #[test]
    fn ホールドアウトのラベルの既定はholdoutで本番は従来どおり() {
        assert_eq!(EvalSet::Default.label(None), None);
        assert_eq!(EvalSet::Default.label(Some("x".into())), Some("x".to_string()));
        assert_eq!(EvalSet::Holdout.label(None), Some("holdout".to_string()));
        assert_eq!(EvalSet::Holdout.label(Some("holdout".into())), Some("holdout".to_string()));
        assert_eq!(EvalSet::Holdout2.label(None), Some("holdout2".to_string()));
        assert_eq!(EvalSet::Holdout3.label(None), Some("holdout3".to_string()));
        assert!(EvalSet::Holdout3.is_holdout());
        assert!(EvalSet::Holdout2.is_holdout() && EvalSet::Holdout.is_holdout() && !EvalSet::Default.is_holdout());
    }

    #[test]
    fn utc_dateは暦日を返す() {
        assert_eq!(utc_date(0), "1970-01-01");
        assert_eq!(utc_date(951_782_400), "2000-02-29");
        assert_eq!(utc_date(1_791_504_000), "2026-10-09");
    }
}
