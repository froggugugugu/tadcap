import { describe, expect, it } from "vitest";

import { copyRatio, shrunkSize } from "./copyScale";

describe("shrunkSize", () => {
  it("2 倍の画像は幅・高さを 2 で割った大きさになる(3024×1964 → 1512×982)", () => {
    expect(shrunkSize(3024, 1964, 2)).toEqual({ width: 1512, height: 982 });
  });

  it("割り切れない大きさは四捨五入する(3×5 → 2×3)", () => {
    expect(shrunkSize(3, 5, 2)).toEqual({ width: 2, height: 3 });
  });

  it("縮めても最小 1px を保つ(1×1 → 1×1)", () => {
    expect(shrunkSize(1, 1, 2)).toEqual({ width: 1, height: 1 });
  });

  it.each([
    ["1", 1],
    ["0.5", 0.5],
    ["0", 0],
    ["負の値", -2],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("ratio が %s のときは元の大きさのまま", (_label, ratio) => {
    expect(shrunkSize(3024, 1964, ratio)).toEqual({ width: 3024, height: 1964 });
  });
});

describe("copyRatio", () => {
  it.each([
    [false, 1, 1],
    [false, 2, 1],
    [false, null, 1],
    [true, 1, 1],
    [true, 2, 2],
    [true, null, 1],
  ] as const)("設定 %s × 倍率 %s → %s", (enabled, pixelRatio, expected) => {
    expect(copyRatio(enabled, pixelRatio)).toBe(expected);
  });

  it.each([
    ["undefined", undefined],
    ["0", 0],
    ["負の値", -2],
    ["小数", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("設定オンでも倍率が不正値(%s)なら 1(縮めない)", (_label, pixelRatio) => {
    expect(copyRatio(true, pixelRatio)).toBe(1);
  });
});
