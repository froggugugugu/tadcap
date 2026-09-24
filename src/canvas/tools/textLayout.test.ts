import { describe, expect, it } from "vitest";

import type { TextShape } from "../shapeEdit";
import {
  computeBaselineY,
  computeFontSizePx,
  computeTextBoundingRect,
  decideTextEdit,
  textLineHeight,
  textShadowParams,
  textShapeBaselineY,
  textShapeBoundingRect,
  textShapeBox,
} from "./textLayout";

const W = 400;
const H = 300;

// 400x300 の「中」= 18px(下限)、行の高さ = round(18×1.25) = 23px。
const text: TextShape = {
  kind: "text",
  text: "Hi",
  x: 100,
  top: 50,
  fontSize: "medium",
  color: "#FF5C8A",
  metrics: { width: 40, left: 0, right: 38, ascent: 13, descent: 1, fontAscent: 17, fontDescent: 4 },
};

describe("textShapeBox(当たり判定・移動・選択枠に使う行ボックス)", () => {
  it("左端=x、幅=文字幅(はみ出しを含む)、上端=top、高さ=行の高さ", () => {
    expect(computeFontSizePx("medium", W, H)).toBe(18);
    expect(textShapeBox(text, W, H)).toEqual({ x: 100, y: 50, width: 40, height: textLineHeight(18) });
  });

  it("左・右へはみ出す字形(actualBoundingBox)も含める", () => {
    const italic = { ...text, metrics: { ...text.metrics, left: 3, right: 45 } };
    expect(textShapeBox(italic, W, H)).toEqual({ x: 97, y: 50, width: 48, height: 23 });
  });

  it("文字サイズ段階が変われば行の高さも変わる", () => {
    const large = { ...text, fontSize: "large" as const };
    expect(textShapeBox(large, W, H).height).toBe(textLineHeight(computeFontSizePx("large", W, H)));
  });
});

describe("textShapeBaselineY / textShapeBoundingRect", () => {
  it("ベースラインは行ボックス内のCSSと同じ位置(T27の焼き込みと同じ式)", () => {
    expect(textShapeBaselineY(text, W, H)).toBe(computeBaselineY(50, 23, 17, 4));
  });

  it("外接矩形は影・アンチエイリアス込み(T27の取り消し範囲と同じ式)", () => {
    expect(textShapeBoundingRect(text, W, H)).toEqual(
      computeTextBoundingRect({
        x: 100,
        baselineY: textShapeBaselineY(text, W, H),
        metrics: { left: 0, right: 38, ascent: 13, descent: 1 },
        shadow: textShadowParams(18),
        canvasWidth: W,
        canvasHeight: H,
      }),
    );
  });
});

describe("decideTextEdit(入力の終わり方 → 追加・変更・削除)", () => {
  it("新規入力: 文字があれば追加、空やEscなら何もしない", () => {
    expect(decideTextEdit("enter", "abc", null)).toEqual({ type: "add", text: "abc" });
    expect(decideTextEdit("blur", "abc", null)).toEqual({ type: "add", text: "abc" });
    expect(decideTextEdit("enter", "  ", null)).toEqual({ type: "none" });
    expect(decideTextEdit("escape", "abc", null)).toEqual({ type: "none" });
  });

  it("再編集: 変われば変更、同じなら何もしない、空にして確定したら削除", () => {
    expect(decideTextEdit("enter", "Hello", "Hi")).toEqual({ type: "update", text: "Hello" });
    expect(decideTextEdit("external", "Hi", "Hi")).toEqual({ type: "none" });
    expect(decideTextEdit("blur", "", "Hi")).toEqual({ type: "remove" });
  });

  it("再編集: Esc・画像差し替えは編集前のまま(何もしない)", () => {
    expect(decideTextEdit("escape", "", "Hi")).toEqual({ type: "none" });
    expect(decideTextEdit("imageChanged", "Hello", "Hi")).toEqual({ type: "none" });
  });
});
