import { describe, expect, it, vi } from "vitest";

import {
  addHistoryItem,
  getHistoryState,
  selectHistoryItem,
  type HistoryItem,
} from "../history/historyStore";
import { handleItemClick, type SidebarCallbacks } from "./sidebar";

function makeItem(id: string): HistoryItem {
  return {
    id,
    image: `blob:tadcap/${id}-image`,
    thumbnail: `blob:tadcap/${id}-thumb`,
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
    }));
    const reloadImage = vi.fn(async () => {});
    const callbacks: SidebarCallbacks = { captureCurrentAssets, reloadImage };

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
        return { image: `captured-${captureCallCount}`, thumbnail: `${label}-thumb` };
      });
      const reloadImage = vi.fn(async (item: HistoryItem) => {
        callOrder.push(`reload:${item.id}`);
      });
      const callbacks: SidebarCallbacks = { captureCurrentAssets, reloadImage };

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
      return { image: "captured", thumbnail: "captured-thumb" };
    });
    const reloadImage = vi.fn(async (item: HistoryItem) => {
      callOrder.push(`reload:${item.id}`);
    });

    await handleItemClick(b, { captureCurrentAssets, reloadImage });

    expect(callOrder).toEqual(["capture", `reload:${b.id}`]);
    expect(getHistoryState().selectedId).toBe(b.id);
  });
});
