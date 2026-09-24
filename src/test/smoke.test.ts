import { describe, expect, it } from "vitest";

describe("Vitest 配線確認", () => {
  it("自明な計算が期待どおりに評価される(1+1=2)", () => {
    expect(1 + 1).toBe(2);
  });
});
