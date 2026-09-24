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

  const entries = parseLatencyLog(text);
  if (entries.length === 0) {
    console.error(
      "[tadcap:latency] 形式の行が見つかりませんでした。testreport/nfr-001/README.md の手順を確認してください。",
    );
    process.exitCode = 1;
    return;
  }

  const summary = summarize(entries);
  console.log(formatSummaryTable(summary));
}

// このファイルが直接実行された場合のみ main() を呼ぶ(テストからimportした
// ときは実行しない)。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
