import { describe, expect, it } from "vitest";

// `scripts/latency-summary.mjs` は依存追加なしのNode実行スクリプト(NFR-003、
// T11指示)であり型定義を持たないプレーンJSモジュールのため、`vite.config.ts`
// の `node:process` importと同じ方針で `@ts-expect-error` を付ける。
// @ts-expect-error 型定義のないプレーンJSモジュール
import { formatSummaryTable, median, NFR_001_THRESHOLD_MS, parseLatencyLine, parseLatencyLog, summarize } from "../../scripts/latency-summary.mjs";

describe("parseLatencyLine", () => {
  it("Rust側が出力する形式の行をorigin/spawnMsへ分解する", () => {
    expect(parseLatencyLine("[tadcap:latency] origin=shortcut spawn_ms=12.3")).toEqual({
      origin: "shortcut",
      spawnMs: 12.3,
    });
  });

  it("行頭に別の文字列(タイムスタンプ等)が混じっていても抽出できる", () => {
    expect(
      parseLatencyLine("2026-09-23T00:00:00Z [tadcap:latency] origin=tray spawn_ms=5"),
    ).toEqual({ origin: "tray", spawnMs: 5 });
  });

  it("整数のspawn_ms(小数点なし)も抽出できる", () => {
    expect(parseLatencyLine("[tadcap:latency] origin=button spawn_ms=8")).toEqual({
      origin: "button",
      spawnMs: 8,
    });
  });

  it("形式に一致しない行はnullを返す", () => {
    expect(parseLatencyLine("this is not a latency line")).toBeNull();
  });

  it("空行はnullを返す", () => {
    expect(parseLatencyLine("")).toBeNull();
  });
});

describe("parseLatencyLog", () => {
  it("複数行のログから計測行のみを抽出し、無関係な行は無視する", () => {
    const text = [
      "[tadcap:latency] origin=button spawn_ms=10.0",
      "何か関係ない標準エラー出力の行",
      "[tadcap:latency] origin=button spawn_ms=20.0",
      "",
    ].join("\n");

    expect(parseLatencyLog(text)).toEqual([
      { origin: "button", spawnMs: 10.0 },
      { origin: "button", spawnMs: 20.0 },
    ]);
  });

  it("計測行が1つも無ければ空配列を返す", () => {
    expect(parseLatencyLog("no latency lines here\nanother line")).toEqual([]);
  });
});

describe("median", () => {
  it("奇数個の配列は中央値を返す", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("偶数個の配列は中央2値の平均を返す", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("要素数10個(実際の計測想定件数)でも正しく中央値を計算する", () => {
    const tenValues = [120, 130, 110, 150, 140, 125, 135, 145, 115, 160];
    // ソート: 110,115,120,125,130,135,140,145,150,160 → 中央2値(130,135)の平均
    expect(median(tenValues)).toBe(132.5);
  });

  it("空配列はnullを返す", () => {
    expect(median([])).toBeNull();
  });
});

describe("summarize", () => {
  it("origin別にcount/median/min/max/200ms未満判定を集計する", () => {
    const entries = [
      { origin: "shortcut", spawnMs: 100 },
      { origin: "shortcut", spawnMs: 300 },
      { origin: "tray", spawnMs: 50 },
    ];

    const result = summarize(entries);

    expect(result.shortcut).toEqual({
      count: 2,
      median: 200,
      min: 100,
      max: 300,
      under200: false,
    });
    expect(result.tray).toEqual({
      count: 1,
      median: 50,
      min: 50,
      max: 50,
      under200: true,
    });
  });

  it("中央値がちょうど200msの場合はNFR-001未達(under200=false)と判定する(未満基準)", () => {
    const result = summarize([
      { origin: "button", spawnMs: 200 },
      { origin: "button", spawnMs: 200 },
    ]);

    expect(result.button.median).toBe(NFR_001_THRESHOLD_MS);
    expect(result.button.under200).toBe(false);
  });
});

describe("formatSummaryTable", () => {
  it("origin行・PASS/FAIL判定を含むタブ区切りテーブルを生成する", () => {
    const table = formatSummaryTable({
      shortcut: { count: 10, median: 150.4, min: 100, max: 200, under200: true },
      tray: { count: 3, median: 250, min: 220, max: 300, under200: false },
    });

    expect(table).toContain("shortcut");
    expect(table).toContain("150.4");
    expect(table).toContain("PASS");
    expect(table).toContain("tray");
    expect(table).toContain("FAIL");
  });
});
