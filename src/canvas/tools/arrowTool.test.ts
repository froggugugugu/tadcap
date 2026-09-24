import { describe, expect, it } from "vitest";

import {
  arrowHeadLength,
  arrowHeadWidth,
  arrowLineWidth,
  arrowShadowParams,
  computeArrowGeometry,
  computeTaperArrowBoundingRect,
  computeTaperArrowPolygon,
} from "./arrowTool";

// T25追補【改訂 2026-09-24】: 人間からのフィードバック(project-config.md §11参照。
// 「テーパー矢印の終点側の太さが細すぎる、もっとインパクトのある太さにしたい」)を受け、
// 終点側の太さ(旧8px→20px前後)・矢じり寸法・視認性を高めるドロップシャドウを改訂した
// (PJM経由で人間の承認を確認したうえで着手、T25完了後)。
describe("arrowLineWidth", () => {
  // T31【改訂 2026-09-24】人間要望「矢印はもっと太くて良い、今の1.5倍」を受け、比率・上下限を
  // 1.5倍(0.009→0.0135、6→9、48→72)にした。矢じり・影は胴幅比のため自動で追従する。
  it("典型的な画像サイズ(2000x1000)では対角線比率から30pxになる(T31で旧20pxの1.5倍)", () => {
    expect(arrowLineWidth(2000, 1000)).toBe(30);
  });

  it("非常に小さい画像では下限(9px、旧6pxの1.5倍)にクランプする", () => {
    expect(arrowLineWidth(10, 10)).toBe(9);
  });

  it("5K相当(5120x2880)では上限(72px、旧48pxの1.5倍)にクランプする", () => {
    expect(arrowLineWidth(5120, 2880)).toBe(72);
  });

  it("非常に大きい画像では上限(72px)にクランプする", () => {
    expect(arrowLineWidth(8000, 6000)).toBe(72);
  });
});

describe("arrowHeadLength", () => {
  it("線幅の3倍を矢じりの長さとする(目安レンジ2.5〜3の上限、インパクト重視)", () => {
    expect(arrowHeadLength(20)).toBe(60);
    expect(arrowHeadLength(6)).toBe(18);
  });
});

describe("arrowHeadWidth", () => {
  it("線幅の2.4倍を矢じりの幅(左右スパン)とする(目安レンジ2.2〜2.6の中央値)", () => {
    expect(arrowHeadWidth(20)).toBe(48);
    expect(arrowHeadWidth(6)).toBeCloseTo(14.4, 6);
  });

  it("矢じりの幅は胴の太さよりはっきり大きい(常に2倍超、視認性のためのインパクト重視)", () => {
    expect(arrowHeadWidth(20)).toBeGreaterThan(20 * 2);
  });
});

describe("arrowShadowParams", () => {
  it("胴の太さに比例してぼかし半径・下方向オフセットを算出する", () => {
    const shadow = arrowShadowParams(20);
    expect(shadow.blur).toBeCloseTo(6, 6);
    expect(shadow.offsetY).toBeCloseTo(5, 6);
    expect(shadow.color).toMatch(/^rgba\(0,\s*0,\s*0,/);
  });

  it("胴が細いほどぼかし・オフセットも小さくなる(スケール非依存で不自然に見えない)", () => {
    const small = arrowShadowParams(6);
    const large = arrowShadowParams(48);
    expect(small.blur).toBeLessThan(large.blur);
    expect(small.offsetY).toBeLessThan(large.offsetY);
  });
});

describe("computeArrowGeometry", () => {
  const canvasWidth = 2000;
  const canvasHeight = 1000;

  it("矢じり左右2点は終点からheadLength手前を中心にheadWidth離れて、進行方向と直交する軸上に対称配置される(斜めドラッグ)", () => {
    const start = { x: 100, y: 100 };
    const end = { x: 500, y: 300 };
    const geometry = computeArrowGeometry(start, end, canvasWidth, canvasHeight);

    expect(geometry).not.toBeNull();
    const { lineWidth, headLength, headWidth, head } = geometry!;
    expect(lineWidth).toBe(arrowLineWidth(canvasWidth, canvasHeight));
    expect(headLength).toBe(arrowHeadLength(lineWidth));
    expect(headWidth).toBe(arrowHeadWidth(lineWidth));
    expect(head.tip).toEqual(end);

    // 左右の中点は、終点からheadLength手前(進行方向の直線上)の点になる。
    const midX = (head.left.x + head.right.x) / 2;
    const midY = (head.left.y + head.right.y) / 2;
    expect(Math.hypot(end.x - midX, end.y - midY)).toBeCloseTo(headLength, 6);

    // 左右の間隔はheadWidthに一致する。
    expect(
      Math.hypot(head.left.x - head.right.x, head.left.y - head.right.y),
    ).toBeCloseTo(headWidth, 6);

    // 左右を結ぶ線は進行方向(start→end)と直交する(内積0)。
    const dirX = end.x - start.x;
    const dirY = end.y - start.y;
    const spreadX = head.left.x - head.right.x;
    const spreadY = head.left.y - head.right.y;
    expect(dirX * spreadX + dirY * spreadY).toBeCloseTo(0, 6);
  });

  it("水平方向のドラッグでは矢じり左右が終点の真上・真下に対称配置される", () => {
    const geometry = computeArrowGeometry(
      { x: 100, y: 100 },
      { x: 500, y: 100 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry).not.toBeNull();
    const { headLength, headWidth, head } = geometry!;
    expect(head.left.x).toBeCloseTo(500 - headLength, 6);
    expect(head.right.x).toBeCloseTo(500 - headLength, 6);
    expect(Math.abs(head.left.y - 100)).toBeCloseTo(headWidth / 2, 6);
    expect(Math.abs(head.right.y - 100)).toBeCloseTo(headWidth / 2, 6);
    expect(head.left.y).not.toBeCloseTo(head.right.y, 3);
  });

  it("ドラッグ距離が最小しきい値(2px)未満のときはnullを返す(誤クリック対策)", () => {
    const geometry = computeArrowGeometry(
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry).toBeNull();
  });

  it("始点と終点が同一のときはnullを返す", () => {
    const geometry = computeArrowGeometry(
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      canvasWidth,
      canvasHeight,
    );

    expect(geometry).toBeNull();
  });
});

// T24【新設 2026-09-24】: テーパー矢印(始点から終点へ徐々に太くなる単一多角形、PRD FR-006改訂・
// ARCH §5.2)。頂点は既存 computeArrowGeometry() の値を再利用して算出するため、ハードコードした
// 浮動小数点の期待値ではなく、同一入力での computeArrowGeometry() の呼び出し結果や幾何的な
// 関係(中点・距離)と比較する形でテストする(丸め誤差に強く、算出ロジックの変更にも追従しやすい)。
describe("computeTaperArrowPolygon", () => {
  const canvasWidth = 2000;
  const canvasHeight = 1000;

  it("矢じり3点(tip/left/right)は既存computeArrowGeometry()と同じ算出になる", () => {
    const start = { x: 100, y: 100 };
    const end = { x: 500, y: 100 };
    const geometry = computeArrowGeometry(start, end, canvasWidth, canvasHeight);
    const polygon = computeTaperArrowPolygon(start, end, canvasWidth, canvasHeight);

    expect(geometry).not.toBeNull();
    expect(polygon).not.toBeNull();
    // points: [始点左, 矢じり基部左, 矢じり左翼, 先端, 矢じり右翼, 矢じり基部右, 始点右]
    expect(polygon?.points[2]).toEqual(geometry?.head.left);
    expect(polygon?.points[3]).toEqual(geometry?.head.tip);
    expect(polygon?.points[4]).toEqual(geometry?.head.right);
  });

  it("終点側の太さは既存arrowLineWidth()の算出値と一致する(算出基準を変更しない、PRD決定#1継承)", () => {
    const start = { x: 100, y: 100 };
    const end = { x: 500, y: 100 };
    const polygon = computeTaperArrowPolygon(start, end, canvasWidth, canvasHeight);

    expect(polygon?.endWidth).toBe(arrowLineWidth(canvasWidth, canvasHeight));
  });

  it("始点側の太さは終点側の太さ以下になる(常にテーパー形状、終点以下へクランプ)", () => {
    const polygon = computeTaperArrowPolygon(
      { x: 100, y: 100 },
      { x: 500, y: 100 },
      canvasWidth,
      canvasHeight,
    );

    expect(polygon).not.toBeNull();
    expect(polygon!.startWidth).toBeGreaterThan(0);
    expect(polygon!.startWidth).toBeLessThanOrEqual(polygon!.endWidth);
  });

  it("始点側の左右2点は始点を中心にstartWidth離れて対称に配置される", () => {
    const start = { x: 100, y: 100 };
    const polygon = computeTaperArrowPolygon(
      start,
      { x: 500, y: 100 },
      canvasWidth,
      canvasHeight,
    );

    expect(polygon).not.toBeNull();
    const [startLeft, , , , , , startRight] = polygon!.points;
    expect(
      Math.hypot(startLeft.x - startRight.x, startLeft.y - startRight.y),
    ).toBeCloseTo(polygon!.startWidth, 6);
    expect((startLeft.x + startRight.x) / 2).toBeCloseTo(start.x, 6);
    expect((startLeft.y + startRight.y) / 2).toBeCloseTo(start.y, 6);
  });

  it("矢じり基部の左右2点は終点からheadLength手前・endWidth離れて対称に配置される(斜めドラッグ)", () => {
    const start = { x: 0, y: 0 };
    const end = { x: 300, y: 300 };
    const polygon = computeTaperArrowPolygon(start, end, canvasWidth, canvasHeight);

    expect(polygon).not.toBeNull();
    const [, baseLeft, , , , baseRight] = polygon!.points;
    expect(
      Math.hypot(baseLeft.x - baseRight.x, baseLeft.y - baseRight.y),
    ).toBeCloseTo(polygon!.endWidth, 6);
    const baseMidX = (baseLeft.x + baseRight.x) / 2;
    const baseMidY = (baseLeft.y + baseRight.y) / 2;
    expect(Math.hypot(end.x - baseMidX, end.y - baseMidY)).toBeCloseTo(
      polygon!.headLength,
      6,
    );
  });

  it("ドラッグ距離が最小しきい値(2px)未満のときはnullを返す(誤クリック対策)", () => {
    const polygon = computeTaperArrowPolygon(
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      canvasWidth,
      canvasHeight,
    );

    expect(polygon).toBeNull();
  });

  it("始点と終点が同一のときはnullを返す", () => {
    const polygon = computeTaperArrowPolygon(
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      canvasWidth,
      canvasHeight,
    );

    expect(polygon).toBeNull();
  });
});

describe("computeTaperArrowBoundingRect", () => {
  const canvasWidth = 2000;
  const canvasHeight = 1000;

  it("多角形の全頂点を線の太さ分の余白付きで包含する整数矩形を返す", () => {
    const start = { x: 100, y: 100 };
    const end = { x: 500, y: 100 };
    const polygon = computeTaperArrowPolygon(start, end, canvasWidth, canvasHeight);
    expect(polygon).not.toBeNull();

    const rect = computeTaperArrowBoundingRect(polygon!, canvasWidth, canvasHeight);

    const xs = polygon!.points.map((p) => p.x);
    const ys = polygon!.points.map((p) => p.y);
    // 余白(線の太さ分)を含むため、少なくとも多角形の外接矩形そのものは完全に包含する。
    expect(rect.x).toBeLessThanOrEqual(Math.min(...xs));
    expect(rect.y).toBeLessThanOrEqual(Math.min(...ys));
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(Math.max(...xs));
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(Math.max(...ys));
    // 余白が実際に加わっている(外接矩形ぴったりではない)ことも確認する。
    expect(rect.x).toBeLessThan(Math.min(...xs));
    expect(rect.x + rect.width).toBeGreaterThan(Math.max(...xs));
    // 整数座標(getImageData/putImageDataへそのまま渡せること)。
    expect(Number.isInteger(rect.x)).toBe(true);
    expect(Number.isInteger(rect.y)).toBe(true);
    expect(Number.isInteger(rect.width)).toBe(true);
    expect(Number.isInteger(rect.height)).toBe(true);
  });

  it("Canvas端に近い矢印では矩形がCanvas範囲内へクリップされる", () => {
    const start = { x: 0, y: 0 };
    const end = { x: 5, y: 5 };
    const polygon = computeTaperArrowPolygon(start, end, canvasWidth, canvasHeight);
    expect(polygon).not.toBeNull();

    const rect = computeTaperArrowBoundingRect(polygon!, canvasWidth, canvasHeight);

    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(canvasWidth);
    expect(rect.y + rect.height).toBeLessThanOrEqual(canvasHeight);
  });

  // T25追補【新設 2026-09-24】: ドロップシャドウ追加に伴い、余白 = 胴の太さ(アンチ
  // エイリアシング安全マージン) + ぼかし半径×2 + 下方向オフセットになったことを、
  // 水平ドラッグ(Canvas中央、クリップされない)で正確な数値まで固定してテストする。
  it("余白にはドロップシャドウのぼかし・下方向オフセット分も含まれる(水平ドラッグで厳密値を検証)", () => {
    const start = { x: 500, y: 500 };
    const end = { x: 1500, y: 500 };
    const polygon = computeTaperArrowPolygon(start, end, canvasWidth, canvasHeight);
    expect(polygon).not.toBeNull();

    const rect = computeTaperArrowBoundingRect(polygon!, canvasWidth, canvasHeight);
    const shadow = arrowShadowParams(polygon!.endWidth);
    const expectedMargin = polygon!.endWidth + shadow.blur * 2 + shadow.offsetY;

    const xs = polygon!.points.map((p) => p.x);
    const ys = polygon!.points.map((p) => p.y);
    expect(rect.x).toBe(Math.round(Math.min(...xs) - expectedMargin));
    expect(rect.y).toBe(Math.round(Math.min(...ys) - expectedMargin));
    expect(rect.x + rect.width).toBe(Math.round(Math.max(...xs) + expectedMargin));
    expect(rect.y + rect.height).toBe(Math.round(Math.max(...ys) + expectedMargin));
  });
});

// T25【改訂 2026-09-24】: `cropSnapshotRect()`のテストは`../coords.test.ts`へ移設した
// (定義本体を`coords.ts`へ移設したため、Rule of Three)。
