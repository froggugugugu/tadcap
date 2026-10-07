import { beforeEach, describe, expect, it, vi } from "vitest";

// `@tauri-apps/api` はTauriランタイム無しでは動作しないため、モックに差し替える(他のipcテストと同じ)。
const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  DEFAULT_CAPTURE_ACCELERATOR,
  SETTINGS_OPEN_EVENT,
  getCaptureShortcut,
  onSettingsOpen,
  resetCaptureShortcut,
  setCaptureShortcut,
  setShortcutRecording,
} from "./settings";

const info = { accelerator: "alt+super+KeyK", isDefault: false, registered: true };

describe("キャプチャのショートカットのコマンド", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  it("getCaptureShortcutはget_capture_shortcutを呼び、結果をそのまま返す", async () => {
    invokeMock.mockResolvedValue(info);

    await expect(getCaptureShortcut()).resolves.toEqual(info);
    expect(invokeMock).toHaveBeenCalledWith("get_capture_shortcut");
  });

  it("結果がnull(コマンドの無い環境)なら既定キー・登録済みとして扱う", async () => {
    invokeMock.mockResolvedValue(null);

    await expect(getCaptureShortcut()).resolves.toEqual({
      accelerator: DEFAULT_CAPTURE_ACCELERATOR,
      isDefault: true,
      registered: true,
    });
  });

  it("setCaptureShortcutはacceleratorを渡してset_capture_shortcutを呼ぶ", async () => {
    invokeMock.mockResolvedValue(info);

    await expect(setCaptureShortcut("alt+super+KeyK")).resolves.toEqual(info);
    expect(invokeMock).toHaveBeenCalledWith("set_capture_shortcut", { accelerator: "alt+super+KeyK" });
  });

  it("setCaptureShortcutの失敗は固定文字列のままrejectする", async () => {
    invokeMock.mockRejectedValue("shortcut_register_failed");

    await expect(setCaptureShortcut("alt+super+KeyK")).rejects.toBe("shortcut_register_failed");
  });

  it("resetCaptureShortcutはreset_capture_shortcutを呼ぶ", async () => {
    invokeMock.mockResolvedValue({ accelerator: DEFAULT_CAPTURE_ACCELERATOR, isDefault: true, registered: true });

    await resetCaptureShortcut();
    expect(invokeMock).toHaveBeenCalledWith("reset_capture_shortcut");
  });

  it("setShortcutRecordingは記録中かどうかを渡す", async () => {
    invokeMock.mockResolvedValue(null);

    await setShortcutRecording(true);
    expect(invokeMock).toHaveBeenCalledWith("set_shortcut_recording", { recording: true });
  });

  it("onSettingsOpenはsettings://openを購読し、届いたらハンドラを呼ぶ", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const handler = vi.fn();

    await expect(onSettingsOpen(handler)).resolves.toBe(unlisten);
    expect(listenMock).toHaveBeenCalledWith(SETTINGS_OPEN_EVENT, expect.any(Function));
    const callback = listenMock.mock.calls[0]![1] as () => void;
    callback();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
