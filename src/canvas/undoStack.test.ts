import { beforeEach, describe, expect, it } from "vitest";

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
  pushUndoStep,
  subscribeUndoStack,
  withPoppedRedo,
  withPoppedUndo,
  withPushedUndoStep,
  type ImageDataLike,
  type Rect,
  type UndoStackState,
} from "./undoStack";

/** テスト用の`ImageDataLike`を作る。`fill`値でエントリを判別しやすくする。 */
function makeImage(fill: number, width = 2, height = 2): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4).fill(fill);
  return { data, width, height };
}

function makeRect(x: number): Rect {
  return { x, y: 0, width: 4, height: 4 };
}

describe("createUndoStackState", () => {
  it("Undo・Redo双方が空の初期状態を返す", () => {
    expect(createUndoStackState()).toEqual({ undo: [], redo: [] });
  });
});

describe("withPushedUndoStep(純粋関数)", () => {
  it("Undoスタックの末尾にエントリを積む", () => {
    const state = createUndoStackState();
    const rect = makeRect(0);
    const before = makeImage(10);

    const next = withPushedUndoStep(state, rect, before);

    expect(next.undo).toEqual([{ rect, image: before }]);
  });

  it("Redoスタックをクリアする(PRD FR-014: 新しい注釈操作でRedoは無効化される)", () => {
    const withRedo: UndoStackState = {
      undo: [],
      redo: [{ rect: makeRect(0), image: makeImage(1) }],
    };

    const next = withPushedUndoStep(withRedo, makeRect(1), makeImage(2));

    expect(next.redo).toEqual([]);
  });

  it("元の状態を変更しない(イミュータブル)", () => {
    const state = createUndoStackState();

    withPushedUndoStep(state, makeRect(0), makeImage(1));

    expect(state.undo).toEqual([]);
  });

  it(`上限(${String(30)}件)を超えたら最も古いエントリから破棄する`, () => {
    let state = createUndoStackState();
    for (let i = 0; i < UNDO_STACK_LIMIT + 1; i++) {
      state = withPushedUndoStep(state, makeRect(i), makeImage(i));
    }

    expect(state.undo).toHaveLength(UNDO_STACK_LIMIT);
    // 0番目(最初に積んだもの)は破棄され、1番目(2番目に積んだもの)が最古として残る。
    expect(state.undo[0]!.rect).toEqual(makeRect(1));
    // 最後に積んだものは残っている。
    expect(state.undo[state.undo.length - 1]!.rect).toEqual(makeRect(UNDO_STACK_LIMIT));
  });
});

describe("withPoppedUndo(純粋関数)", () => {
  it("Undoスタックが空なら entry: null を返し、状態は変化しない", () => {
    const state = createUndoStackState();

    const result = withPoppedUndo(state, makeImage(99));

    expect(result.entry).toBeNull();
    expect(result.state).toEqual(state);
  });

  it("Undoスタックの最上位(最後に積んだもの)を取り出す(LIFO)", () => {
    let state = createUndoStackState();
    state = withPushedUndoStep(state, makeRect(0), makeImage(0));
    state = withPushedUndoStep(state, makeRect(1), makeImage(1));

    const result = withPoppedUndo(state, makeImage(100));

    expect(result.entry).toEqual({ rect: makeRect(1), image: makeImage(1) });
    expect(result.state.undo).toEqual([{ rect: makeRect(0), image: makeImage(0) }]);
  });

  it("取り出した際に渡された現在の画像(currentImage)をRedoスタックへ積む", () => {
    let state = createUndoStackState();
    state = withPushedUndoStep(state, makeRect(0), makeImage(0));

    const result = withPoppedUndo(state, makeImage(200));

    expect(result.state.redo).toEqual([{ rect: makeRect(0), image: makeImage(200) }]);
  });

  it("Redoスタックも上限件数で頭打ちにする(安全弁)", () => {
    let state = createUndoStackState();
    for (let i = 0; i < UNDO_STACK_LIMIT; i++) {
      state = withPushedUndoStep(state, makeRect(i), makeImage(i));
    }
    for (let i = 0; i < UNDO_STACK_LIMIT; i++) {
      const result = withPoppedUndo(state, makeImage(1000 + i));
      state = result.state;
    }

    expect(state.redo).toHaveLength(UNDO_STACK_LIMIT);
  });
});

describe("withPoppedRedo(純粋関数、withPoppedUndoと対称)", () => {
  it("Redoスタックが空なら entry: null を返し、状態は変化しない", () => {
    const state = createUndoStackState();

    const result = withPoppedRedo(state, makeImage(99));

    expect(result.entry).toBeNull();
    expect(result.state).toEqual(state);
  });

  it("Undo→Redoの往復でrectを保ったまま画像だけが入れ替わる(ping-pong)", () => {
    let state = createUndoStackState();
    const before = makeImage(1);
    state = withPushedUndoStep(state, makeRect(5), before);

    const afterUndo = withPoppedUndo(state, makeImage(2)); // 2 = 焼き込み後(取り消し直前)の画像
    state = afterUndo.state;
    expect(afterUndo.entry).toEqual({ rect: makeRect(5), image: before });

    const afterRedo = withPoppedRedo(state, makeImage(3)); // 3 = 取り消し後(やり直し直前)の画像
    state = afterRedo.state;
    // Redoは取り消し時に積まれた「焼き込み後」の画像(2)を返す。
    expect(afterRedo.entry).toEqual({ rect: makeRect(5), image: makeImage(2) });
    // やり直し実行時点の画像(3)は新しいUndoエントリとして積まれる。
    expect(state.undo).toEqual([{ rect: makeRect(5), image: makeImage(3) }]);
    expect(state.redo).toEqual([]);
  });
});

describe("canUndoState / canRedoState(純粋関数)", () => {
  it("両スタックが空なら両方falseを返す", () => {
    const state = createUndoStackState();
    expect(canUndoState(state)).toBe(false);
    expect(canRedoState(state)).toBe(false);
  });

  it("Undoスタックにエントリがあればtrueを返す", () => {
    const state = withPushedUndoStep(createUndoStackState(), makeRect(0), makeImage(0));
    expect(canUndoState(state)).toBe(true);
    expect(canRedoState(state)).toBe(false);
  });

  it("Redoスタックにエントリがあればtrueを返す", () => {
    const pushed = withPushedUndoStep(createUndoStackState(), makeRect(0), makeImage(0));
    const { state } = withPoppedUndo(pushed, makeImage(1));
    expect(canRedoState(state)).toBe(true);
  });
});

describe("undoStackストア(モジュール単位の薄い状態オブジェクト、canvasStateと同じ作法)", () => {
  beforeEach(() => {
    clearUndoStack();
  });

  it("pushUndoStepでUndoスタックへ積まれ、購読者に通知される", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeUndoStack((state) => received.push(state));

    pushUndoStep(makeRect(0), makeImage(1));

    expect(getUndoStackState().undo).toEqual([{ rect: makeRect(0), image: makeImage(1) }]);
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);
    expect(received).toHaveLength(1);
    unsubscribe();
  });

  it("push/popの対応関係: popUndoはpushUndoStepで積んだ内容をそのまま返す", () => {
    const before = makeImage(42);
    pushUndoStep(makeRect(7), before);

    const entry = popUndo(makeImage(99));

    expect(entry).toEqual({ rect: makeRect(7), image: before });
  });

  it("上限30件超過時、ストアレベルでも最も古いエントリが破棄される", () => {
    for (let i = 0; i < UNDO_STACK_LIMIT + 1; i++) {
      pushUndoStep(makeRect(i), makeImage(i));
    }

    expect(getUndoStackState().undo).toHaveLength(UNDO_STACK_LIMIT);
    expect(getUndoStackState().undo[0]!.rect).toEqual(makeRect(1));
  });

  it("popUndo後にpushUndoStep(新規描画)するとRedoスタックがクリアされる", () => {
    pushUndoStep(makeRect(0), makeImage(0));
    popUndo(makeImage(1));
    expect(canRedo()).toBe(true);

    pushUndoStep(makeRect(1), makeImage(2));

    expect(canRedo()).toBe(false);
  });

  it("popRedoはpopUndoと対称に動作し、Undoスタックへ戻す", () => {
    pushUndoStep(makeRect(0), makeImage(0));
    popUndo(makeImage(1));

    const entry = popRedo(makeImage(2));

    expect(entry).toEqual({ rect: makeRect(0), image: makeImage(1) });
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);
  });

  it("取り消し可能な操作が無い場合、popUndoはnullを返す(何もしない)", () => {
    expect(popUndo(makeImage(0))).toBeNull();
  });

  it("やり直し可能な操作が無い場合、popRedoはnullを返す(何もしない)", () => {
    expect(popRedo(makeImage(0))).toBeNull();
  });

  it("clearUndoStackでUndo・Redo双方が空になり、canUndo()/canRedo()がfalseを返す", () => {
    pushUndoStep(makeRect(0), makeImage(0));
    pushUndoStep(makeRect(1), makeImage(1));
    popUndo(makeImage(2));
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(true);

    clearUndoStack();

    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
    expect(getUndoStackState()).toEqual({ undo: [], redo: [] });
  });

  it("unsubscribe後は通知されない", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeUndoStack((state) => received.push(state));
    unsubscribe();

    pushUndoStep(makeRect(0), makeImage(0));

    expect(received).toHaveLength(0);
  });
});
