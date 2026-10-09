import { beforeEach, describe, expect, it, vi } from "vitest";

// `@tauri-apps/api` は Tauri ランタイム無しでは動作しないため、モックに差し替える
// (既存 `capture.test.ts` と同じ作法)。`vi.mock` はホイストされるため、下の `import` より前に評価される。
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  SCAN_SENSITIVE_TEXT_COMMAND,
  TextScanError,
  scanSensitiveText,
  type ScannedCandidate,
} from "./textScan";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

function pngBlob(): Blob {
  return new Blob([PNG_BYTES], { type: "image/png" });
}

const validCandidates: ScannedCandidate[] = [
  { x: 0, y: 0, width: 10, height: 20, kind: "contact" },
  { x: 5, y: 6, width: 7, height: 8, kind: "credential" },
  { x: 100, y: 200, width: 1, height: 1, kind: "identifier" },
  { x: 3, y: 4, width: 50, height: 12, kind: "financial" },
];

/** 失敗を `TextScanError` として受け取る(型を確かめてから `code` を見る)。 */
async function captureError(promise: Promise<unknown>): Promise<TextScanError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TextScanError);
    return error as TextScanError;
  }
  throw new Error("reject されなかった");
}

describe("scanSensitiveText", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("scan_sensitive_text へ PNG の Blob を生のバイト列(Uint8Array)のまま 1 引数で渡す", async () => {
    invokeMock.mockResolvedValue([]);

    await scanSensitiveText(pngBlob());

    expect(SCAN_SENSITIVE_TEXT_COMMAND).toBe("scan_sensitive_text");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const args = invokeMock.mock.calls[0] ?? [];
    expect(args).toHaveLength(2);
    expect(args[0]).toBe("scan_sensitive_text");
    expect(args[1]).toBeInstanceOf(Uint8Array);
    expect(Array.from(args[1] as Uint8Array)).toEqual(Array.from(PNG_BYTES));
  });

  it("正しい応答を 4 種の ScannedCandidate[] として返す", async () => {
    invokeMock.mockResolvedValue(validCandidates.map((c) => ({ ...c })));

    await expect(scanSensitiveText(pngBlob())).resolves.toEqual(validCandidates);
  });

  it("0 件の応答は空配列を返す", async () => {
    invokeMock.mockResolvedValue([]);

    await expect(scanSensitiveText(pngBlob())).resolves.toEqual([]);
  });

  it("返す候補は応答のオブジェクトをそのまま使わず、5 つのキーだけを持つ新しいオブジェクトにする", async () => {
    const response = [{ x: 1, y: 2, width: 3, height: 4, kind: "contact" }];
    invokeMock.mockResolvedValue(response);

    const result = await scanSensitiveText(pngBlob());

    expect(result[0]).not.toBe(response[0]);
    expect(Object.keys(result[0] ?? {}).sort()).toEqual(
      ["height", "kind", "width", "x", "y"],
    );
  });

  describe("応答の形が不正なら 1 件でも全体を例外にする(部分的に返さない)", () => {
    const valid = { x: 1, y: 2, width: 3, height: 4, kind: "contact" };
    const cases: Array<[string, unknown]> = [
      ["配列でない(オブジェクト)", { candidates: [valid] }],
      ["配列でない(null)", null],
      ["配列でない(文字列)", "[]"],
      ["要素が null", [valid, null]],
      ["要素が配列", [[1, 2, 3, 4, "contact"]]],
      ["小数", [valid, { ...valid, x: 1.5 }]],
      ["負数", [valid, { ...valid, y: -1 }]],
      ["NaN", [valid, { ...valid, width: Number.NaN }]],
      ["Infinity", [valid, { ...valid, height: Number.POSITIVE_INFINITY }]],
      ["幅が 0", [valid, { ...valid, width: 0 }]],
      ["高さが 0", [valid, { ...valid, height: 0 }]],
      ["数値が文字列", [valid, { ...valid, x: "1" }]],
      ["キーの欠落", [valid, { x: 1, y: 2, width: 3, kind: "contact" }]],
      ["未知の kind", [valid, { ...valid, kind: "address" }]],
      ["kind が大文字", [valid, { ...valid, kind: "Contact" }]],
      ["余分な文字列フィールド", [valid, { ...valid, text: "読み取った文字列" }]],
      ["余分な数値フィールド", [valid, { ...valid, confidence: 0 }]],
    ];

    it.each(cases)("%s", async (_label, response) => {
      invokeMock.mockResolvedValue(response);

      const error = await captureError(scanSensitiveText(pngBlob()));
      expect(error.code).toBe("invalid_response");
    });

    it("例外のメッセージに応答の中身(文字列)を含めない", async () => {
      invokeMock.mockResolvedValue([{ ...valid, text: "secret-value-123" }]);

      const error = await captureError(scanSensitiveText(pngBlob()));
      expect(error.message).not.toContain("secret-value-123");
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    });
  });

  describe("Rust の固定エラー文字列を区別できる例外にする", () => {
    it("text_scan_busy は code=busy", async () => {
      invokeMock.mockRejectedValue("text_scan_busy");

      const error = await captureError(scanSensitiveText(pngBlob()));
      expect(error.code).toBe("busy");
      expect(error.name).toBe("TextScanError");
    });

    it("text_scan_failed は code=failed", async () => {
      invokeMock.mockRejectedValue("text_scan_failed");

      const error = await captureError(scanSensitiveText(pngBlob()));
      expect(error.code).toBe("failed");
    });

    it("想定外の reject(通信の例外など)も code=failed にまとめる", async () => {
      invokeMock.mockRejectedValue(new Error("ipc channel closed"));

      const error = await captureError(scanSensitiveText(pngBlob()));
      expect(error.code).toBe("failed");
    });
  });
});
