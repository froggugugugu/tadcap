import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addHistoryItem,
  clearHistory,
  getHistoryState,
  selectHistoryItem,
  type HistoryItem,
} from "../history/historyStore";
import {
  handleClearAll,
  handleItemClick,
  handleItemDelete,
  type ItemClickCallbacks,
  type SidebarCallbacks,
} from "./sidebar";

function makeItem(id: string): HistoryItem {
  return {
    id,
    image: `blob:tadcap/${id}-image`,
    thumbnail: `blob:tadcap/${id}-thumb`,
    bytes: 100,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("handleItemClick(MUST-2/SHOULD-3: 連続クリックの直列化、レビュー2026-09-24)", () => {
  it("既に選択中の項目への連打は2回目以降何もしない", async () => {
    const item = makeItem(`sidebar-noop-${Date.now()}`);
    addHistoryItem(item); // addHistoryItemは追加した項目を自動選択する

    const captureCurrentAssets = vi.fn(async () => ({
      image: "x",
      thumbnail: "y",
      bytes: 1,
    }));
    const reloadImage = vi.fn(async () => {});
    const callbacks: ItemClickCallbacks = { captureCurrentAssets, reloadImage };

    await handleItemClick(item, callbacks);
    await handleItemClick(item, callbacks);

    expect(captureCurrentAssets).not.toHaveBeenCalled();
    expect(reloadImage).not.toHaveBeenCalled();
  });

  it(
    "異なる項目への高速な連続クリックは直列化され、2件目の保存捕捉は" +
      "1件目の切替完了後に始まる(MUST-2再現: 直列化されないとBの履歴データが" +
      "Cクリック時の捕捉値で誤って上書きされる)",
    async () => {
      const prefix = `sidebar-race-${Date.now()}`;
      const a = makeItem(`${prefix}-a`);
      const b = makeItem(`${prefix}-b`);
      const c = makeItem(`${prefix}-c`);
      addHistoryItem(a);
      addHistoryItem(b);
      addHistoryItem(c);
      // レビューの再現条件と同じ初期状態(A選択中、B・Cは選択されていない)に戻す。
      selectHistoryItem(a.id);

      const callOrder: string[] = [];
      let captureCallCount = 0;
      const captureCurrentAssets = vi.fn(async () => {
        captureCallCount += 1;
        const label = `capture-${captureCallCount}`;
        callOrder.push(label);
        return { image: `captured-${captureCallCount}`, thumbnail: `${label}-thumb`, bytes: 1 };
      });
      const reloadImage = vi.fn(async (item: HistoryItem) => {
        callOrder.push(`reload:${item.id}`);
      });
      const callbacks: ItemClickCallbacks = { captureCurrentAssets, reloadImage };

      // Bクリック直後(await前)にCもクリックする(サイドバーの連打を模す)。
      const clickB = handleItemClick(b, callbacks);
      const clickC = handleItemClick(c, callbacks);
      await Promise.all([clickB, clickC]);

      // 直列化の証拠: Cの捕捉(2回目のcaptureCurrentAssets)は、
      // Bへの切替が完了(reload:b)した後でなければならない。
      const reloadBIndex = callOrder.indexOf(`reload:${b.id}`);
      const secondCaptureIndex = callOrder.indexOf("capture-2");
      expect(reloadBIndex).toBeGreaterThanOrEqual(0);
      expect(secondCaptureIndex).toBeGreaterThan(reloadBIndex);

      // 最終的にCが選択されている。
      expect(getHistoryState().selectedId).toBe(c.id);

      // Aは「Bへ切り替える直前」に捕捉された1回目の値で正しく上書きされている。
      const updatedA = getHistoryState().items.find((it) => it.id === a.id);
      expect(updatedA?.image).toBe("captured-1");

      // Bは「Cへ切り替える直前」に捕捉された2回目の値で正しく上書きされている
      // (直列化していない実装では、Aの内容がBへ誤って上書きされる)。
      const updatedB = getHistoryState().items.find((it) => it.id === b.id);
      expect(updatedB?.image).toBe("captured-2");
    },
  );

  it("通常の単発クリック(await済み)では捕捉→選択→再読込の順に1回ずつ呼ばれる", async () => {
    const prefix = `sidebar-basic-${Date.now()}`;
    const a = makeItem(`${prefix}-a`);
    const b = makeItem(`${prefix}-b`);
    addHistoryItem(a);
    addHistoryItem(b);
    selectHistoryItem(a.id);

    const callOrder: string[] = [];
    const captureCurrentAssets = vi.fn(async () => {
      callOrder.push("capture");
      return { image: "captured", thumbnail: "captured-thumb", bytes: 1 };
    });
    const reloadImage = vi.fn(async (item: HistoryItem) => {
      callOrder.push(`reload:${item.id}`);
    });

    await handleItemClick(b, { captureCurrentAssets, reloadImage });

    expect(callOrder).toEqual(["capture", `reload:${b.id}`]);
    expect(getHistoryState().selectedId).toBe(b.id);
  });
});

function makeDeleteCallbacks(callOrder: string[] = []): SidebarCallbacks {
  return {
    captureCurrentAssets: vi.fn(async () => {
      callOrder.push("capture");
      return { image: "captured", thumbnail: "captured-thumb", bytes: 1 };
    }),
    reloadImage: vi.fn(async (item: HistoryItem) => {
      callOrder.push(`reload:${item.id}`);
    }),
    onItemsRemoved: vi.fn((items: readonly HistoryItem[]) => {
      callOrder.push(`removed:${items.map((it) => it.id).join(",")}`);
    }),
    clearEditor: vi.fn(() => {
      callOrder.push("clear-editor");
    }),
  };
}

describe("handleItemDelete(履歴の1件削除)", () => {
  beforeEach(() => {
    clearHistory();
  });

  it("表示中でない項目を消すと、表示はそのままで消した項目だけを通知する", async () => {
    const a = makeItem("del-a");
    const b = makeItem("del-b");
    addHistoryItem(a);
    addHistoryItem(b); // bが表示中
    const callbacks = makeDeleteCallbacks();

    await handleItemDelete(a, callbacks);

    expect(getHistoryState().items.map((it) => it.id)).toEqual([b.id]);
    expect(getHistoryState().selectedId).toBe(b.id);
    expect(callbacks.onItemsRemoved).toHaveBeenCalledWith([a]);
    expect(callbacks.reloadImage).not.toHaveBeenCalled();
    expect(callbacks.clearEditor).not.toHaveBeenCalled();
  });

  it("表示中の項目を消すと、編集内容は保存せずに隣の項目を読み込む", async () => {
    const a = makeItem("del-sel-a");
    const b = makeItem("del-sel-b");
    const c = makeItem("del-sel-c");
    addHistoryItem(a);
    addHistoryItem(b);
    addHistoryItem(c);
    selectHistoryItem(b.id);
    const callOrder: string[] = [];
    const callbacks = makeDeleteCallbacks(callOrder);

    await handleItemDelete(b, callbacks);

    expect(getHistoryState().selectedId).toBe(a.id);
    expect(callOrder).toEqual([`removed:${b.id}`, `reload:${a.id}`]);
    expect(callbacks.captureCurrentAssets).not.toHaveBeenCalled();
  });

  it("最後の1件を消すとエディタを空状態に戻す", async () => {
    const a = makeItem("del-last");
    addHistoryItem(a);
    const callOrder: string[] = [];
    const callbacks = makeDeleteCallbacks(callOrder);

    await handleItemDelete(a, callbacks);

    expect(getHistoryState()).toEqual({ items: [], selectedId: null });
    expect(callOrder).toEqual([`removed:${a.id}`, "clear-editor"]);
  });

  it("既に消えた項目への2回目の削除は何もしない(連打)", async () => {
    const a = makeItem("del-twice-a");
    const b = makeItem("del-twice-b");
    addHistoryItem(a);
    addHistoryItem(b);
    const callbacks = makeDeleteCallbacks();

    await Promise.all([handleItemDelete(a, callbacks), handleItemDelete(a, callbacks)]);

    expect(callbacks.onItemsRemoved).toHaveBeenCalledTimes(1);
  });

  it("切替中のクリックと直列化され、切替が終わってから削除する", async () => {
    const a = makeItem("del-queue-a");
    const b = makeItem("del-queue-b");
    addHistoryItem(a);
    addHistoryItem(b); // bが表示中
    const callOrder: string[] = [];
    const callbacks = makeDeleteCallbacks(callOrder);

    // aへ切り替える途中でaを削除する: 切替完了後にaは表示中なので、隣のbを読み込み直す。
    await Promise.all([handleItemClick(a, callbacks), handleItemDelete(a, callbacks)]);

    expect(callOrder).toEqual([
      "capture",
      `reload:${a.id}`,
      `removed:${a.id}`,
      `reload:${b.id}`,
    ]);
    expect(getHistoryState().selectedId).toBe(b.id);
  });
});

describe("handleClearAll(履歴の全削除)", () => {
  beforeEach(() => {
    clearHistory();
  });

  it("全項目を消して通知し、エディタを空状態に戻す", async () => {
    const a = makeItem("clear-a");
    const b = makeItem("clear-b");
    addHistoryItem(a);
    addHistoryItem(b);
    const callOrder: string[] = [];
    const callbacks = makeDeleteCallbacks(callOrder);

    await handleClearAll(callbacks);

    expect(getHistoryState()).toEqual({ items: [], selectedId: null });
    expect(callbacks.onItemsRemoved).toHaveBeenCalledWith([b, a]);
    expect(callOrder).toEqual([`removed:${b.id},${a.id}`, "clear-editor"]);
  });

  it("履歴が空なら何もしない", async () => {
    const callbacks = makeDeleteCallbacks();

    await handleClearAll(callbacks);

    expect(callbacks.onItemsRemoved).not.toHaveBeenCalled();
    expect(callbacks.clearEditor).not.toHaveBeenCalled();
  });
});

describe("削除とクリックの組み合わせ(レビュー 2026-10-07)", () => {
  beforeEach(() => {
    clearHistory();
  });

  it("×で消した項目への遅れたクリックは何もしない(revoke済みの画像を読まない)", async () => {
    const a = makeItem("stale-a");
    const b = makeItem("stale-b");
    addHistoryItem(a);
    addHistoryItem(b); // bが表示中
    const callbacks = makeDeleteCallbacks();

    await Promise.all([handleItemDelete(a, callbacks), handleItemClick(a, callbacks)]);

    expect(callbacks.captureCurrentAssets).not.toHaveBeenCalled();
    expect(callbacks.reloadImage).not.toHaveBeenCalled();
    expect(getHistoryState().selectedId).toBe(b.id);
  });
});
