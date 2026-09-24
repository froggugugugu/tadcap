//! Canvasピクセルのスナップショット比較ヘルパー(取り消し・やり直しのバイト一致検証用、T30)。
//!
//! `undo-redo.spec.ts`(T29)が個別に持っていた実装を共通化し、複数ツールを横断する
//! `annotation-tools.spec.ts`(T30)からも同じ判定を再利用できるようにする。

import type { Locator } from "@playwright/test";

/** Canvasの現在のピクセルを名前付きで保存する。 */
export async function saveSnapshot(canvas: Locator, name: string): Promise<void> {
  await canvas.evaluate((el: HTMLCanvasElement, key: string) => {
    const ctx = el.getContext("2d")!;
    const w = window as unknown as { __snapshots?: Record<string, Uint8ClampedArray> };
    w.__snapshots ??= {};
    w.__snapshots[key] = ctx.getImageData(0, 0, el.width, el.height).data.slice();
  }, name);
}

/** 保存したスナップショットと現在のCanvasで値が異なるバイト数(0なら完全一致)。 */
export async function diffFromSnapshot(canvas: Locator, name: string): Promise<number> {
  return canvas.evaluate((el: HTMLCanvasElement, key: string) => {
    const ctx = el.getContext("2d")!;
    const w = window as unknown as { __snapshots: Record<string, Uint8ClampedArray> };
    const before = w.__snapshots[key]!;
    const now = ctx.getImageData(0, 0, el.width, el.height).data;
    let diff = 0;
    for (let i = 0; i < now.length; i += 1) {
      if (now[i] !== before[i]) {
        diff += 1;
      }
    }
    return diff;
  }, name);
}
