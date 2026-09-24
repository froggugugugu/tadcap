import { beforeEach, describe, expect, it, vi } from "vitest";

// `@tauri-apps/api`・`@tauri-apps/plugin-clipboard-manager` はTauriランタイム無しでは
// 動作しないため、モックに差し替える(T07/T08と同じ方針)。`vi.mock` はホイストされる
// ため、下の `import` より前に評価される。
const invokeMock = vi.fn();
const writeImageMock = vi.fn();
const imageNewMock = vi.fn();
const imageCloseMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeImage: (...args: unknown[]) => writeImageMock(...args),
}));

vi.mock("@tauri-apps/api/image", () => ({
  Image: {
    new: (...args: unknown[]) => imageNewMock(...args),
  },
}));

import {
  ClipboardCopyError,
  IMAGE_HEIGHT_HEADER,
  IMAGE_WIDTH_HEADER,
  WRITE_IMAGE_FALLBACK_COMMAND,
  copyToClipboard,
  type ClipboardImagePayload,
} from "./clipboard";

const samplePayload: ClipboardImagePayload = {
  rgba: new Uint8Array([255, 0, 0, 255]),
  width: 1,
  height: 1,
};

function mockImageInstance() {
  return { close: imageCloseMock.mockResolvedValue(undefined) };
}

describe("copyToClipboard", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    writeImageMock.mockReset();
    imageNewMock.mockReset();
    imageCloseMock.mockReset();
  });

  it("プラグイン経由の書込に成功したら'plugin'を返し、Rustフォールバックは呼ばない", async () => {
    imageNewMock.mockResolvedValue(mockImageInstance());
    writeImageMock.mockResolvedValue(undefined);

    await expect(copyToClipboard(samplePayload)).resolves.toBe("plugin");

    expect(imageNewMock).toHaveBeenCalledWith(
      samplePayload.rgba,
      samplePayload.width,
      samplePayload.height,
    );
    expect(writeImageMock).toHaveBeenCalledTimes(1);
    expect(imageCloseMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("プラグインが失敗したらRustフォールバック(write_image_fallback)へ切り替わり'fallback'を返す", async () => {
    imageNewMock.mockResolvedValue(mockImageInstance());
    writeImageMock.mockRejectedValue(new Error("plugin write failed"));
    invokeMock.mockResolvedValue(undefined);

    await expect(copyToClipboard(samplePayload)).resolves.toBe("fallback");

    expect(invokeMock).toHaveBeenCalledWith(
      WRITE_IMAGE_FALLBACK_COMMAND,
      samplePayload.rgba,
      {
        headers: {
          [IMAGE_WIDTH_HEADER]: String(samplePayload.width),
          [IMAGE_HEIGHT_HEADER]: String(samplePayload.height),
        },
      },
    );
  });

  it("Image.new()自体が失敗した場合もRustフォールバックへ切り替わる", async () => {
    imageNewMock.mockRejectedValue(new Error("Image.new failed"));
    invokeMock.mockResolvedValue(undefined);

    await expect(copyToClipboard(samplePayload)).resolves.toBe("fallback");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("プラグイン・フォールバックの両方が失敗したら両方のエラーを保持するClipboardCopyErrorをrejectする", async () => {
    const pluginError = new Error("plugin write failed");
    const fallbackError = new Error("fallback write failed");
    imageNewMock.mockResolvedValue(mockImageInstance());
    writeImageMock.mockRejectedValue(pluginError);
    invokeMock.mockRejectedValue(fallbackError);

    await expect(copyToClipboard(samplePayload)).rejects.toBeInstanceOf(
      ClipboardCopyError,
    );

    try {
      await copyToClipboard(samplePayload);
      throw new Error("この行には到達しないはず");
    } catch (error) {
      expect(error).toBeInstanceOf(ClipboardCopyError);
      const copyError = error as ClipboardCopyError;
      expect(copyError.pluginError).toBe(pluginError);
      expect(copyError.fallbackError).toBe(fallbackError);
    }
  });
});
