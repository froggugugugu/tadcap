//! 縮めてコピーの大きさと倍率(ARCH_quick-edits §1.3 #12、PRD_quick-edits FR-011・FR-012)。
//!
//! DOM に依存しない純粋関数だけを置く。実際の縮小は `render.ts::getCanvasImageData()` が
//! ここで決めた倍率・大きさで行う。`ui/`・`ipc/` は import しない(ARCH §3.2 の層の向き)。

/** 縮めた後の幅・高さ(px)。 */
export interface ShrunkSize {
  width: number;
  height: number;
}

/**
 * 元の幅・高さを `ratio` で割り、四捨五入した大きさを返す(最小 1px、FR-012)。
 *
 * `ratio` が 1 以下・有限でない値(`NaN`・`Infinity`)のときは縮めず、元の大きさを返す
 * (拡大はしない)。
 */
export function shrunkSize(width: number, height: number, ratio: number): ShrunkSize {
  if (!Number.isFinite(ratio) || ratio <= 1) {
    return { width, height };
  }
  return {
    width: Math.max(1, Math.round(width / ratio)),
    height: Math.max(1, Math.round(height / ratio)),
  };
}

/**
 * 縮めてコピーの設定と画像ごとの撮った画面の倍率から、コピーで使う倍率を決める。
 *
 * 設定がオフ、倍率が 1・不明(`null`/`undefined`)・不正値(2 以上の整数でない値)の
 * ときは 1(縮めない。今と同じ)を返す。
 */
export function copyRatio(enabled: boolean, pixelRatio: number | null | undefined): number {
  if (!enabled || pixelRatio == null) {
    return 1;
  }
  if (!Number.isInteger(pixelRatio) || pixelRatio < 2) {
    return 1;
  }
  return pixelRatio;
}
