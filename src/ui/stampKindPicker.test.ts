import { describe, expect, it } from "vitest";

import type { ToolId } from "../canvas/canvasState";
import {
  STAMP_KIND_OPTIONS,
  isStampKindPickerVisible,
  stampKindIcon,
  stampKindLabel,
} from "./stampKindPicker";

// スタンプの種類の切替(QE-T13、UI_quick-edits §2.1・§2.2)。DOM の結線(`initStampKindPicker`)は
// E2E `stamp.spec.ts` で確かめる。

describe("STAMP_KIND_OPTIONS(種類 → aria-label / title)", () => {
  it("番号・チェック・バツ・注意・質問の順で 5 つ", () => {
    expect(STAMP_KIND_OPTIONS.map((option) => [option.glyph, option.label])).toEqual([
      ["number", "スタンプ 番号"],
      ["check", "スタンプ チェック"],
      ["cross", "スタンプ バツ"],
      ["exclamation", "スタンプ 注意"],
      ["question", "スタンプ 質問"],
    ]);
  });

  it("stampKindLabel は表と同じ名前を返す", () => {
    for (const option of STAMP_KIND_OPTIONS) {
      expect(stampKindLabel(option.glyph)).toBe(option.label);
    }
  });

  it("名前は「対象 + 値」の形(文字サイズ 小 と同じ。半角空白 1 つ)", () => {
    for (const option of STAMP_KIND_OPTIONS) {
      expect(option.label).toMatch(/^スタンプ \S+$/);
    }
  });
});

describe("isStampKindPickerVisible(出す条件)", () => {
  it("スタンプツールを選んでいる間だけ出す", () => {
    expect(isStampKindPickerVisible("stamp")).toBe(true);
  });

  it.each<ToolId | null>(["arrow", "rectangle", "ellipse", "text", "mosaic", null])(
    "%s では隠す",
    (tool) => {
      expect(isStampKindPickerVisible(tool)).toBe(false);
    },
  );
});

describe("stampKindIcon(塗りの丸 + 地の色で抜いた記号、UI §2.2)", () => {
  it("どの種類も viewBox 20 の装飾 SVG で、丸は currentColor で塗る", () => {
    for (const option of STAMP_KIND_OPTIONS) {
      const svg = stampKindIcon(option.glyph);
      expect(svg).toContain('viewBox="0 0 20 20"');
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).toContain('<circle cx="10" cy="10" r="7.5" fill="currentColor"/>');
      expect(svg).toContain("var(--surface-color)");
    }
  });

  it("種類ごとに記号の形が違う", () => {
    const icons = STAMP_KIND_OPTIONS.map((option) => stampKindIcon(option.glyph));
    expect(new Set(icons).size).toBe(icons.length);
    expect(stampKindIcon("number")).toContain('d="M8.6 7.7 10.5 6.4V13.6"');
    expect(stampKindIcon("check")).toContain('d="M6.7 10.2 8.9 12.4 13.3 7.7"');
  });

  it("注意・質問は点を地の色の小さい丸で描く", () => {
    expect(stampKindIcon("exclamation")).toContain('<circle cx="10" cy="13.7" r="1.05"');
    expect(stampKindIcon("question")).toContain('<circle cx="10" cy="13.8" r="1.05"');
  });
});
