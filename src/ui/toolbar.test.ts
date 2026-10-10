import { afterEach, describe, expect, it } from "vitest";

import { beginScan, discardMaskSession } from "../canvas/maskSession";
import {
  TOOL_GROUP_ORDER,
  TOOL_IDS,
  currentToolButtonContext,
  toolButtonAttributes,
  toolButtonState,
  toolGroupOf,
  toolbarItems,
} from "./toolbar";

// ツールボタンの押下・無効の判定(DOM 結線の `initToolbar` は E2E で確認する)。
describe("toolButtonState", () => {
  const base = { activeTool: "arrow" as const, isDrawing: false, isMasking: false };

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
    expect(toolButtonState("arrow", { ...base, isMasking: true })).toEqual({
      pressed: true,
      disabled: true,
    });
    expect(toolButtonState("mosaic", { ...base, isMasking: true })).toEqual({
      pressed: false,
      disabled: true,
    });
  });

  it("確認が終わると元どおり", () => {
    expect(toolButtonState("mosaic", { ...base, isMasking: false })).toEqual({
      pressed: false,
      disabled: false,
    });
  });
});

// AM-T25-F1 SHOULD-1: 処理中(`scanning`)も確認中と同じく全ボタンを無効にする。
describe("currentToolButtonContext(ストアから組み立てる文脈)", () => {
  afterEach(() => {
    discardMaskSession();
  });

  it("idle では isMasking: false(既存どおり押せる)", () => {
    expect(currentToolButtonContext().isMasking).toBe(false);
  });

  it("処理中は isMasking: true になり、全ボタンが無効", () => {
    beginScan({ assetUrl: "blob:toolbar", capture: null });
    const context = currentToolButtonContext();
    expect(context.isMasking).toBe(true);
    expect(toolButtonState("arrow", context).disabled).toBe(true);
    expect(toolButtonState("mosaic", context).disabled).toBe(true);
  });
});

// QE-T02: ツールボタンの名前・ツールチップ・キー(UI_quick-edits §1.3)。表は `toolKeys.ts` の `TOOL_KEYS`。
describe("toolButtonAttributes", () => {
  it.each([
    ["arrow", "矢印(A)", "A"],
    ["rectangle", "矩形(R)", "R"],
    ["ellipse", "円(O)", "O"],
    ["text", "テキスト(T)", "T"],
    ["stamp", "スタンプ(N)", "N"],
    ["mosaic", "モザイク(M)", "M"],
  ] as const)("%s は aria-label・title が %s、aria-keyshortcuts が %s", (id, label, key) => {
    expect(toolButtonAttributes(id)).toEqual({ ariaLabel: label, title: label, ariaKeyShortcuts: key });
  });

  it("TOOLS の全ツールに名前とキーがある", () => {
    for (const id of TOOL_IDS) {
      const attributes = toolButtonAttributes(id);
      expect(attributes.ariaLabel).toMatch(/\([A-Z]\)$/);
      expect(attributes.ariaKeyShortcuts).toMatch(/^[A-Z]$/);
    }
  });
});

// QE-T03: ツールの 2 組(描く注釈 ┆ 画像を変える)と区切り(UI_quick-edits §1.1)。
describe("toolbarItems(ツールの並びと組の区切り)", () => {
  it("描く注釈の組 → 区切り → 画像を変える組の順に並ぶ", () => {
    expect(toolbarItems()).toEqual(["arrow", "rectangle", "ellipse", "text", "stamp", "divider", "mosaic", "spotlight", "crop"]);
  });

  it("区切りは組の間に 1 本だけ(先頭・末尾・連続には入らない)", () => {
    const items = toolbarItems();
    expect(items.filter((item) => item === "divider")).toHaveLength(1);
    expect(items[0]).not.toBe("divider");
    expect(items[items.length - 1]).not.toBe("divider");
  });

  it("モザイクは画像を変える組の先頭(キーは M のまま)", () => {
    const items = toolbarItems();
    expect(items[items.indexOf("divider") + 1]).toBe("mosaic");
    expect(toolButtonAttributes("mosaic").ariaKeyShortcuts).toBe("M");
  });

  it("各ツールの組: 描く注釈は annotate、画像を変えるものは image", () => {
    expect(TOOL_GROUP_ORDER).toEqual(["annotate", "image"]);
    expect(TOOL_IDS.map((id) => [id, toolGroupOf(id)])).toEqual([
      ["arrow", "annotate"],
      ["rectangle", "annotate"],
      ["ellipse", "annotate"],
      ["text", "annotate"],
      ["stamp", "annotate"],
      ["mosaic", "image"],
      ["spotlight", "image"],
      ["crop", "image"],
    ]);
  });

  // QE-T13: スタンプは描く注釈の組の最後(テキストの直後、UI_quick-edits §1.1)。
  it("スタンプはテキストの直後・区切りの手前", () => {
    const items = toolbarItems();
    expect(items[items.indexOf("text") + 1]).toBe("stamp");
    expect(items[items.indexOf("stamp") + 1]).toBe("divider");
  });

  it("区切りを除いた並びは TOOL_IDS と同じ", () => {
    expect(toolbarItems().filter((item) => item !== "divider")).toEqual([...TOOL_IDS]);
  });
});
