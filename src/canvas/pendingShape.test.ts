import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasImage } from "./canvasState";
import {
  beginPendingShape,
  commitPendingShape,
  computeCommitStep,
  discardPendingShape,
  dropPendingShapeIfImageChanged,
  getPendingShape,
  hasPendingShape,
  setPendingShapeRestorer,
  subscribePendingShape,
  updatePendingShape,
  type PendingShape,
} from "./pendingShape";
import type { BoxShape } from "./shapeEdit";
import { shapeUndoRect } from "./shapeEdit";
import { clearUndoStack, getUndoStackState } from "./undoStack";

const W = 40;
const H = 30;

function makeBase(): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i++) {
    data[i] = i % 251;
  }
  return { data, width: W, height: H };
}

const image: CanvasImage = { assetUrl: "blob:a", capture: null };
const shape: BoxShape = {
  kind: "rectangle",
  rect: { x: 10, y: 8, width: 12, height: 10 },
  color: "#FF5C8A",
};

function pending(): PendingShape {
  return { shape, base: makeBase(), image };
}

beforeEach(() => {
  // 前のテストの編集中図形・Undoスタックを持ち越さない。
  setPendingShapeRestorer(null);
  discardPendingShape();
  clearUndoStack();
});

describe("computeCommitStep", () => {
  it("外接矩形(線幅の余白込み)とベース画像からの切り出し(before)を返す", () => {
    const p = pending();
    const step = computeCommitStep(p);
    const rect = shapeUndoRect(shape, W, H);
    expect(step.rect).toEqual(rect);
    expect(step.before.width).toBe(rect.width);
    expect(step.before.height).toBe(rect.height);
    // 左上1画素がベース画像の対応位置と一致する。
    const idx = (rect.y * W + rect.x) * 4;
    expect(Array.from(step.before.data.slice(0, 4))).toEqual(Array.from(p.base.data.slice(idx, idx + 4)));
  });
});

describe("編集中の図形ストア", () => {
  it("作成→リサイズ→移動→確定で、確定時に1回だけUndoステップが積まれる", () => {
    beginPendingShape(pending());
    expect(hasPendingShape()).toBe(true);
    expect(getUndoStackState().undo).toHaveLength(0);

    const resized: BoxShape = { ...shape, rect: { ...shape.rect, width: 20 } };
    updatePendingShape(resized);
    const moved: BoxShape = { ...resized, rect: { ...resized.rect, x: 12 } };
    updatePendingShape(moved);
    expect(getPendingShape()?.shape).toEqual(moved);
    expect(getUndoStackState().undo).toHaveLength(0);

    expect(commitPendingShape()).toBe(true);
    expect(hasPendingShape()).toBe(false);
    const undo = getUndoStackState().undo;
    expect(undo).toHaveLength(1);
    // 確定時の(移動後の)図形の外接矩形で積まれる。
    expect(undo[0].rect).toEqual(shapeUndoRect(moved, W, H));
  });

  it("編集中の図形が無いときの確定・破棄は何もしない(false)", () => {
    expect(commitPendingShape()).toBe(false);
    expect(discardPendingShape()).toBe(false);
    expect(getUndoStackState().undo).toHaveLength(0);
  });

  it("破棄(Esc・編集中のCmd+Z)はUndoへ積まず、ベース画像でCanvasを復元する", () => {
    const restorer = vi.fn();
    setPendingShapeRestorer(restorer);
    const p = pending();
    beginPendingShape(p);
    expect(discardPendingShape()).toBe(true);
    expect(restorer).toHaveBeenCalledWith(p.base);
    expect(hasPendingShape()).toBe(false);
    expect(getUndoStackState().undo).toHaveLength(0);
  });

  it("確定では復元しない(Canvasは既にベース+図形を表示している)", () => {
    const restorer = vi.fn();
    setPendingShapeRestorer(restorer);
    beginPendingShape(pending());
    commitPendingShape();
    expect(restorer).not.toHaveBeenCalled();
  });

  it("確定トリガーを経ずに画像が差し替わった場合は、古いベースを焼き戻さず破棄する", () => {
    const restorer = vi.fn();
    setPendingShapeRestorer(restorer);
    beginPendingShape(pending());
    expect(dropPendingShapeIfImageChanged(image)).toBe(false);
    expect(hasPendingShape()).toBe(true);

    const other: CanvasImage = { assetUrl: "blob:b", capture: null };
    expect(dropPendingShapeIfImageChanged(other)).toBe(true);
    expect(hasPendingShape()).toBe(false);
    expect(restorer).not.toHaveBeenCalled();
    expect(getUndoStackState().undo).toHaveLength(0);
  });

  it("状態変化を購読者へ通知する", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePendingShape(listener);
    beginPendingShape(pending());
    updatePendingShape(shape);
    commitPendingShape();
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenLastCalledWith(null);
  });

  it("別の図形を始める前に既存の編集中図形があれば確定する", () => {
    beginPendingShape(pending());
    beginPendingShape(pending());
    expect(getUndoStackState().undo).toHaveLength(1);
    expect(hasPendingShape()).toBe(true);
  });
});
