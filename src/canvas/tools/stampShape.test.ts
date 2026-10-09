import { describe, expect, it } from "vitest";
import {
  STAMP_MIN_DIAMETER,
  drawStamp,
  hitStamp,
  stampDiameter,
  stampDigitPx,
  stampGlyphColor,
  stampNumbers,
  stampRingWidth,
  stampStrokeWidth,
  type StampGlyph,
  type StampShape,
} from "./stampShape";

function stamp(glyph: StampGlyph, overrides: Partial<StampShape> = {}): StampShape {
  return {
    kind: "stamp",
    center: { x: 100, y: 100 },
    glyph,
    color: "#FF5C8A",
    fontSize: "medium",
    ...overrides,
  };
}

const D_2080 = Math.hypot(2080, 1204);
const D_2880 = Math.hypot(2880, 1800);

describe("stampDiameter", () => {
  it("UI §2.3 の例: 2080×1204 で 小 47・中 70・大 104", () => {
    expect(stampDiameter("small", D_2080)).toBe(47);
    expect(stampDiameter("medium", D_2080)).toBe(70);
    expect(stampDiameter("large", D_2080)).toBe(104);
  });

  it("UI §2.3 の例: 2880×1800 で 中 98", () => {
    expect(stampDiameter("medium", D_2880)).toBe(98);
  });

  it("極小の画像でも下限 20px を下回らない", () => {
    // 文字の大きさの下限 18 × 2/3 = 12 → 12 × 1.2 = 14 は下限で 20 になる
    expect(stampDiameter("small", Math.hypot(50, 50))).toBe(STAMP_MIN_DIAMETER);
    expect(STAMP_MIN_DIAMETER).toBe(20);
  });

  it("同じ入力で同じ値を返す(決定論的)", () => {
    expect(stampDiameter("large", D_2880)).toBe(stampDiameter("large", D_2880));
  });
});

describe("縁・文字・線の大きさ", () => {
  it("白の縁 = max(2, round(直径 × 0.07))", () => {
    expect(stampRingWidth(70)).toBe(5);
    expect(stampRingWidth(104)).toBe(7);
    expect(stampRingWidth(20)).toBe(2);
  });

  it("文字の大きさ: 1 桁 0.58・2 桁 0.48", () => {
    expect(stampDigitPx(70, 1)).toBe(41);
    expect(stampDigitPx(70, 2)).toBe(34);
    expect(stampDigitPx(100, 2)).toBe(48);
  });

  it("✓・× の線の太さ = 直径 × 0.11", () => {
    expect(stampStrokeWidth(100)).toBeCloseTo(11);
  });
});

describe("stampGlyphColor", () => {
  it.each([
    ["橙", "#FF9500"],
    ["黄", "#FFCC00"],
    ["緑", "#34C759"],
  ])("白とのコントラストが低い %s は黒", (_label, color) => {
    expect(stampGlyphColor(color)).toBe("#1a1a1a");
  });

  it.each([
    ["ピンク", "#FF5C8A"],
    ["赤", "#FF3B30"],
    ["青", "#007AFF"],
  ])("%s は白", (_label, color) => {
    expect(stampGlyphColor(color)).toBe("#ffffff");
  });

  it("コントラスト比 2.5 の境目の前後で切り替わる(#A3A3A3 は 2.52 で白、#A4A4A4 は 2.49 で黒)", () => {
    expect(stampGlyphColor("#A3A3A3")).toBe("#ffffff");
    expect(stampGlyphColor("#A4A4A4")).toBe("#1a1a1a");
  });

  it("小文字の色コードも同じに扱う", () => {
    expect(stampGlyphColor("#ffcc00")).toBe("#1a1a1a");
  });
});

describe("stampNumbers", () => {
  const obj = (id: number, glyph: StampGlyph) => ({ id, shape: stamp(glyph) });

  it("置いた順(id の昇順)に 1・2・3", () => {
    const numbers = stampNumbers([obj(1, "number"), obj(2, "number"), obj(3, "number")]);
    expect([...numbers.entries()]).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("2 番目を消すと後ろが詰まって 1・2", () => {
    const numbers = stampNumbers([obj(1, "number"), obj(3, "number")]);
    expect(numbers.get(1)).toBe(1);
    expect(numbers.get(3)).toBe(2);
    expect(numbers.size).toBe(2);
  });

  it("記号スタンプ・他の注釈を挟んでも数えない", () => {
    const arrow = { id: 3, shape: { kind: "arrow" } };
    const numbers = stampNumbers([obj(1, "number"), obj(2, "check"), arrow, obj(4, "number")]);
    expect(numbers.get(1)).toBe(1);
    expect(numbers.get(4)).toBe(2);
    expect(numbers.has(2)).toBe(false);
    expect(numbers.has(3)).toBe(false);
  });

  it("配列の順(重ね順)を入れ替えても番号は変わらない", () => {
    const a = stampNumbers([obj(5, "number"), obj(2, "number"), obj(9, "number")]);
    const b = stampNumbers([obj(9, "number"), obj(5, "number"), obj(2, "number")]);
    expect(a.get(2)).toBe(1);
    expect(a.get(5)).toBe(2);
    expect(a.get(9)).toBe(3);
    expect([...b.entries()].sort((x, y) => x[0] - y[0])).toEqual(
      [...a.entries()].sort((x, y) => x[0] - y[0]),
    );
  });
});

describe("hitStamp", () => {
  // 2080×1204・中 → 直径 70・半径 35
  const shape = stamp("number", { center: { x: 500, y: 400 } });

  it("中心は当たる", () => {
    expect(hitStamp(shape, { x: 500, y: 400 }, 2080, 1204)).toBe(true);
  });

  it("縁の内側は当たる", () => {
    expect(hitStamp(shape, { x: 534, y: 400 }, 2080, 1204)).toBe(true);
  });

  it("外側は当たらない", () => {
    expect(hitStamp(shape, { x: 536, y: 400 }, 2080, 1204)).toBe(false);
    expect(hitStamp(shape, { x: 526, y: 426 }, 2080, 1204)).toBe(false);
  });

  it("styleBasis が有ればその対角線で大きさが決まる", () => {
    const withBasis = { ...shape, styleBasis: D_2080 };
    expect(hitStamp(withBasis, { x: 534, y: 400 }, 600, 400)).toBe(true);
  });
});

// --- drawStamp: 呼ばれた順を記録する偽の ctx ---

type Call = { op: string; args?: unknown[]; state?: Record<string, unknown> };

function createFakeCtx() {
  const calls: Call[] = [];
  const props: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    shadowColor: "rgba(0, 0, 0, 0)",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    lineCap: "butt",
    lineJoin: "miter",
  };
  const snapshot = () => ({ ...props });
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args, state: snapshot() });
  };
  const ctx = {
    ...Object.fromEntries(
      ["save", "restore", "beginPath", "arc", "moveTo", "lineTo", "fill", "stroke", "fillText"].map(
        (op) => [op, record(op)],
      ),
    ),
    measureText: (text: string) => ({
      width: text.length * 10,
      actualBoundingBoxAscent: 30,
      actualBoundingBoxDescent: 2,
    }),
  };
  for (const key of Object.keys(props)) {
    Object.defineProperty(ctx, key, {
      get: () => props[key],
      set: (v: unknown) => {
        props[key] = v;
      },
    });
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function paintCalls(calls: Call[]) {
  return calls.filter((c) => c.op === "fill" || c.op === "stroke" || c.op === "fillText");
}

describe("drawStamp", () => {
  it("影 → 白の円 → 色の円 → 数字 の順に描く", () => {
    const { ctx, calls } = createFakeCtx();
    drawStamp(ctx, stamp("number", { color: "#FF5C8A" }), 3, 2080, 1204);
    const paints = paintCalls(calls);
    expect(paints.map((c) => c.op)).toEqual(["fill", "fill", "fillText"]);
    // 1 回目: 影つきの白の円
    expect(paints[0].state?.fillStyle).toBe("#ffffff");
    expect(paints[0].state?.shadowColor).toBe("rgba(0, 0, 0, 0.35)");
    expect(paints[0].state?.shadowBlur).toBeCloseTo(70 * 0.08);
    expect(paints[0].state?.shadowOffsetY).toBeCloseTo(70 * 0.04);
    // 2 回目: 影なしの色の円
    expect(paints[1].state?.fillStyle).toBe("#FF5C8A");
    expect(paints[1].state?.shadowColor).toBe("rgba(0, 0, 0, 0)");
    // 3 回目: 白い数字
    expect(paints[2].args?.[0]).toBe("3");
    expect(paints[2].state?.fillStyle).toBe("#ffffff");
    expect(paints[2].state?.textAlign).toBe("center");
  });

  it("円の半径: 白は D/2、色は D/2 − 縁", () => {
    const { ctx, calls } = createFakeCtx();
    drawStamp(ctx, stamp("number"), 1, 2080, 1204);
    const arcs = calls.filter((c) => c.op === "arc").map((c) => c.args?.[2]);
    expect(arcs).toEqual([35, 35 - 5]);
  });

  it("2 桁の数字は直径 × 0.48 の太字", () => {
    const { ctx, calls } = createFakeCtx();
    drawStamp(ctx, stamp("number"), 12, 2080, 1204);
    const text = calls.find((c) => c.op === "fillText");
    expect(text?.args?.[0]).toBe("12");
    expect(text?.state?.font).toMatch(/^700 34px /);
  });

  it("1 桁の数字・記号 ! ? は直径 × 0.58、縦は丸の中心にそろえる", () => {
    const { ctx, calls } = createFakeCtx();
    drawStamp(ctx, stamp("question"), null, 2080, 1204);
    const text = calls.find((c) => c.op === "fillText");
    expect(text?.args?.[0]).toBe("?");
    expect(text?.state?.font).toMatch(/^700 41px /);
    // ascent 30・descent 2 → ベースライン = 中心 + (30 − 2) / 2
    expect(text?.args?.[2]).toBe(100 + 14);
  });

  it("✓ は線で描き、明るい色では記号が黒", () => {
    const { ctx, calls } = createFakeCtx();
    drawStamp(ctx, stamp("check", { color: "#FFCC00" }), null, 2080, 1204);
    const paints = paintCalls(calls);
    expect(paints.map((c) => c.op)).toEqual(["fill", "fill", "stroke"]);
    expect(paints[2].state?.strokeStyle).toBe("#1a1a1a");
    expect(paints[2].state?.lineWidth).toBeCloseTo(70 * 0.11);
    expect(paints[2].state?.lineCap).toBe("round");
    expect(calls.filter((c) => c.op === "lineTo")).toHaveLength(2);
  });

  it("× は 2 本の対角線", () => {
    const { ctx, calls } = createFakeCtx();
    drawStamp(ctx, stamp("cross"), null, 2080, 1204);
    expect(paintCalls(calls).map((c) => c.op)).toEqual(["fill", "fill", "stroke"]);
    expect(calls.filter((c) => c.op === "moveTo")).toHaveLength(2);
    expect(calls.filter((c) => c.op === "lineTo")).toHaveLength(2);
  });

  it("番号が null の番号スタンプは丸だけを描く", () => {
    const { ctx, calls } = createFakeCtx();
    drawStamp(ctx, stamp("number"), null, 2080, 1204);
    expect(paintCalls(calls).map((c) => c.op)).toEqual(["fill", "fill"]);
  });

  it("save と restore が対になる", () => {
    const { ctx, calls } = createFakeCtx();
    drawStamp(ctx, stamp("exclamation"), null, 2080, 1204);
    const saves = calls.filter((c) => c.op === "save").length;
    expect(saves).toBeGreaterThan(0);
    expect(calls.filter((c) => c.op === "restore").length).toBe(saves);
  });
});
