import { describe, expect, it } from "vitest";

import { isActivatableTarget } from "./keyTarget";

// Enter に既定の動作がある要素の判定(トリミングの Enter と選択中の注釈の Enter が共有する、レビュー 2026-10-26)。
describe("isActivatableTarget", () => {
  it.each([
    [{ tagName: "BUTTON" }],
    [{ tagName: "button" }],
    [{ tagName: "A" }],
    [{ tagName: "INPUT" }],
    [{ tagName: "INPUT", type: "color" }],
    [{ tagName: "SELECT" }],
    [{ tagName: "TEXTAREA" }],
    [{ tagName: "SUMMARY" }],
    [{ tagName: "DIV", role: "button" }],
    [{ tagName: "span", role: "Button" }],
    [{ tagName: "DIV", isContentEditable: true }],
  ])("%o は押せる要素", (target) => {
    expect(isActivatableTarget(target)).toBe(true);
  });

  it.each([[null], [undefined], [{}], [{ tagName: "BODY" }], [{ tagName: "CANVAS" }], [{ tagName: "DIV", role: "group" }], [{ tagName: "P", role: null }]])(
    "%o は押せる要素ではない",
    (target) => {
      expect(isActivatableTarget(target)).toBe(false);
    },
  );
});
