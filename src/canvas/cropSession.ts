//! 確定前のトリミング範囲(QE-T21、ARCH_quick-edits §5.1・§6.1・§6.3・§7.1 C-1〜2・C-6)。
//!
//! 範囲は画像のピクセル座標(`{ rect } | null`)で、画像の内側に収めて持つ(小数のまま。整数化は確定時の
//! `crop.ts::normalizeCropRect()`)。取り消しの対象ではなく、メモリだけに持つ(NFR-002)。
//!
//! 書き換えるのは `tools/cropTool.ts`(開始・範囲の変更・Enter / Esc・やめる条件の購読)、`ui/cropBar.ts`
//! (確定・やめる)、`main.ts`(画像の差し替え前)、`ui/undoButton.ts`(範囲の指定中の ⌘Z)だけ(ARCH §6.3)。
//! `src/canvas/` の状態なので `ui/`・`ipc/` は import しない(ARCH §3.2)。

import { clipRectToCanvas, type Rect } from "./coords";

export interface CropSession {
  /** 残す範囲(画像のピクセル座標、幅・高さは 0 以上、画像の内側)。 */
  readonly rect: Rect;
}

type Listener = (session: CropSession | null) => void;

let session: CropSession | null = null;
const listeners = new Set<Listener>();

/**
 * 範囲の向きをそろえ(負の幅・高さ = 逆向きのドラッグ)、画像の内側(`[0, 幅] × [0, 高さ]`)に収める。
 * 完全に外なら幅・高さ 0 の範囲になる。
 */
export function clampCropRect(rect: Rect, canvasWidth: number, canvasHeight: number): Rect {
  const x = Math.min(rect.x, rect.x + rect.width);
  const y = Math.min(rect.y, rect.y + rect.height);
  return clipRectToCanvas(
    { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) },
    canvasWidth,
    canvasHeight,
  );
}

/** 今の範囲(無ければ`null`)。 */
export function getCropSession(): CropSession | null {
  return session;
}

/** 範囲を作る(既にあれば置き換える)。画像の内側に収める。 */
export function beginCrop(rect: Rect, canvasWidth: number, canvasHeight: number): void {
  commit({ rect: clampCropRect(rect, canvasWidth, canvasHeight) });
}

/** 範囲を変える(画像の内側に収める)。範囲が無ければ何もしない(範囲は`beginCrop()`で作る)。 */
export function updateCropRect(rect: Rect, canvasWidth: number, canvasHeight: number): void {
  if (!session) {
    return;
  }
  commit({ rect: clampCropRect(rect, canvasWidth, canvasHeight) });
}

/** 範囲を捨てる(画像は変えない)。 */
export function cancelCrop(): void {
  commit(null);
}

/** 範囲の変化を購読する。戻り値の関数を呼ぶと購読を解除する。 */
export function subscribeCropSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 変わったときだけ差し替えて購読者へ通知する。 */
function commit(next: CropSession | null): void {
  if (next === session || (next && session && sameRect(next.rect, session.rect))) {
    return;
  }
  session = next;
  for (const listener of listeners) {
    listener(session);
  }
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
