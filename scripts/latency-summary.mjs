#!/usr/bin/env node
// NFR-001中間計測(T11)のログ集計スクリプト。
//
// Rust側(`src-tauri/src/capture/mod.rs::format_latency_log`)が標準エラーへ
// 出力する機械可読な1行ログ
//   [tadcap:latency] origin=<button|tray|shortcut> spawn_ms=<経過ms>
// を集計し、起点(origin)ごとの件数・中央値・最小・最大と、PRD NFR-001の
// 基準値(200ms未満)を満たすかを表示する。
//
// 依存パッケージを追加せず、Node標準機能のみで実装する(NFR-003、PJM指示)。
// 使い方は testreport/nfr-001/README.md を参照。
//
//   node scripts/latency-summary.mjs <ログファイル>
//   screencapture-log.txt を貼り付けて保存 → 上記で実行
//   もしくはパイプ: some-command | node scripts/latency-summary.mjs
//
// 【注意】ここでの「中央値」等は `spawn_ms`(起点からscreencaptureプロセスの
// spawn()完了までの近似値)の統計であり、OS標準の選択UIが実際に画面へ表示
// された瞬間そのものではない(PRD NFR-001計測方法、`capture/mod.rs`の
// `CaptureProvider::capture` docコメント参照)。
//
// AM-T24: 自動マスキングの読み取り時間(`src-tauri/src/commands.rs::format_scan_latency_log`)
//   [tadcap:latency] origin=mask scan_ms=<経過ms> size=<幅>x<高さ>
// も別の表として集計する(画像の大きさの区分ごと。PRD auto-masking NFR-001 の目標は
// フル HD で 3000ms 以下)。spawn_ms の行だけのログでは、従来と同じ出力になる。

import { readFileSync } from "node:fs";

/** NFR-001基準値(ミリ秒未満)。PRD NFR-001。 */
export const NFR_001_THRESHOLD_MS = 200;

const LATENCY_LINE_PATTERN =
  /\[tadcap:latency\]\s+origin=(\S+)\s+spawn_ms=([0-9]+(?:\.[0-9]+)?)/;

/**
 * ログ1行から `{ origin, spawnMs }` を抽出する純粋関数。
 * 計測行以外(他のログ・空行等)は `null` を返す。
 *
 * @param {string} line
 * @returns {{ origin: string, spawnMs: number } | null}
 */
export function parseLatencyLine(line) {
  const match = LATENCY_LINE_PATTERN.exec(line);
  if (!match) {
    return null;
  }
  return { origin: match[1], spawnMs: Number(match[2]) };
}

/**
 * 複数行のログテキストから計測行のみを抽出する純粋関数。
 *
 * @param {string} text
 * @returns {{ origin: string, spawnMs: number }[]}
 */
export function parseLatencyLog(text) {
  return text
    .split(/\r?\n/)
    .map(parseLatencyLine)
    .filter((entry) => entry !== null);
}

/**
 * 数値配列の中央値を返す純粋関数(偶数個は中央2値の平均)。空配列は `null`。
 *
 * @param {number[]} values
 * @returns {number | null}
 */
export function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * origin別に件数・中央値・最小・最大・200ms未満判定を集計する純粋関数。
 *
 * @param {{ origin: string, spawnMs: number }[]} entries
 * @returns {Record<string, { count: number, median: number, min: number, max: number, under200: boolean }>}
 */
export function summarize(entries) {
  /** @type {Map<string, number[]>} */
  const byOrigin = new Map();
  for (const entry of entries) {
    const values = byOrigin.get(entry.origin) ?? [];
    values.push(entry.spawnMs);
    byOrigin.set(entry.origin, values);
  }

  /** @type {Record<string, { count: number, median: number, min: number, max: number, under200: boolean }>} */
  const result = {};
  for (const [origin, values] of byOrigin) {
    const med = /** @type {number} */ (median(values));
    result[origin] = {
      count: values.length,
      median: med,
      min: Math.min(...values),
      max: Math.max(...values),
      under200: med < NFR_001_THRESHOLD_MS,
    };
  }
  return result;
}

/**
 * 集計結果を人間が読めるタブ区切りテーブルに整形する純粋関数。
 *
 * @param {ReturnType<typeof summarize>} summary
 * @returns {string}
 */
export function formatSummaryTable(summary) {
  const header = `origin\tcount\tmedian_ms\tmin_ms\tmax_ms\t<${NFR_001_THRESHOLD_MS}ms判定`;
  const rows = Object.entries(summary).map(([origin, s]) => {
    const verdict = s.under200 ? "PASS" : "FAIL";
    return `${origin}\t${s.count}\t${s.median.toFixed(1)}\t${s.min.toFixed(1)}\t${s.max.toFixed(1)}\t${verdict}`;
  });
  return [header, ...rows].join("\n");
}

/** 自動マスキングの読み取り時間の目標(ミリ秒以下)。PRD auto-masking NFR-001。 */
export const SCAN_THRESHOLD_MS = 3000;

/** フル HD に区分する幅・高さの許容差(px)。範囲選択で撮ると数 px ずれるため。 */
const FHD_TOLERANCE_PX = 40;

const SCAN_LINE_PATTERN =
  /\[tadcap:latency\]\s+origin=mask\s+scan_ms=([0-9]+(?:\.[0-9]+)?)(?:\s+size=([0-9]+)x([0-9]+))?/;

/**
 * ログ1行から `{ scanMs, width, height }` を抽出する純粋関数。
 * `origin=mask scan_ms=` 以外の行は `null`。size が無ければ幅・高さは `null`。
 *
 * @param {string} line
 * @returns {{ scanMs: number, width: number | null, height: number | null } | null}
 */
export function parseScanLine(line) {
  const match = SCAN_LINE_PATTERN.exec(line);
  if (!match) {
    return null;
  }
  return {
    scanMs: Number(match[1]),
    width: match[2] === undefined ? null : Number(match[2]),
    height: match[3] === undefined ? null : Number(match[3]),
  };
}

/**
 * 複数行のログテキストから読み取り時間の行のみを抽出する純粋関数。
 *
 * @param {string} text
 * @returns {{ scanMs: number, width: number | null, height: number | null }[]}
 */
export function parseScanLog(text) {
  return text
    .split(/\r?\n/)
    .map(parseScanLine)
    .filter((entry) => entry !== null);
}

/**
 * 画像の大きさを集計の区分に変換する純粋関数。
 * 1920x1080 の前後 {@link FHD_TOLERANCE_PX} px 以内は `fhd`、それ以外は `other`、不明は `unknown`。
 *
 * @param {number | null} width
 * @param {number | null} height
 * @returns {"fhd" | "other" | "unknown"}
 */
export function sizeClass(width, height) {
  if (width === null || height === null) {
    return "unknown";
  }
  const nearFhd =
    Math.abs(width - 1920) <= FHD_TOLERANCE_PX && Math.abs(height - 1080) <= FHD_TOLERANCE_PX;
  return nearFhd ? "fhd" : "other";
}

/**
 * 大きさの区分ごとに件数・中央値・最小・最大と、中央値・最大値が 3000ms 以下かを集計する純粋関数。
 *
 * @param {{ scanMs: number, width: number | null, height: number | null }[]} entries
 * @returns {Record<string, { count: number, median: number, min: number, max: number, medianWithin: boolean, maxWithin: boolean }>}
 */
export function summarizeScan(entries) {
  /** @type {Map<string, number[]>} */
  const byClass = new Map();
  for (const entry of entries) {
    const key = sizeClass(entry.width, entry.height);
    const values = byClass.get(key) ?? [];
    values.push(entry.scanMs);
    byClass.set(key, values);
  }

  /** @type {Record<string, { count: number, median: number, min: number, max: number, medianWithin: boolean, maxWithin: boolean }>} */
  const result = {};
  for (const [key, values] of byClass) {
    const med = /** @type {number} */ (median(values));
    const max = Math.max(...values);
    result[key] = {
      count: values.length,
      median: med,
      min: Math.min(...values),
      max,
      medianWithin: med <= SCAN_THRESHOLD_MS,
      maxWithin: max <= SCAN_THRESHOLD_MS,
    };
  }
  return result;
}

/**
 * 読み取り時間の集計結果をタブ区切りテーブルに整形する純粋関数。
 *
 * @param {ReturnType<typeof summarizeScan>} summary
 * @returns {string}
 */
export function formatScanSummaryTable(summary) {
  const header = `size\tcount\tmedian_ms\tmin_ms\tmax_ms\tmedian<=${SCAN_THRESHOLD_MS}ms\tmax<=${SCAN_THRESHOLD_MS}ms`;
  const rows = Object.entries(summary).map(([key, s]) => {
    const medianVerdict = s.medianWithin ? "PASS" : "FAIL";
    const maxVerdict = s.maxWithin ? "PASS" : "FAIL";
    return `${key}\t${s.count}\t${s.median.toFixed(1)}\t${s.min.toFixed(1)}\t${s.max.toFixed(1)}\t${medianVerdict}\t${maxVerdict}`;
  });
  return [header, ...rows].join("\n");
}

/**
 * ログ全体から出力する文字列を組み立てる純粋関数。spawn_ms の表と scan_ms の表を、
 * 行がある方だけ空行で区切って並べる。どちらも無ければ `null`。
 *
 * @param {string} text
 * @returns {string | null}
 */
export function buildReport(text) {
  const tables = [];
  const spawnEntries = parseLatencyLog(text);
  if (spawnEntries.length > 0) {
    tables.push(formatSummaryTable(summarize(spawnEntries)));
  }
  const scanEntries = parseScanLog(text);
  if (scanEntries.length > 0) {
    tables.push(formatScanSummaryTable(summarizeScan(scanEntries)));
  }
  return tables.length === 0 ? null : tables.join("\n\n");
}

function readInputText(argv) {
  const path = argv[2];
  if (path) {
    return readFileSync(path, "utf8");
  }
  // 引数省略時は標準入力から読む(パイプ利用時)。
  return readFileSync(0, "utf8");
}

function main() {
  let text;
  try {
    text = readInputText(process.argv);
  } catch (err) {
    console.error(
      `ログの読み込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "使い方: node scripts/latency-summary.mjs <ログファイル> (または標準入力にパイプ)",
    );
    process.exitCode = 1;
    return;
  }

  const report = buildReport(text);
  if (report === null) {
    console.error(
      "[tadcap:latency] 形式の行が見つかりませんでした。testreport/nfr-001/README.md の手順を確認してください。",
    );
    process.exitCode = 1;
    return;
  }

  console.log(report);
}

// このファイルが直接実行された場合のみ main() を呼ぶ(テストからimportした
// ときは実行しない)。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
