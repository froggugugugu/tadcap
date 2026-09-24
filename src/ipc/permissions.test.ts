import { beforeEach, describe, expect, it, vi } from "vitest";

// `@tauri-apps/api` はTauriランタイム無しでは動作しないため、モックに差し替える
// (T07/T08仕様: 「@tauri-apps/api はモック」)。`vi.mock` はホイストされるため、
// 下の `import` より前に評価される。
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  checkScreenRecordingPermission,
  isPermissionDeniedError,
  openScreenRecordingSettings,
} from "./permissions";

describe("checkScreenRecordingPermission", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("check_screen_recording_permissionコマンドを引数なしで呼び出す", async () => {
    invokeMock.mockResolvedValue("granted");

    await checkScreenRecordingPermission();

    expect(invokeMock).toHaveBeenCalledWith("check_screen_recording_permission");
  });

  it("Rustからgrantedが返れば、そのままgrantedを返す", async () => {
    invokeMock.mockResolvedValue("granted");

    await expect(checkScreenRecordingPermission()).resolves.toBe("granted");
  });

  it("RustからnotGrantedが返れば、そのままnotGrantedを返す", async () => {
    invokeMock.mockResolvedValue("notGranted");

    await expect(checkScreenRecordingPermission()).resolves.toBe("notGranted");
  });
});

describe("openScreenRecordingSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("open_screen_recording_settingsコマンドを引数なしで呼び出す(URLはフロントから渡さない)", async () => {
    invokeMock.mockResolvedValue(undefined);

    await openScreenRecordingSettings();

    expect(invokeMock).toHaveBeenCalledWith("open_screen_recording_settings");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe("isPermissionDeniedError", () => {
  it("permission_denied文字列はtrueを返す(ボタンのinvoke reject値の形式)", () => {
    expect(isPermissionDeniedError("permission_denied")).toBe(true);
  });

  it("permission_denied文字列はtrueを返す(capture://errorイベントpayloadの形式でも同じ文字列)", () => {
    // Rust側は同一の AppError::PermissionDenied を両経路で文字列化するため、
    // 入力の見た目は同じ文字列になる(T15/T08の前提)。
    const fromEventPayload: unknown = "permission_denied";
    expect(isPermissionDeniedError(fromEventPayload)).toBe(true);
  });

  it("その他の文字列エラーはfalseを返す", () => {
    expect(isPermissionDeniedError("boom")).toBe(false);
  });

  it("文字列以外はfalseを返す", () => {
    expect(isPermissionDeniedError(undefined)).toBe(false);
    expect(isPermissionDeniedError(new Error("boom"))).toBe(false);
    expect(isPermissionDeniedError(null)).toBe(false);
  });
});
