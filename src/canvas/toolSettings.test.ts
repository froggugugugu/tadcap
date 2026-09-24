import { describe, expect, it } from "vitest";

import {
  createToolSettings,
  getToolSettings,
  isValidColorCode,
  setColor,
  setFontSize,
  subscribeToolSettings,
  withColor,
  withFontSize,
} from "./toolSettings";

describe("createToolSettings", () => {
  it("既定色はピンク(#FF5C8A)・既定フォントサイズは中(medium)である", () => {
    expect(createToolSettings()).toEqual({ color: "#FF5C8A", fontSize: "medium" });
  });
});

describe("withColor", () => {
  it("色を変更した新しい状態を返す(イミュータブル)", () => {
    const state = createToolSettings();
    const next = withColor(state, "#3366FF");

    expect(next).toEqual({ color: "#3366FF", fontSize: "medium" });
    expect(state).toEqual({ color: "#FF5C8A", fontSize: "medium" });
  });
});

describe("withFontSize", () => {
  it("フォントサイズを変更した新しい状態を返す(イミュータブル)", () => {
    const state = createToolSettings();
    const next = withFontSize(state, "large");

    expect(next).toEqual({ color: "#FF5C8A", fontSize: "large" });
    expect(state).toEqual({ color: "#FF5C8A", fontSize: "medium" });
  });
});

describe("isValidColorCode", () => {
  it("#RRGGBB形式(大文字)はtrueを返す", () => {
    expect(isValidColorCode("#FF5C8A")).toBe(true);
  });

  it("#RRGGBB形式(小文字)はtrueを返す", () => {
    expect(isValidColorCode("#ff5c8a")).toBe(true);
  });

  it("#無しの文字列はfalseを返す", () => {
    expect(isValidColorCode("FF5C8A")).toBe(false);
  });

  it("桁数が不足する文字列はfalseを返す", () => {
    expect(isValidColorCode("#FFF")).toBe(false);
  });

  it("桁数が超過する文字列はfalseを返す", () => {
    expect(isValidColorCode("#FF5C8A00")).toBe(false);
  });

  it("16進数以外の文字を含む文字列はfalseを返す", () => {
    expect(isValidColorCode("#GGHHII")).toBe(false);
  });

  it("空文字列はfalseを返す", () => {
    expect(isValidColorCode("")).toBe(false);
  });
});

describe("getToolSettings / setColor / setFontSize / subscribeToolSettings(シングルトンストア)", () => {
  it("初期値は既定色・既定フォントサイズである", () => {
    expect(getToolSettings()).toEqual({ color: "#FF5C8A", fontSize: "medium" });
  });

  it("setColor()は状態を更新し購読者へ通知する", () => {
    const received: string[] = [];
    const unsubscribe = subscribeToolSettings((state) => {
      received.push(state.color);
    });

    setColor("#112233");

    expect(getToolSettings().color).toBe("#112233");
    expect(received).toEqual(["#112233"]);

    unsubscribe();
    setColor("#FF5C8A");
  });

  it("setFontSize()は状態を更新し購読者へ通知する", () => {
    const received: string[] = [];
    const unsubscribe = subscribeToolSettings((state) => {
      received.push(state.fontSize);
    });

    setFontSize("small");

    expect(getToolSettings().fontSize).toBe("small");
    expect(received).toEqual(["small"]);

    unsubscribe();
    setFontSize("medium");
  });

  it("unsubscribe後は通知を受け取らない", () => {
    const received: string[] = [];
    const unsubscribe = subscribeToolSettings((state) => {
      received.push(state.color);
    });
    unsubscribe();

    setColor("#445566");

    expect(received).toEqual([]);
    setColor("#FF5C8A");
  });
});
