import { describe, expect, it } from "vitest";

import { FONT_SIZE_MULTIPLIER } from "../canvas/tools/textTool";
import { FONT_SIZE_OPTIONS, fontSizeGlyphHeight, FONT_SIZE_GLYPH_MAX } from "./fontSizePicker";

describe("FONT_SIZE_OPTIONS", () => {
  it("小・中・大の順で3段階", () => {
    expect(FONT_SIZE_OPTIONS.map((o) => o.size)).toEqual(["small", "medium", "large"]);
    expect(FONT_SIZE_OPTIONS.map((o) => o.label)).toEqual([
      "文字サイズ 小",
      "文字サイズ 中",
      "文字サイズ 大",
    ]);
  });
});

describe("fontSizeGlyphHeight", () => {
  it("大が最大の高さで、大小比はtextTool.tsのFONT_SIZE_MULTIPLIERに一致する", () => {
    expect(fontSizeGlyphHeight("large")).toBe(FONT_SIZE_GLYPH_MAX);
    const ratio = (a: "small" | "medium" | "large", b: "small" | "medium" | "large"): number =>
      fontSizeGlyphHeight(a) / fontSizeGlyphHeight(b);
    expect(ratio("small", "large")).toBeCloseTo(
      FONT_SIZE_MULTIPLIER.small / FONT_SIZE_MULTIPLIER.large,
      6,
    );
    expect(ratio("medium", "large")).toBeCloseTo(
      FONT_SIZE_MULTIPLIER.medium / FONT_SIZE_MULTIPLIER.large,
      6,
    );
  });
});
