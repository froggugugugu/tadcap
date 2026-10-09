import { describe, expect, it } from "vitest";

import { toolButtonState } from "./toolbar";

// ツールボタンの押下・無効の判定(DOM 結線の `initToolbar` は E2E で確認する)。
describe("toolButtonState", () => {
  const base = { activeTool: "arrow" as const, isDrawing: false, isReviewing: false };

  it("選択中のツールだけ押下状態、通常は全ボタン有効", () => {
    expect(toolButtonState("arrow", base)).toEqual({ pressed: true, disabled: false });
    expect(toolButtonState("mosaic", base)).toEqual({ pressed: false, disabled: false });
    expect(toolButtonState("arrow", { ...base, activeTool: null })).toEqual({
      pressed: false,
      disabled: false,
    });
  });

  it("ドラッグ中は選択中以外のボタンを無効にする(既存どおり)", () => {
    expect(toolButtonState("arrow", { ...base, isDrawing: true })).toEqual({
      pressed: true,
      disabled: false,
    });
    expect(toolButtonState("mosaic", { ...base, isDrawing: true })).toEqual({
      pressed: false,
      disabled: true,
    });
  });

  // AM-T13: 自動マスキングの確認中(maskSession が `review`)はツールを切り替えさせない
  // (ARCH_auto-masking §15 #4 A 案)。押下状態は変えずに全ボタンを無効にする。
  it("確認中は選択中のツールも含めて全ボタンを無効にする", () => {
    expect(toolButtonState("arrow", { ...base, isReviewing: true })).toEqual({
      pressed: true,
      disabled: true,
    });
    expect(toolButtonState("mosaic", { ...base, isReviewing: true })).toEqual({
      pressed: false,
      disabled: true,
    });
  });

  it("確認が終わると元どおり", () => {
    expect(toolButtonState("mosaic", { ...base, isReviewing: false })).toEqual({
      pressed: false,
      disabled: false,
    });
  });
});
