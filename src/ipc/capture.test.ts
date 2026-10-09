import { beforeEach, describe, expect, it, vi } from "vitest";

// `@tauri-apps/api` はTauriランタイム無しでは動作しないため、モックに差し替える
// (T07仕様: 「@tauri-apps/api はモック」)。`vi.mock` はホイストされるため、
// 下の `import` より前に評価される。
const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  CAPTURE_COMPLETED_EVENT,
  CAPTURE_ERROR_EVENT,
  normalizePixelRatio,
  onCaptureCompleted,
  onCaptureError,
  readCaptureImage,
  startCapture,
  type CaptureResult,
} from "./capture";

const sampleResult: CaptureResult = {
  id: "capture-1",
  sourcePath: "/tmp/tadcap-captures/capture-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
  pixelRatio: 2,
};

/** 倍率の欠落した古い形の応答(QE-T07 以前の Rust)。 */
const legacyResult = {
  id: "capture-1",
  sourcePath: "/tmp/tadcap-captures/capture-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("normalizePixelRatio(QE-T07: 1 | 2 | null 以外は不明 = null)", () => {
  it.each([
    [1, 1],
    [2, 2],
    [null, null],
    [undefined, null],
    [3, null],
    [1.5, null],
    ["2", null],
    [0, null],
    [Number.NaN, null],
    [true, null],
  ])("%j は %j", (input, expected) => {
    expect(normalizePixelRatio(input)).toBe(expected);
  });
});

describe("startCapture", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("capture_screenコマンドを引数なしで呼び出し、成功結果をそのまま返す", async () => {
    invokeMock.mockResolvedValue(sampleResult);

    await expect(startCapture()).resolves.toEqual(sampleResult);
    expect(invokeMock).toHaveBeenCalledWith("capture_screen");
  });

  it.each([
    [1, 1],
    [2, 2],
    [null, null],
    [3, null],
    [1.5, null],
    ["2", null],
  ])("撮影結果の倍率 %j は %j として返す", async (raw, expected) => {
    invokeMock.mockResolvedValue({ ...legacyResult, pixelRatio: raw });

    await expect(startCapture()).resolves.toEqual({ ...legacyResult, pixelRatio: expected });
  });

  it("倍率の欠落した応答(後方互換)は倍率不明(null)として返す", async () => {
    invokeMock.mockResolvedValue(legacyResult);

    await expect(startCapture()).resolves.toEqual({ ...legacyResult, pixelRatio: null });
  });

  it("Escキャンセル時(戻り値null)はnullを返す", async () => {
    invokeMock.mockResolvedValue(null);

    await expect(startCapture()).resolves.toBeNull();
  });

  it("失敗時は文字列のままrejectする(AppErrorのDisplay文字列)", async () => {
    invokeMock.mockRejectedValue("permission_denied");

    await expect(startCapture()).rejects.toBe("permission_denied");
  });
});

describe("onCaptureCompleted", () => {
  beforeEach(() => {
    listenMock.mockReset();
  });

  it("capture://completedイベント名で購読し、受信したpayloadをハンドラへ渡す", async () => {
    listenMock.mockResolvedValue(() => {});
    const handler = vi.fn();

    await onCaptureCompleted(handler);

    expect(listenMock).toHaveBeenCalledWith(
      CAPTURE_COMPLETED_EVENT,
      expect.any(Function),
    );

    const registeredCallback = listenMock.mock.calls[0]?.[1] as (event: {
      payload: CaptureResult;
    }) => void;
    registeredCallback({ payload: sampleResult });

    expect(handler).toHaveBeenCalledWith(sampleResult);
  });

  it.each([
    [undefined, null],
    [3, null],
    ["2", null],
    [1, 1],
  ])("イベントの倍率 %j は %j としてハンドラへ渡す(欠落は後方互換で不明)", async (raw, expected) => {
    listenMock.mockResolvedValue(() => {});
    const handler = vi.fn();

    await onCaptureCompleted(handler);
    const registeredCallback = listenMock.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
    registeredCallback({ payload: raw === undefined ? legacyResult : { ...legacyResult, pixelRatio: raw } });

    expect(handler).toHaveBeenCalledWith({ ...legacyResult, pixelRatio: expected });
  });
});

describe("onCaptureError", () => {
  beforeEach(() => {
    listenMock.mockReset();
  });

  it("capture://errorイベント名で購読し、受信したpayload(文字列)をハンドラへ渡す(T08、トレイ/ショートカット起点)", async () => {
    listenMock.mockResolvedValue(() => {});
    const handler = vi.fn();

    await onCaptureError(handler);

    expect(listenMock).toHaveBeenCalledWith(
      CAPTURE_ERROR_EVENT,
      expect.any(Function),
    );

    const registeredCallback = listenMock.mock.calls[0]?.[1] as (event: {
      payload: string;
    }) => void;
    registeredCallback({ payload: "permission_denied" });

    expect(handler).toHaveBeenCalledWith("permission_denied");
  });
});

describe("readCaptureImage", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("read_capture_imageコマンドへパスを渡し、返ったバイト列をimage/pngのBlobにする(実機不具合②〜⑤: asset URLを使わない)", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    invokeMock.mockResolvedValue(bytes.buffer);

    const blob = await readCaptureImage(sampleResult.sourcePath);

    expect(invokeMock).toHaveBeenCalledWith("read_capture_image", {
      path: sampleResult.sourcePath,
    });
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it("失敗時はRust側のエラー文字列のままrejectする", async () => {
    invokeMock.mockRejectedValue("キャプチャ用ディレクトリ外のファイルは読み込めません");

    await expect(readCaptureImage("/etc/passwd")).rejects.toBe(
      "キャプチャ用ディレクトリ外のファイルは読み込めません",
    );
  });
});
