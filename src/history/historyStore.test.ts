import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HISTORY_BYTES_LIMIT,
  HISTORY_LIMIT,
  addHistoryItem,
  createHistoryState,
  enforceHistoryBudget,
  selectHistoryEvictions,
  getHistoryState,
  getSelectedItem,
  selectHistoryItem,
  subscribeHistoryState,
  updateSelectedItemImage,
  withAddedItem,
  withSelectedId,
  withUpdatedItemImage,
  type HistoryItem,
} from "./historyStore";

function makeItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: "capture-1",
    image: "blob:tadcap/image-1",
    thumbnail: "blob:tadcap/thumb-1",
    bytes: 100,
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("上限の定数", () => {
  it("件数上限は20件、合計バイト数の上限は300MB", () => {
    expect(HISTORY_LIMIT).toBe(20);
    expect(HISTORY_BYTES_LIMIT).toBe(300 * 1024 * 1024);
  });
});

describe("selectHistoryEvictions(どれを破棄するかの判定、純粋関数)", () => {
  // 新しいものが先頭。
  const entries = (bytes: number[]) => bytes.map((b, i) => ({ id: `h${i}`, bytes: b }));

  it("件数・バイト数とも上限以内なら何も破棄しない", () => {
    expect(selectHistoryEvictions(entries([10, 10, 10]), "h0", 3, 30)).toEqual([]);
    expect(selectHistoryEvictions([], null, 3, 30)).toEqual([]);
  });

  it("件数上限を超えた分を古いもの(末尾)から破棄する", () => {
    expect(selectHistoryEvictions(entries([1, 1, 1, 1, 1]), "h0", 3, 1000)).toEqual(["h4", "h3"]);
  });

  it("合計バイト数が上限を超えたら、上限以下になるまで古いものから破棄する", () => {
    // 合計100、上限60 → h3(40)を捨てて60。
    expect(selectHistoryEvictions(entries([10, 20, 30, 40]), "h0", 10, 60)).toEqual(["h3"]);
    // 上限59 → h3・h2を捨てて30。
    expect(selectHistoryEvictions(entries([10, 20, 30, 40]), "h0", 10, 59)).toEqual(["h3", "h2"]);
  });

  it("表示中(選択中)の項目は最も古くても破棄しない", () => {
    expect(selectHistoryEvictions(entries([10, 20, 30, 40]), "h3", 10, 60)).toEqual(["h2", "h1"]);
    expect(selectHistoryEvictions(entries([1, 1, 1, 1]), "h3", 2, 1000)).toEqual(["h2", "h1"]);
  });

  it("選択中の項目だけで上限を超える場合は、それ以外を全部捨てたところで止まる", () => {
    expect(selectHistoryEvictions(entries([10, 500]), "h1", 10, 100)).toEqual(["h0"]);
  });
});

describe("createHistoryState", () => {
  it("項目なし・未選択の初期状態を返す", () => {
    expect(createHistoryState()).toEqual({ items: [], selectedId: null });
  });
});

describe("withAddedItem(追加・並び順・上限による破棄、純粋関数)", () => {
  it("項目を追加し、その項目を選択状態にする", () => {
    const state = createHistoryState();
    const item = makeItem();

    const { state: next, evicted } = withAddedItem(state, item);

    expect(next.items).toEqual([item]);
    expect(next.selectedId).toBe(item.id);
    expect(evicted).toEqual([]);
  });

  it("元の状態を変更しない(イミュータブル)", () => {
    const state = createHistoryState();
    const item = makeItem();

    withAddedItem(state, item);

    expect(state.items).toEqual([]);
    expect(state.selectedId).toBeNull();
  });

  it("新しい項目が先頭(index 0)に来る(新しいものが上、PJM決定)", () => {
    const state = createHistoryState();
    const first = makeItem({ id: "capture-1" });
    const second = makeItem({ id: "capture-2" });

    const afterFirst = withAddedItem(state, first).state;
    const afterSecond = withAddedItem(afterFirst, second).state;

    expect(afterSecond.items.map((it) => it.id)).toEqual([
      "capture-2",
      "capture-1",
    ]);
  });

  it(`HISTORY_LIMIT(${HISTORY_LIMIT}件)を超えると最も古い項目から破棄される`, () => {
    let state = createHistoryState();
    for (let i = 0; i < HISTORY_LIMIT; i += 1) {
      state = withAddedItem(state, makeItem({ id: `capture-${i}` })).state;
    }
    expect(state.items).toHaveLength(HISTORY_LIMIT);

    const overflow = makeItem({ id: "capture-overflow" });
    const { state: next, evicted } = withAddedItem(state, overflow);

    expect(next.items).toHaveLength(HISTORY_LIMIT);
    expect(next.items[0]?.id).toBe("capture-overflow");
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.id).toBe("capture-0");
    expect(next.items.some((it) => it.id === "capture-0")).toBe(false);
  });

  it("上限未達のときは破棄が発生しない", () => {
    const state = createHistoryState();
    const { evicted } = withAddedItem(state, makeItem());
    expect(evicted).toEqual([]);
  });
});

describe("withSelectedId(選択、純粋関数)", () => {
  it("存在するidを選択状態にする", () => {
    const item = makeItem();
    const state = withAddedItem(createHistoryState(), item).state;
    const other = withAddedItem(state, makeItem({ id: "capture-2" })).state;

    const next = withSelectedId(other, item.id);

    expect(next.selectedId).toBe(item.id);
  });

  it("存在しないidを指定した場合は元の状態のまま変更しない", () => {
    const state = withAddedItem(createHistoryState(), makeItem()).state;

    const next = withSelectedId(state, "not-exist");

    expect(next).toEqual(state);
  });
});

describe("withUpdatedItemImage(上書き、純粋関数)", () => {
  it("指定idの項目のimage/thumbnailを上書きし、id/createdAtは変えない", () => {
    const item = makeItem();
    const state = withAddedItem(createHistoryState(), item).state;

    const { state: next, replaced } = withUpdatedItemImage(state, item.id, {
      image: "blob:tadcap/image-1-edited",
      thumbnail: "blob:tadcap/thumb-1-edited",
      bytes: 321,
    });

    const updated = next.items.find((it) => it.id === item.id);
    expect(updated).toEqual({
      id: item.id,
      createdAt: item.createdAt,
      image: "blob:tadcap/image-1-edited",
      thumbnail: "blob:tadcap/thumb-1-edited",
      bytes: 321,
    });
    expect(replaced).toEqual({ image: item.image, thumbnail: item.thumbnail, bytes: item.bytes });
  });

  it("存在しないidを指定した場合は元の状態のまま、replacedはnull", () => {
    const state = withAddedItem(createHistoryState(), makeItem()).state;

    const { state: next, replaced } = withUpdatedItemImage(state, "not-exist", {
      image: "x",
      thumbnail: "y",
      bytes: 1,
    });

    expect(next).toEqual(state);
    expect(replaced).toBeNull();
  });

  it("元の状態を変更しない(イミュータブル)", () => {
    const item = makeItem();
    const state = withAddedItem(createHistoryState(), item).state;

    withUpdatedItemImage(state, item.id, { image: "x", thumbnail: "y", bytes: 1 });

    expect(state.items[0]).toEqual(item);
  });
});

describe("getSelectedItem", () => {
  it("選択中の項目を返す", () => {
    const item = makeItem();
    const state = withAddedItem(createHistoryState(), item).state;

    expect(getSelectedItem(state)).toEqual(item);
  });

  it("未選択(selectedId: null)のときはnullを返す", () => {
    expect(getSelectedItem(createHistoryState())).toBeNull();
  });
});

describe("historyStoreストア(モジュール単位の薄い状態オブジェクト、canvasStateと同じ作法)", () => {
  beforeEach(() => {
    // 各テスト間で状態を独立させるため、モジュール内シングルトンを初期状態相当にリセットする。
    // 直接resetする公開APIは無いため、既存項目を全て新規追加で上書きせず、
    // 代わりにテストごとに一意なidを使うことで副作用を避ける。
  });

  it("addHistoryItemで項目が追加・選択され、購読者に通知される", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeHistoryState((state) => received.push(state));
    const item = makeItem({ id: `store-add-${Date.now()}` });

    const evicted = addHistoryItem(item);

    expect(getHistoryState().items[0]).toEqual(item);
    expect(getHistoryState().selectedId).toBe(item.id);
    expect(evicted).toEqual([]);
    expect(received).toHaveLength(1);
    unsubscribe();
  });

  it("selectHistoryItemで選択項目が切り替わり、購読者に通知される", () => {
    const idA = `store-select-a-${Date.now()}`;
    const idB = `store-select-b-${Date.now()}`;
    addHistoryItem(makeItem({ id: idA }));
    addHistoryItem(makeItem({ id: idB }));
    expect(getHistoryState().selectedId).toBe(idB);

    const received: unknown[] = [];
    const unsubscribe = subscribeHistoryState((state) => received.push(state));

    selectHistoryItem(idA);

    expect(getHistoryState().selectedId).toBe(idA);
    expect(received).toHaveLength(1);
    unsubscribe();
  });

  it("updateSelectedItemImageで選択中項目のimage/thumbnailが上書きされ、旧URLがreplacedとして返る", () => {
    const id = `store-update-${Date.now()}`;
    addHistoryItem(makeItem({ id, image: "blob:old-image", thumbnail: "blob:old-thumb" }));

    const replaced = updateSelectedItemImage({
      image: "blob:new-image",
      thumbnail: "blob:new-thumb",
      bytes: 7,
    });

    const updated = getHistoryState().items.find((it) => it.id === id);
    expect(updated?.image).toBe("blob:new-image");
    expect(updated?.thumbnail).toBe("blob:new-thumb");
    expect(updated?.bytes).toBe(7);
    expect(replaced).toEqual({ image: "blob:old-image", thumbnail: "blob:old-thumb", bytes: 100 });
  });

  it("enforceHistoryBudgetは合計バイト数(履歴画像+追加分)の上限を超えた古い項目を破棄し、ObjectURLをrevokeする", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const half = HISTORY_BYTES_LIMIT / 2;
    const idA = `store-budget-a-${Date.now()}`;
    const idB = `store-budget-b-${Date.now()}`;
    const idC = `store-budget-c-${Date.now()}`;
    addHistoryItem(makeItem({ id: idA, bytes: half, image: "blob:a-image", thumbnail: "blob:a-thumb" }));
    addHistoryItem(makeItem({ id: idB, bytes: half }));
    addHistoryItem(makeItem({ id: idC, bytes: 10 }));

    // 退避分(extraBytesOf)も合計に含める。Cは表示中なので大きくても残る。
    const evicted = enforceHistoryBudget((id) => (id === idC ? half : 0));
    const ids = getHistoryState().items.map((it) => it.id);

    expect(evicted.map((it) => it.id)).toContain(idA);
    expect(evicted.map((it) => it.id)).not.toContain(idC);
    expect(ids).not.toContain(idA);
    expect(ids).toContain(idC);
    expect(revoke).toHaveBeenCalledWith("blob:a-image");
    expect(revoke).toHaveBeenCalledWith("blob:a-thumb");
    revoke.mockRestore();
  });

  it("unsubscribe後は通知されない", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeHistoryState((state) => received.push(state));
    unsubscribe();

    addHistoryItem(makeItem({ id: `store-unsub-${Date.now()}` }));

    expect(received).toHaveLength(0);
  });
});
