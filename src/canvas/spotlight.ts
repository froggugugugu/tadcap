//! スポットライトの暗さ(QE-T14、ARCH_quick-edits §1.3 #8・UI §3.1)。
//!
//! 穴(矩形)の和の外側を、**互いに重ならない矩形の集合**で返す純粋関数と、暗さの色の定数。
//! 合成側はこの矩形を 1 本のパスにして 1 回だけ塗る。`evenodd`/`nonzero` の 1 本のパスでは
//! 穴同士の重なりが再び塗られ、矩形を別々に塗ると端数の座標の境目に二重の半透明の線が出るため。
//! DOM・状態ストアに依存しない。

import { clipRectToCanvas, type Rect } from "./coords";

/** 穴の外側を 1 回だけ塗る色(UI §3.1。実機確認で弱ければ 60% に上げる)。 */
export const SPOTLIGHT_SHADE = "rgba(0, 0, 0, 0.5)";

/**
 * 画像 `width`×`height` のうち、どの穴 `holes` にも入らない領域を、互いに重ならない矩形の集合で返す。
 *
 * - 穴は画像に切り詰める。切り詰めて大きさが 0 になる穴(画像の外・幅 0 など)は無視する
 * - 穴の端の座標(と画像の端)で縦横に区切り、どの穴にも入らないマスを横につないで返す。
 *   端数の座標はそのまま区切りに使う(丸めない)
 * - 順序は決定論的: 上の帯から、帯の中は左から。穴の順序には依存しない
 * - 穴 0 個なら画像全体の 1 矩形。画像の大きさが 0 以下なら空配列
 * - 矩形の数は穴 n 個で高々 (2n+1)²(実際は帯 2n+1 本 × 帯ごとに高々 n+1 個)
 */
export function spotlightShadeRects(holes: readonly Rect[], width: number, height: number): Rect[] {
  if (!(width > 0) || !(height > 0)) return [];

  const clipped = holes
    .map((h) => clipRectToCanvas(h, width, height))
    .filter((h) => h.width > 0 && h.height > 0);

  const xs = sortedEdges(clipped.flatMap((h) => [h.x, h.x + h.width]), width);
  const ys = sortedEdges(clipped.flatMap((h) => [h.y, h.y + h.height]), height);

  const result: Rect[] = [];
  for (let j = 0; j + 1 < ys.length; j += 1) {
    const top = ys[j];
    const bottom = ys[j + 1];
    // 区切りの線は穴の端を含むので、マスは穴に完全に入るか完全に外れる。中心で判定する
    const cy = (top + bottom) / 2;
    const rowHoles = clipped.filter((h) => h.y <= cy && cy < h.y + h.height);

    let runStart: number | null = null;
    for (let i = 0; i + 1 < xs.length; i += 1) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const covered = rowHoles.some((h) => h.x <= cx && cx < h.x + h.width);
      if (!covered && runStart === null) runStart = xs[i];
      if (covered && runStart !== null) {
        result.push({ x: runStart, y: top, width: xs[i] - runStart, height: bottom - top });
        runStart = null;
      }
    }
    if (runStart !== null) {
      result.push({ x: runStart, y: top, width: width - runStart, height: bottom - top });
    }
  }
  return result;
}

/** `0`・`end` と穴の端を合わせ、昇順・重複なしにする(幅 0 のマスを作らないため)。 */
function sortedEdges(edges: readonly number[], end: number): number[] {
  return [...new Set([0, end, ...edges])].sort((a, b) => a - b);
}
