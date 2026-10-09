import { describe, expect, it } from "vitest";

// `scripts/latency-summary.mjs` は依存追加なしのNode実行スクリプト(NFR-003、
// T11指示)であり型定義を持たないプレーンJSモジュールのため、`vite.config.ts`
// の `node:process` importと同じ方針で `@ts-expect-error` を付ける。
// @ts-expect-error 型定義のないプレーンJSモジュール
import { buildReport, formatScanSummaryTable, formatSummaryTable, median, NFR_001_THRESHOLD_MS, parseLatencyLine, parseLatencyLog, parseScanLine, parseScanLog, SCAN_THRESHOLD_MS, sizeClass, summarize, summarizeScan } from "../../scripts/latency-summary.mjs";

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

// AM-T24: 自動マスキングの読み取り時間(`origin=mask scan_ms=<ms> size=<w>x<h>`、
// `src-tauri/src/commands.rs::format_scan_latency_log`)の集計。既存の spawn_ms とは別の表にする。
describe("parseScanLine", () => {
  it("Rust側が出力する形式の行をscanMs/width/heightへ分解する", () => {
    expect(parseScanLine("[tadcap:latency] origin=mask scan_ms=1234.6 size=1920x1080")).toEqual({
      scanMs: 1234.6,
      width: 1920,
      height: 1080,
    });
  });

  it("行頭にタイムスタンプ等が混じっていても抽出できる", () => {
    expect(parseScanLine("12:00:00 [tadcap:latency] origin=mask scan_ms=800 size=3024x1964")).toEqual({
      scanMs: 800,
      width: 3024,
      height: 1964,
    });
  });

  it("size が無い行も scan_ms だけ抽出する(大きさは null)", () => {
    expect(parseScanLine("[tadcap:latency] origin=mask scan_ms=500.0")).toEqual({
      scanMs: 500,
      width: null,
      height: null,
    });
  });

  it("spawn_ms の行・無関係な行は null を返す", () => {
    expect(parseScanLine("[tadcap:latency] origin=shortcut spawn_ms=12.3")).toBeNull();
    expect(parseScanLine("not a latency line")).toBeNull();
    expect(parseScanLine("")).toBeNull();
  });
});

describe("sizeClass", () => {
  it("1920x1080 とその前後 40px 以内はフル HD に区分する(範囲選択の誤差を許す)", () => {
    expect(sizeClass(1920, 1080)).toBe("fhd");
    expect(sizeClass(1880, 1040)).toBe("fhd");
    expect(sizeClass(1960, 1120)).toBe("fhd");
  });

  it("それ以外の大きさは other、大きさ不明は unknown に区分する", () => {
    expect(sizeClass(3840, 2160)).toBe("other");
    expect(sizeClass(1879, 1080)).toBe("other");
    expect(sizeClass(800, 600)).toBe("other");
    expect(sizeClass(null, null)).toBe("unknown");
  });
});

describe("summarizeScan", () => {
  it("大きさの区分ごとに count/median/min/max と 3000ms 以下の判定を集計する", () => {
    const result = summarizeScan([
      { scanMs: 1000, width: 1920, height: 1080 },
      { scanMs: 3000, width: 1920, height: 1080 },
      { scanMs: 2000, width: 1920, height: 1080 },
      { scanMs: 4000, width: 3840, height: 2160 },
    ]);

    expect(result.fhd).toEqual({
      count: 3,
      median: 2000,
      min: 1000,
      max: 3000,
      medianWithin: true,
      maxWithin: true,
    });
    expect(result.other).toEqual({
      count: 1,
      median: 4000,
      min: 4000,
      max: 4000,
      medianWithin: false,
      maxWithin: false,
    });
  });

  it("目標は「以下」なので、ちょうど 3000ms は達成と判定する", () => {
    expect(SCAN_THRESHOLD_MS).toBe(3000);
    const result = summarizeScan([{ scanMs: 3000, width: 1920, height: 1080 }]);
    expect(result.fhd.medianWithin).toBe(true);
    expect(result.fhd.maxWithin).toBe(true);
  });
});

describe("formatScanSummaryTable", () => {
  it("区分行・中央値と最大値の PASS/FAIL を含むタブ区切りテーブルを生成する", () => {
    const table = formatScanSummaryTable({
      fhd: { count: 10, median: 1500.25, min: 900, max: 2800, medianWithin: true, maxWithin: true },
      other: { count: 2, median: 3500, min: 3200, max: 3800, medianWithin: false, maxWithin: false },
    });
    const lines = table.split("\n");

    expect(lines[0]).toBe("size\tcount\tmedian_ms\tmin_ms\tmax_ms\tmedian<=3000ms\tmax<=3000ms");
    expect(lines[1]).toBe("fhd\t10\t1500.3\t900.0\t2800.0\tPASS\tPASS");
    expect(lines[2]).toBe("other\t2\t3500.0\t3200.0\t3800.0\tFAIL\tFAIL");
  });
});

describe("混在ログの集計(spawn_ms と scan_ms)", () => {
  const mixed = [
    "[tadcap:latency] origin=shortcut spawn_ms=20.0",
    "[tadcap:latency] origin=mask scan_ms=1500.0 size=1920x1080",
    "関係ない行",
    "[tadcap:latency] origin=shortcut spawn_ms=30.0",
    "[tadcap:latency] origin=mask scan_ms=2500.0 size=1920x1080",
    "[tadcap:latency] origin=mask scan_ms=5000.0 size=3024x1964",
  ].join("\n");

  it("spawn_ms と scan_ms がそれぞれ別々に抽出される", () => {
    expect(parseLatencyLog(mixed)).toEqual([
      { origin: "shortcut", spawnMs: 20 },
      { origin: "shortcut", spawnMs: 30 },
    ]);
    expect(parseScanLog(mixed)).toEqual([
      { scanMs: 1500, width: 1920, height: 1080 },
      { scanMs: 2500, width: 1920, height: 1080 },
      { scanMs: 5000, width: 3024, height: 1964 },
    ]);
  });

  it("buildReport は spawn_ms の表と scan_ms の表を空行で区切って並べる", () => {
    const spawnTable = formatSummaryTable(summarize(parseLatencyLog(mixed)));
    const scanTable = formatScanSummaryTable(summarizeScan(parseScanLog(mixed)));

    expect(buildReport(mixed)).toBe(`${spawnTable}\n\n${scanTable}`);
    expect(scanTable).toContain("fhd\t2\t2000.0\t1500.0\t2500.0\tPASS\tPASS");
    expect(scanTable).toContain("other\t1\t5000.0\t5000.0\t5000.0\tFAIL\tFAIL");
  });

  it("spawn_ms の行だけのログでは、従来と同じ出力(spawn_ms の表だけ)になる", () => {
    const spawnOnly = [
      "[tadcap:latency] origin=button spawn_ms=10.0",
      "[tadcap:latency] origin=tray spawn_ms=250.0",
    ].join("\n");

    expect(buildReport(spawnOnly)).toBe(
      "origin\tcount\tmedian_ms\tmin_ms\tmax_ms\t<200ms判定\nbutton\t1\t10.0\t10.0\t10.0\tPASS\ntray\t1\t250.0\t250.0\t250.0\tFAIL",
    );
  });

  it("scan_ms の行だけのログでは scan_ms の表だけを出す", () => {
    const scanOnly = "[tadcap:latency] origin=mask scan_ms=1200.0 size=1920x1080";
    expect(buildReport(scanOnly)).toBe(
      "size\tcount\tmedian_ms\tmin_ms\tmax_ms\tmedian<=3000ms\tmax<=3000ms\nfhd\t1\t1200.0\t1200.0\t1200.0\tPASS\tPASS",
    );
  });

  it("どちらの行も無ければ null を返す", () => {
    expect(buildReport("no latency lines")).toBeNull();
  });
});
