import { beforeEach, describe, expect, it } from "vitest";

import type { DocumentCommand, ImageDataLike } from "./commands";
import type { Rect } from "./coords";
import {
  UNDO_STACK_LIMIT,
  canRedo,
  canRedoState,
  canUndo,
  canUndoState,
  clearUndoStack,
  createUndoStackState,
  getUndoStackState,
  popRedo,
  popUndo,
  pushCommand,
  subscribeUndoStack,
  withPoppedRedo,
  withPoppedUndo,
  withPushedCommand,
  type UndoStackState,
} from "./undoStack";

function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

// 【改訂 2026-09-24 T32】要素を差分エントリ({rect, image})からコマンド(`commands.ts`)に変えた。
// スタックの性質(LIFO・上限30・新規操作でRedoクリア・取り消し⇄やり直しの往復)は従来どおり。

function makeImage(fill: number, width = 2, height = 2): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4).fill(fill);
  return { data, width, height };
}

function makeRect(x: number): Rect {
  return { x, y: 0, width: 4, height: 4 };
}

/** 判別しやすいテスト用コマンド(ピクセル系、`fill`でエントリを区別する)。 */
function cmd(i: number, fill = i): DocumentCommand {
  return { type: "pixels", rect: makeRect(i), image: makeImage(fill) };
}

/** 取り消し/やり直しの適用結果を模す(入れ替え方式: 反対側のピクセルに持ち替える)。 */
const swapTo =
  (fill: number) =>
  (entry: DocumentCommand): DocumentCommand =>
    entry.type === "pixels" ? { ...entry, image: makeImage(fill) } : entry;

describe("createUndoStackState", () => {
  it("Undo・Redo双方が空の初期状態を返す", () => {
    expect(createUndoStackState()).toEqual({ undo: [], redo: [] });
  });
});

describe("withPushedCommand(純粋関数)", () => {
  it("Undoスタックの末尾にコマンドを積み、Redoスタックをクリアする", () => {
    const withRedo: UndoStackState = { undo: [], redo: [cmd(0)] };
    const next = withPushedCommand(withRedo, cmd(1));
    expect(next.undo).toEqual([cmd(1)]);
    expect(next.redo).toEqual([]);
    expect(withRedo.redo).toEqual([cmd(0)]);
  });

  it(`上限(${String(30)}件)を超えたら最も古いコマンドから破棄する`, () => {
    let state = createUndoStackState();
    for (let i = 0; i < UNDO_STACK_LIMIT + 1; i++) {
      state = withPushedCommand(state, cmd(i));
    }
    expect(state.undo).toHaveLength(UNDO_STACK_LIMIT);
    expect(state.undo[0]).toEqual(cmd(1));
    expect(last(state.undo)).toEqual(cmd(UNDO_STACK_LIMIT));
  });
});

describe("withPoppedUndo / withPoppedRedo(純粋関数)", () => {
  it("空なら entry: null で、適用関数は呼ばれず状態も変わらない", () => {
    const state = createUndoStackState();
    const never = () => {
      throw new Error("呼ばれない");
    };
    expect(withPoppedUndo(state, never)).toEqual({ state, entry: null });
    expect(withPoppedRedo(state, never)).toEqual({ state, entry: null });
  });

  it("最上位(LIFO)を取り出し、適用関数が返したコマンドを反対側のスタックへ積む", () => {
    let state = withPushedCommand(withPushedCommand(createUndoStackState(), cmd(0)), cmd(1));
    const undone = withPoppedUndo(state, swapTo(200));
    expect(undone.entry).toEqual(cmd(1));
    expect(undone.state.undo).toEqual([cmd(0)]);
    expect(undone.state.redo).toEqual([cmd(1, 200)]);

    state = undone.state;
    const redone = withPoppedRedo(state, swapTo(1));
    expect(redone.entry).toEqual(cmd(1, 200));
    expect(redone.state.undo).toEqual([cmd(0), cmd(1)]);
    expect(redone.state.redo).toEqual([]);
  });

  it("Redoスタックも上限件数で頭打ちにする(安全弁)", () => {
    let state = createUndoStackState();
    for (let i = 0; i < UNDO_STACK_LIMIT; i++) {
      state = withPushedCommand(state, cmd(i));
    }
    state = { ...state, redo: Array.from({ length: UNDO_STACK_LIMIT }, (_, i) => cmd(100 + i)) };
    state = withPoppedUndo(state, (e) => e).state;
    expect(state.redo).toHaveLength(UNDO_STACK_LIMIT);
  });
});

describe("canUndoState / canRedoState(純粋関数)", () => {
  it("各スタックにコマンドがあるかを返す", () => {
    const empty = createUndoStackState();
    expect([canUndoState(empty), canRedoState(empty)]).toEqual([false, false]);
    const pushed = withPushedCommand(empty, cmd(0));
    expect([canUndoState(pushed), canRedoState(pushed)]).toEqual([true, false]);
    const popped = withPoppedUndo(pushed, (e) => e).state;
    expect([canUndoState(popped), canRedoState(popped)]).toEqual([false, true]);
  });
});

describe("undoStackストア(モジュール単位の薄い状態オブジェクト)", () => {
  beforeEach(() => {
    clearUndoStack();
  });

  it("pushCommandで積まれ、購読者に通知される", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeUndoStack((state) => received.push(state));
    pushCommand(cmd(0));
    expect(getUndoStackState().undo).toEqual([cmd(0)]);
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);
    expect(received).toHaveLength(1);
    unsubscribe();
    pushCommand(cmd(1));
    expect(received).toHaveLength(1);
  });

  it("popUndo/popRedoは取り出したコマンドを返し、往復できる", () => {
    pushCommand(cmd(7));
    expect(popUndo(swapTo(99))).toEqual(cmd(7));
    expect(canRedo()).toBe(true);
    expect(popRedo(swapTo(7))).toEqual(cmd(7, 99));
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);
  });

  it("popUndo後にpushCommand(新しい操作)するとRedoスタックがクリアされる", () => {
    pushCommand(cmd(0));
    popUndo((e) => e);
    pushCommand(cmd(1));
    expect(canRedo()).toBe(false);
  });

  it("取り消し・やり直し可能な操作が無い場合はnullを返す", () => {
    expect(popUndo((e) => e)).toBeNull();
    expect(popRedo((e) => e)).toBeNull();
  });

  it("clearUndoStackで双方が空になる", () => {
    pushCommand(cmd(0));
    pushCommand(cmd(1));
    popUndo((e) => e);
    clearUndoStack();
    expect(getUndoStackState()).toEqual({ undo: [], redo: [] });
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });
});
