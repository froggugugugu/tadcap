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
};

describe("startCapture", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("capture_screenコマンドを引数なしで呼び出し、成功結果をそのまま返す", async () => {
    invokeMock.mockResolvedValue(sampleResult);

    await expect(startCapture()).resolves.toEqual(sampleResult);
    expect(invokeMock).toHaveBeenCalledWith("capture_screen");
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
