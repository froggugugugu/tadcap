//! Rust コマンド `scan_sensitive_text` の呼び出しと応答の形の検証(ARCH_auto-masking §4・§5.4・§7.2)。
//!
//! - ベースの PNG を生のバイト列(`InvokeBody::Raw`)で送る。幅・高さは Rust が IHDR から読む
//! - 応答は候補の矩形(画像の実ピクセル・整数)と 4 分類の種類だけ。文字列は IPC を通らない(NFR-002)。
//!   想定外のキーを持つ候補が 1 件でもあれば全体を失敗にし、受け取ったオブジェクトは返さずに
//!   5 つのキーだけを詰め替える(部分的に印を出さない、§7.2)
//! - 例外のメッセージ・`cause` に応答の中身を含めない
//!
//! `src/ipc/` は Tauri API 以外に依存しない。`canvas/`・`ui/` は import しない
//! (応答の型は `ipc/` 側で独立に定義し、`ui/autoMask.ts` が `maskSession` の型へ詰め替える。§3.2)。

import { invoke } from "@tauri-apps/api/core";

/** Rust コマンド名(`src-tauri/src/commands.rs::scan_sensitive_text` と一致させる)。 */
export const SCAN_SENSITIVE_TEXT_COMMAND = "scan_sensitive_text";

/** 候補の種類(Rust `masking::MaskKind` の小文字の JSON 表現)。 */
export type ScannedKind = "contact" | "credential" | "identifier" | "financial";

/** 候補 1 件(Rust `masking::MaskCandidate`)。座標は画像の実ピクセル(整数・左上原点)。 */
export interface ScannedCandidate {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: ScannedKind;
}

/**
 * 失敗の種類。
 * - `busy`: 別の読み取りが実行中(Rust の固定文字列 `text_scan_busy`)
 * - `failed`: 読み取りの失敗(`text_scan_failed`)と、それ以外の reject(通信の例外など)
 * - `invalid_response`: 応答の形が §5.4 と違う
 */
export type TextScanErrorCode = "busy" | "failed" | "invalid_response";

/** {@link scanSensitiveText} が reject する例外。原因の詳細は持たせない(ARCH §12)。 */
export class TextScanError extends Error {
  constructor(public readonly code: TextScanErrorCode) {
    super(`文字の読み取りに失敗しました(${code})`);
    this.name = "TextScanError";
  }
}

const BUSY_ERROR = "text_scan_busy";

const KINDS: ReadonlySet<string> = new Set<ScannedKind>([
  "contact",
  "credential",
  "identifier",
  "financial",
]);

const CANDIDATE_KEYS: ReadonlySet<string> = new Set(["x", "y", "width", "height", "kind"]);

/**
 * ベースの PNG から機密情報の候補を読み取る。
 *
 * 失敗時は {@link TextScanError} を reject する(`code` で `busy` / `failed` / `invalid_response` を区別)。
 */
export async function scanSensitiveText(png: Blob): Promise<ScannedCandidate[]> {
  const bytes = new Uint8Array(await png.arrayBuffer());
  let response: unknown;
  try {
    response = await invoke<unknown>(SCAN_SENSITIVE_TEXT_COMMAND, bytes);
  } catch (error) {
    throw new TextScanError(error === BUSY_ERROR ? "busy" : "failed");
  }
  return parseCandidates(response);
}

function parseCandidates(response: unknown): ScannedCandidate[] {
  if (!Array.isArray(response)) {
    throw new TextScanError("invalid_response");
  }
  return response.map(parseCandidate);
}

function parseCandidate(value: unknown): ScannedCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TextScanError("invalid_response");
  }
  // 想定外のキー(読み取った文字列など)を 1 つでも持てば全体を失敗にする
  const keys = Object.keys(value);
  if (keys.length !== CANDIDATE_KEYS.size || !keys.every((key) => CANDIDATE_KEYS.has(key))) {
    throw new TextScanError("invalid_response");
  }
  const record = value as Record<string, unknown>;
  const { x, y, width, height, kind } = record;
  if (
    !isPixel(x, 0) ||
    !isPixel(y, 0) ||
    !isPixel(width, 1) ||
    !isPixel(height, 1) ||
    typeof kind !== "string" ||
    !KINDS.has(kind)
  ) {
    throw new TextScanError("invalid_response");
  }
  return { x, y, width, height, kind: kind as ScannedKind };
}

/** 有限の安全な整数で、`min` 以上か(Rust の `u32`。幅・高さは 1 以上、§7.2)。 */
function isPixel(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}
