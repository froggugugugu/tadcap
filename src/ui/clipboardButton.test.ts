import { describe, expect, it } from "vitest";

import { createCanvasState, withImage } from "../canvas/canvasState";
import {
  clipboardCopyFeedbackMessage,
  isClipboardCopyEnabled,
  isCopyShortcut,
} from "./clipboardButton";

describe("isClipboardCopyEnabled", () => {
  it("画像未読込(image: null)のときは無効(false)を返す", () => {
    expect(isClipboardCopyEnabled(createCanvasState())).toBe(false);
  });

  it("画像読込済みのときは有効(true)を返す", () => {
    const state = withImage(createCanvasState(), {
      assetUrl: "asset://tmp/capture-1.png",
      capture: {
        id: "capture-1",
        sourcePath: "/tmp/tadcap-captures/capture-1.png",
        kind: "range",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    });

    expect(isClipboardCopyEnabled(state)).toBe(true);
  });
});

describe("isCopyShortcut", () => {
  it("Cmd+C(metaKey + 'c')はtrueを返す", () => {
    expect(isCopyShortcut({ key: "c", metaKey: true })).toBe(true);
  });

  it("大文字のC(Shift+Cmd+C相当)でもtrueを返す", () => {
    expect(isCopyShortcut({ key: "C", metaKey: true })).toBe(true);
  });

  it("metaKey無しのCはfalseを返す(Ctrl+C等はグローバル対象外)", () => {
    expect(isCopyShortcut({ key: "c", metaKey: false })).toBe(false);
  });

  it("Cmd+C以外のキーはfalseを返す", () => {
    expect(isCopyShortcut({ key: "v", metaKey: true })).toBe(false);
  });
});

// T22【改訂 2026-09-24】: isEditableTarget() のテストは `../ui/shortcutGuards.test.ts` へ
// 移設した(定義本体を `shortcutGuards.ts` へ抽出したため)。

describe("clipboardCopyFeedbackMessage", () => {
  it("pluginのときは主経路成功の文言を返す", () => {
    expect(clipboardCopyFeedbackMessage("plugin")).toContain(
      "クリップボードにコピー",
    );
  });

  it("fallbackのときはフォールバック経由である旨を含む", () => {
    expect(clipboardCopyFeedbackMessage("fallback")).toContain(
      "フォールバック",
    );
  });

  it("errorのときは失敗した旨を返す", () => {
    expect(clipboardCopyFeedbackMessage("error")).toContain("失敗");
  });
});
