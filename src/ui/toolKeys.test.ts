import { describe, expect, it } from "vitest";

import type { ToolId } from "../canvas/canvasState";
import { TOOL_IDS, toolButtonState, type ToolButtonContext } from "./toolbar";
import { TOOL_KEYS, toolKeyTarget, toolLabel, type ToolKeyContext, type ToolKeyEvent } from "./toolKeys";

// 修飾キーなしの 1 キーでツールを切り替える判定(QE-T02、ARCH_quick-edits §7.1 手順 K、FR-013)。
// `window` への結線(`bindToolKeys`)は E2E `tool-keys.spec.ts` で確認する。

function keyEvent(code: string, overrides: Partial<ToolKeyEvent> = {}): ToolKeyEvent {
  return {
    code,
    key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    target: null,
    ...overrides,
  };
}

/** ツールボタンと同じ可否(`toolButtonState`)を使う文脈を組み立てる。 */
function context(
  overrides: Partial<ToolButtonContext> = {},
  hasImage = true,
): ToolKeyContext {
  const button: ToolButtonContext = { activeTool: null, isDrawing: false, isMasking: false, ...overrides };
  return { hasImage, isToolDisabled: (id: ToolId) => toolButtonState(id, button).disabled };
}

describe("toolKeyTarget", () => {
  it.each([
    ["KeyA", "arrow"],
    ["KeyR", "rectangle"],
    ["KeyO", "ellipse"],
    ["KeyT", "text"],
    ["KeyM", "mosaic"],
  ] as const)("%s は %s を返す", (code, tool) => {
    expect(toolKeyTarget(keyEvent(code), context())).toBe(tool);
  });

  it("選択中のツールのキーも同じツールを返す(外すのは toggleActiveTool の役目)", () => {
    expect(toolKeyTarget(keyEvent("KeyA"), context({ activeTool: "arrow" }))).toBe("arrow");
  });

  it.each([
    ["⌘C", keyEvent("KeyC", { metaKey: true })],
    ["⌘Z", keyEvent("KeyZ", { metaKey: true })],
    ["⇧⌘Z", keyEvent("KeyZ", { metaKey: true, shiftKey: true })],
    ["⌘⇧F", keyEvent("KeyF", { metaKey: true, shiftKey: true })],
    ["⌘⇧B", keyEvent("KeyB", { metaKey: true, shiftKey: true })],
    ["⌘⇧M", keyEvent("KeyM", { metaKey: true, shiftKey: true })],
    ["⌘A", keyEvent("KeyA", { metaKey: true })],
    ["⌥A", keyEvent("KeyA", { altKey: true })],
    ["⌃A", keyEvent("KeyA", { ctrlKey: true })],
    ["⇧A", keyEvent("KeyA", { shiftKey: true })],
  ])("修飾キー付き(%s)は奪わない", (_name, event) => {
    expect(toolKeyTarget(event, context())).toBeNull();
  });

  it("押しっぱなしの繰り返し(repeat)は扱わない", () => {
    expect(toolKeyTarget(keyEvent("KeyA", { repeat: true }), context())).toBeNull();
  });

  it("ほかの処理が preventDefault したイベントは扱わない", () => {
    expect(toolKeyTarget(keyEvent("KeyA", { defaultPrevented: true }), context())).toBeNull();
  });

  it("IME の変換中(isComposing・keyCode 229)は扱わない", () => {
    expect(toolKeyTarget(keyEvent("KeyA", { isComposing: true }), context())).toBeNull();
    expect(toolKeyTarget(keyEvent("KeyA", { keyCode: 229, key: "Process" }), context())).toBeNull();
  });

  it("入力欄・contenteditable が対象なら扱わない", () => {
    expect(toolKeyTarget(keyEvent("KeyA", { target: { tagName: "INPUT", type: "text" } }), context())).toBeNull();
    expect(toolKeyTarget(keyEvent("KeyA", { target: { tagName: "TEXTAREA" } }), context())).toBeNull();
    expect(toolKeyTarget(keyEvent("KeyA", { target: { tagName: "DIV", isContentEditable: true } }), context())).toBeNull();
  });

  it("文字入力でない input(カラーピッカー)にフォーカスが残っていても切り替える", () => {
    expect(toolKeyTarget(keyEvent("KeyA", { target: { tagName: "INPUT", type: "color" } }), context())).toBe("arrow");
  });

  it("自動マスキングの処理中・確認中は扱わない", () => {
    expect(toolKeyTarget(keyEvent("KeyA"), context({ isMasking: true }))).toBeNull();
    expect(toolKeyTarget(keyEvent("KeyA"), context({ activeTool: "arrow", isMasking: true }))).toBeNull();
  });

  it("描画中は選択中以外のツールへ切り替えない(ボタンと同じ)", () => {
    expect(toolKeyTarget(keyEvent("KeyR"), context({ activeTool: "arrow", isDrawing: true }))).toBeNull();
  });

  it("画像が無いときは扱わない", () => {
    expect(toolKeyTarget(keyEvent("KeyA"), context({}, false))).toBeNull();
  });

  it("割り当てのないキー(KeyZ・Digit1)は扱わない", () => {
    expect(toolKeyTarget(keyEvent("KeyZ"), context())).toBeNull();
    expect(toolKeyTarget(keyEvent("Digit1"), context())).toBeNull();
  });

  it("まだ無いツールのキー(KeyN・KeyS・KeyC)は扱わない", () => {
    expect(toolKeyTarget(keyEvent("KeyN"), context())).toBeNull();
    expect(toolKeyTarget(keyEvent("KeyS"), context())).toBeNull();
    expect(toolKeyTarget(keyEvent("KeyC"), context())).toBeNull();
  });

  it("event.key が日本語入力の文字でも event.code で引ける", () => {
    expect(toolKeyTarget(keyEvent("KeyA", { key: "あ" }), context())).toBe("arrow");
    expect(toolKeyTarget(keyEvent("KeyT", { key: "か" }), context())).toBe("text");
  });
});

describe("toolLabel", () => {
  it("UI_quick-edits §1.3 の名前を返す", () => {
    expect(toolLabel("arrow")).toBe("矢印(A)");
    expect(toolLabel("rectangle")).toBe("矩形(R)");
    expect(toolLabel("ellipse")).toBe("円(O)");
    expect(toolLabel("text")).toBe("テキスト(T)");
    expect(toolLabel("mosaic")).toBe("モザイク(M)");
  });

  it("全ツールが「名前(キー)」の形(半角かっこ・空白なし・大文字 1 文字)", () => {
    for (const { tool } of TOOL_KEYS) {
      expect(toolLabel(tool)).toMatch(/^[^\s()]+\([A-Z]\)$/);
    }
  });
});

describe("表の整合(toolbar の TOOLS と TOOL_KEYS)", () => {
  it("ツールが過不足なく一致する", () => {
    expect([...TOOL_KEYS.map((entry) => entry.tool)].sort()).toEqual([...TOOL_IDS].sort());
  });

  it("code が重複しない", () => {
    const codes = TOOL_KEYS.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("code は修飾なしの英字キー(KeyX)", () => {
    for (const { code } of TOOL_KEYS) {
      expect(code).toMatch(/^Key[A-Z]$/);
    }
  });
});
