import { describe, expect, it } from "vitest";

import { enqueueHistoryTask } from "./historyQueue";

describe("enqueueHistoryTask(履歴を読み書きする処理の直列化)", () => {
  it("前の処理が終わるまで次の処理を始めない", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = enqueueHistoryTask(async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("first:end");
    });
    const second = enqueueHistoryTask(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("失敗した処理は呼び出し元へ失敗を返し、後続の処理は止めない", async () => {
    const failed = enqueueHistoryTask(async () => {
      throw new Error("boom");
    });
    const next = enqueueHistoryTask(async () => {});

    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBeUndefined();
  });
});
