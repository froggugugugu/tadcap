//! 矢印ツール(ARCH §4 `src/canvas/tools/arrowTool.ts`、PRD FR-006、T09。
//! 【改訂 2026-09-24、T24】テーパー形状化・toolSettings連携・Undo連携)。
//!
//! 座標計算(`arrowLineWidth()`/`arrowHeadLength()`/`computeArrowGeometry()`/
//! `computeTaperArrowPolygon()`/`computeTaperArrowBoundingRect()`)は
//! DOM非依存の純粋関数としてユニットテストする。ドラッグ操作の検知・Canvasへの実描画
//! (T31以降は`shapeTools.ts::bindShapeTools()`)はDOM/Canvas APIに直接依存するため、Vitestの既定環境(Node、DOM無し)
//! では自動テスト対象外とし、手動確認チェックリストへ回す(project-config.md §11。
//! `render.ts`・`permissionBanner.ts`と同じ方針)。
//!
//! 【改訂 2026-09-24、T24】矢印の色は`toolSettings.getToolSettings().color`を単一の真実源と
//! する(ARCH §5.2)。以前は`--arrow-color`CSSカスタムプロパティを`getComputedStyle()`で
//! 直読みしていたが、色の一括指定(FR-013)により「現在の注釈色」はJS側`toolSettings`が
//! 真実源になった(CSSカスタムプロパティ自体はUIアクセント色・初期値の出所として`styles.css`
//! に残る。ARCH §5.2「UIのアクセント色自体は注釈色と独立して固定のピンクのまま」)。
//!
//! 【改訂 2026-09-24、T25】`cropSnapshotRect()`は`coords.ts`へ移設した(矩形ツールが
//! 3ファイル目の利用者になったためRule of Threeで集約、挙動不変)。太さ比率算出
//! (`arrowLineWidth()`等)自体は本ファイルにローカルなまま変更していない。
//!
//! 【改訂 2026-09-24、T25追補】人間から実際のフィードバック(要旨、project-config.md §11
//! 参照)「テーパー矢印の終点側の太さが細すぎる。もっとインパクトのある太さにしたい」を受け、
//! PJM経由で承認を確認したうえで以下を改訂した(このリポジトリでは第三者製品名を書かない
//! 方針のため、比較対象アプリ名は記載しない): (1) 終点側の太さの算出比率・上下限を引き上げ
//! (典型サイズで20px前後、旧8px)、(2) 矢じりの長さ・幅を胴の太さに対して独立した比率で
//! 明示的に算出する方式に変更(旧: 矢じりの開き角30°からの三角関数で間接的に決まっていた幅を、
//! `arrowHeadWidth()`で直接指定する方式へ)、(3) 視認性を高める半透明のドロップシャドウを
//! 焼き込み時に追加。定数はすべて下記の1箇所(ファイル冒頭)に集約し、各値の根拠をコメントで
//! 残す。`computeArrowGeometry()`の戻り値(`head.left`/`head.right`の算出方法)が変わるため、
//! 依存する`computeTaperArrowPolygon()`は自動的に新しい矢じり形状を継承する(呼び出し関係は
//! 変更なし)。

import {
  clipRectToCanvas,
  type Point,
  type Rect,
} from "../coords";

export type { Point, Rect };

// --- 定数(すべてここに集約。T25追補で人間フィードバックを受けて改訂、根拠は各コメント参照) ---

/**
 * 終点側(胴)の太さの下限・上限(px)。旧2px/14pxは「細すぎる」という人間フィードバックを
 * 受けて6px/48pxへ引き上げ、さらにT31【改訂 2026-09-24】の人間要望「矢印はもっと太くて良い、
 * 今の1.5倍」を受けて1.5倍(9px/72px)にした。下限は極小画像でもテーパーの最も細い部分
 * (始点側)が視認できる太さを保つため、上限は5K相当でも胴が過剰に太くなりすぎないための
 * クランプ(いずれも旧値の1.5倍で比率関係を保つ)。
 */
const MIN_LINE_WIDTH = 9;
const MAX_LINE_WIDTH = 72;
/**
 * Canvas対角線(px、ピクセルバッファサイズ=画像の実ピクセル)に対する終点側の太さの比率。
 * `window.devicePixelRatio` ではなくCanvasピクセルバッファサイズを基準にする(`coords.ts` の
 * 説明を参照)。
 *
 * 【設計判断】T25追補で0.009(典型2000x1000で20px)としたものを、T31【改訂 2026-09-24】で
 * 人間要望「今の1.5倍」に合わせ0.0135にした。典型サイズ(2000x1000、対角線≈2236.07px)で
 * `round(2236.07 * 0.0135)` = 30px。5K相当(5120x2880、対角線≈5874.59px)では79.3px相当に
 * なるため`MAX_LINE_WIDTH`(72px)でクランプ、小さい画像(400x300、対角線500px)では6.75px相当に
 * なるため`MIN_LINE_WIDTH`(9px)でクランプする。矢じり(長さ・幅)・ドロップシャドウは胴の
 * 太さに対する比率で決まるため、下記の比率を変えずに自動で1.5倍に追従する。
 */
const LINE_WIDTH_RATIO = 0.0135;
/**
 * 矢じりの長さ = 胴の太さ × この倍率(T25追補【改訂 2026-09-24】、旧4から変更)。
 * 目安レンジ(2.5〜3、PJM指示)の上限を採用し、インパクト重視で最も大きい矢じりにした。
 */
const HEAD_LENGTH_RATIO = 3;
/**
 * 矢じりの幅(左右スパン) = 胴の太さ × この倍率(T25追補【新設 2026-09-24】)。目安レンジ
 * (2.2〜2.6、PJM指示)の中央値を採用した。旧実装は矢じりの開き角(30°)からの三角関数で幅が
 * 間接的に決まっていたが、「矢じりは胴よりはっきり幅広で大きく」という要求を直接表現できる
 * よう、幅を独立した比率として明示的に持つ方式に変更した(`computeArrowGeometry()`参照)。
 */
const HEAD_WIDTH_RATIO = 2.4;
/** これ未満のドラッグ距離(Canvasピクセル)は誤クリックとみなし矢印を確定しない。 */
const MIN_DRAG_DISTANCE = 2;
/**
 * 始点側の太さ = 終点側の太さ(`arrowLineWidth()`)× この比率(T24【新設 2026-09-24】、
 * PRD FR-006改訂・ARCH §5.2。T25追補【改訂 2026-09-24】で0.25→0.15へ変更)。
 *
 * 【設計判断】人間フィードバック「始点はほぼ点から太くなるように」を受け、目安レンジ
 * (0.15〜0.25、PJM指示)の下限を採用した。典型サイズ(胴20px)で始点側が3pxとなり、
 * 「ほぼ点」に近い先細り感を保ちつつ、`ctx.fill()`で完全に消えてしまわない太さを維持する。
 */
const START_WIDTH_RATIO = 0.15;
/**
 * 焼き込み時の半透明ドロップシャドウ(T25追補【新設 2026-09-24】、人間フィードバック
 * 「背景に埋もれないよう、ごく薄いドロップシャドウを付ける」)。ぼかし半径・下方向オフセットは
 * 胴の太さ(`endWidth`)に比例させる(`arrowShadowParams()`参照。矢印全体の視覚的スケールが
 * 胴の太さで決まるため、シャドウもそれに追従させないと極小画像・5K画像で不自然に見える)。
 * 色は半透明の黒(35%不透明度、「ごく薄い」の要求に対し視認性とのバランスで選定)。
 */
const SHADOW_COLOR = "rgba(0, 0, 0, 0.35)";
/** シャドウのぼかし半径 = 胴の太さ × この倍率。 */
const SHADOW_BLUR_RATIO = 0.3;
/** シャドウの下方向オフセット = 胴の太さ × この倍率。 */
const SHADOW_OFFSET_Y_RATIO = 0.25;

export interface ArrowHead {
  tip: Point;
  left: Point;
  right: Point;
}

export interface ArrowGeometry {
  start: Point;
  end: Point;
  lineWidth: number;
  headLength: number;
  /** 矢じりの幅(左右スパン、px)。T25追補【新設 2026-09-24】。 */
  headWidth: number;
  head: ArrowHead;
}

/**
 * Canvasの対角線(ピクセルバッファサイズ、画像の実ピクセル)から線幅を決定論的に算出する
 * 純粋関数。小さい画像で細すぎず、大きい画像で太すぎないよう
 * [MIN_LINE_WIDTH, MAX_LINE_WIDTH] にクランプする。
 */
export function arrowLineWidth(canvasWidth: number, canvasHeight: number): number {
  const diagonal = Math.hypot(canvasWidth, canvasHeight);
  const raw = Math.round(diagonal * LINE_WIDTH_RATIO);
  return clamp(raw, MIN_LINE_WIDTH, MAX_LINE_WIDTH);
}

/** 矢じりの長さを線幅(胴の太さ)から算出する純粋関数。 */
export function arrowHeadLength(lineWidth: number): number {
  return lineWidth * HEAD_LENGTH_RATIO;
}

/** 矢じりの幅(左右スパン)を線幅(胴の太さ)から算出する純粋関数(T25追補【新設 2026-09-24】)。 */
export function arrowHeadWidth(lineWidth: number): number {
  return lineWidth * HEAD_WIDTH_RATIO;
}

/**
 * 焼き込み時のドロップシャドウパラメータ(T25追補【新設 2026-09-24】)。胴の太さ
 * (`endWidth`)に比例したぼかし半径・下方向オフセットを返す純粋関数。`color`は固定。
 */
export interface ArrowShadowParams {
  blur: number;
  offsetY: number;
  color: string;
}

export function arrowShadowParams(endWidth: number): ArrowShadowParams {
  return {
    blur: endWidth * SHADOW_BLUR_RATIO,
    offsetY: endWidth * SHADOW_OFFSET_Y_RATIO,
    color: SHADOW_COLOR,
  };
}

/**
 * 始点・終点(いずれもCanvasピクセル座標)から矢印の描画パラメータを算出する純粋関数。
 * ドラッグ距離が `MIN_DRAG_DISTANCE` 未満(誤クリック等)の場合は `null` を返す。
 *
 * 【T25追補 改訂 2026-09-24】矢じり左右2点(`head.left`/`head.right`)の算出方法を、旧・
 * 開き角(30°)からの三角関数による間接的な算出から、「終点からheadLength手前(進行方向の
 * 直線上)の点を中心に、進行方向と直交する軸へheadWidth/2ずつオフセットする」直接的な算出へ
 * 変更した。これにより矢じりの幅(`headWidth`)を胴の太さに対する独立した比率として明示的に
 * 制御できる(旧方式では開き角と長さの組み合わせでしか幅を変えられなかった)。
 */
export function computeArrowGeometry(
  start: Point,
  end: Point,
  canvasWidth: number,
  canvasHeight: number,
): ArrowGeometry | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance < MIN_DRAG_DISTANCE) {
    return null;
  }

  const lineWidth = arrowLineWidth(canvasWidth, canvasHeight);
  const headLength = arrowHeadLength(lineWidth);
  const headWidth = arrowHeadWidth(lineWidth);

  const ux = dx / distance;
  const uy = dy / distance;
  // 進行方向を90度回転させた単位法線(左右へオフセットするための軸)。
  const nx = -uy;
  const ny = ux;

  // 矢じり基部の中心 = 終点からheadLength手前(進行方向の直線上)。
  const neckX = end.x - headLength * ux;
  const neckY = end.y - headLength * uy;

  const left: Point = {
    x: neckX + nx * (headWidth / 2),
    y: neckY + ny * (headWidth / 2),
  };
  const right: Point = {
    x: neckX - nx * (headWidth / 2),
    y: neckY - ny * (headWidth / 2),
  };

  return {
    start,
    end,
    lineWidth,
    headLength,
    headWidth,
    head: { tip: end, left, right },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * テーパー矢印(始点→終点で徐々に太くなる単一多角形)の頂点・太さ(T24【新設 2026-09-24】、
 * PRD FR-006改訂・ARCH §5.2)。`points`は7頂点で、`ctx.fill()`で単色塗りつぶしする1つの
 * 多角形の輪郭を、始点側から時計回り(または反時計回り、Canvas座標系ではy下向きのため見た目上は
 * どちらかは描画時の向きに依存)に一周する順で並べる: 始点左→矢じり基部左→矢じり左翼→先端→
 * 矢じり右翼→矢じり基部右→始点右(→始点左へ閉じる、`ctx.closePath()`)。この順であれば
 * 自己交差(蝶ネクタイ状)せず、胴(台形)と矢じり(三角形)が滑らかに繋がる。
 */
export interface TaperArrowPolygon {
  points: [Point, Point, Point, Point, Point, Point, Point];
  /** 始点側の太さ(px)。常に `endWidth` 以下(クランプ済み)。 */
  startWidth: number;
  /** 終点側の太さ(px)。既存 `arrowLineWidth()` の算出値そのまま(算出基準を変更しない)。 */
  endWidth: number;
  /** 矢じりの長さ(px)。既存 `arrowHeadLength()` の算出値そのまま。 */
  headLength: number;
}

/**
 * 始点・終点(いずれもCanvasピクセル座標)からテーパー矢印の多角形頂点を算出する純粋関数
 * (T24【新設 2026-09-24】)。矢じり3点(tip/left/right)は既存`computeArrowGeometry()`を
 * 内部で呼び出しそのまま流用する(同一の算出結果になることを保証し、トリゴノメトリの
 * 重複も避ける)。ドラッグ距離が`MIN_DRAG_DISTANCE`未満の場合は`null`を返す(既存と同じ
 * ガード条件、`computeArrowGeometry()`が`null`を返す場合にそのまま連動する)。
 */
export function computeTaperArrowPolygon(
  start: Point,
  end: Point,
  canvasWidth: number,
  canvasHeight: number,
): TaperArrowPolygon | null {
  const geometry = computeArrowGeometry(start, end, canvasWidth, canvasHeight);
  if (!geometry) {
    return null;
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const ux = dx / distance;
  const uy = dy / distance;
  // 進行方向を90度回転させた単位法線(左右へオフセットするための軸)。
  const nx = -uy;
  const ny = ux;

  const endWidth = geometry.lineWidth;
  // 常に終点側以下へクランプする(PRD FR-006改訂の受け入れ基準・比率は定数1か所のみ)。
  const startWidth = Math.min(endWidth, endWidth * START_WIDTH_RATIO);

  // 矢じり基部 = 終点からheadLength手前(進行方向の直線上、矢じりの回転角ではない)。
  const baseX = end.x - geometry.headLength * ux;
  const baseY = end.y - geometry.headLength * uy;

  const offsetPoint = (point: Point, halfWidth: number, sign: 1 | -1): Point => ({
    x: point.x + sign * nx * halfWidth,
    y: point.y + sign * ny * halfWidth,
  });

  const startLeft = offsetPoint(start, startWidth / 2, 1);
  const startRight = offsetPoint(start, startWidth / 2, -1);
  const baseLeft = offsetPoint({ x: baseX, y: baseY }, endWidth / 2, 1);
  const baseRight = offsetPoint({ x: baseX, y: baseY }, endWidth / 2, -1);

  return {
    points: [
      startLeft,
      baseLeft,
      geometry.head.left,
      geometry.head.tip,
      geometry.head.right,
      baseRight,
      startRight,
    ],
    startWidth,
    endWidth,
    headLength: geometry.headLength,
  };
}

/**
 * テーパー矢印多角形の外接矩形を、線の太さ分の余白付き・Canvas範囲内クリップ済み・
 * 整数座標で算出する純粋関数(T24【新設 2026-09-24】、タスク指示「取り消しのbeforeは
 * ドラッグ開始時の全体スナップショットから外接矩形分を切り出す(線の太さ分の余白を含める)」)。
 *
 * 余白(`margin`)は3要素の合計(T25追補【改訂 2026-09-24】、ドロップシャドウ追加に伴い拡張):
 * (1) `endWidth`分 — `ctx.fill()`のアンチエイリアシングにより実際の描画が多角形の数学的な
 * 輪郭よりわずかに外側までピクセルを変更しうるための安全マージン(旧実装から継続)。
 * (2) シャドウのぼかし半径×2分 — `ctx.shadowBlur`はシャドウの発生源の形状から概ねぼかし半径
 * ぶん外側まで滲むため、安全側に2倍を確保する。(3) シャドウの下方向オフセット分 — 影は
 * 下にずれて描画されるため。(2)(3)は全方向に一律で加える(片側だけ広げる実装より単純で、
 * Undo復元漏れのリスクが低い)。整数化するのは`getImageData()`/`putImageData()`に
 * そのまま渡せるようにするため。
 */
export function computeTaperArrowBoundingRect(
  polygon: TaperArrowPolygon,
  canvasWidth: number,
  canvasHeight: number,
): Rect {
  const xs = polygon.points.map((point) => point.x);
  const ys = polygon.points.map((point) => point.y);
  const shadow = arrowShadowParams(polygon.endWidth);
  const margin = polygon.endWidth + shadow.blur * 2 + shadow.offsetY;
  const minX = Math.min(...xs) - margin;
  const minY = Math.min(...ys) - margin;
  const maxX = Math.max(...xs) + margin;
  const maxY = Math.max(...ys) + margin;

  const clipped = clipRectToCanvas(
    { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    canvasWidth,
    canvasHeight,
  );

  return {
    x: Math.round(clipped.x),
    y: Math.round(clipped.y),
    width: Math.max(0, Math.round(clipped.width)),
    height: Math.max(0, Math.round(clipped.height)),
  };
}

/**
 * Canvas 2D contextへテーパー矢印(単一多角形の塗りつぶし)を焼き込む(DOM/Canvas依存、
 * 自動テスト対象外、T24【改訂 2026-09-24】)。Canvas 2D APIの`ctx.lineWidth`は線全体で
 * 単一値しか取れず区間ごとに太さを変えられないため、ストロークではなく多角形の塗りつぶしで
 * テーパー形状を表現する(ARCH §5.2)。
 *
 * 【T25追補 新設 2026-09-24】背景に埋もれないよう、半透明のドロップシャドウ
 * (`arrowShadowParams()`)を`ctx.fill()`前に設定する。`ctx.shadow*`はfillと同時に適用される
 * ため、`ctx.save()`/`ctx.restore()`の対象内でのみ有効にし他の描画へ波及させない。
 */
export function drawTaperArrowPolygon(
  ctx: CanvasRenderingContext2D,
  polygon: TaperArrowPolygon,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  const shadow = arrowShadowParams(polygon.endWidth);
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = shadow.offsetY;

  ctx.beginPath();
  const [first, ...rest] = polygon.points;
  ctx.moveTo(first.x, first.y);
  for (const point of rest) {
    ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// T31【改訂 2026-09-24】: ポインタ結線(旧`bind*Tool()`)は、編集中の図形(リサイズ・移動)に
// 対応するため矢印・矩形・円の3ツール共通の`tools/shapeTools.ts::bindShapeTools()`へ移した。
// 本ファイルはツール固有の純粋関数(形状パラメータ・外接矩形)と描画関数のみを持つ。
