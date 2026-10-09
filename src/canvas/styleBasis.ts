//! 注釈の大きさ(線の太さ・文字の大きさ)を決める対角線の純粋関数(ARCH_quick-edits §5.1・§15 #1、ADR-002)。
//!
//! 普段は今の画像の対角線で決まる。トリミングの確定で残った注釈にだけ `styleBasis`
//! (切り詰める前の対角線)が付き、以後はその値で決まる(切る前に描いた注釈の大きさを保つ)。
//! 状態・DOM には依存しない。

/** 大きさの基準を持ちうる注釈(既存の各形と `StampShape` に共通する部分だけを見る)。 */
export interface StyleBasisCarrier {
  /** この注釈の大きさを決める対角線(px)。トリミングの確定で残った注釈にだけ付く。 */
  styleBasis?: number;
}

/** 注釈の大きさを決める対角線(px): `shape.styleBasis ?? hypot(今の幅, 今の高さ)`。 */
export function shapeStyleDiagonal(
  shape: StyleBasisCarrier,
  canvasWidth: number,
  canvasHeight: number,
): number {
  return shape.styleBasis ?? Math.hypot(canvasWidth, canvasHeight);
}
