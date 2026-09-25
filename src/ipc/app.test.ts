import { beforeEach, describe, expect, it, vi } from "vitest";

// `@tauri-apps/api` はTauriランタイム無しでは動作しないため、モックに差し替える。
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { ACTIVATE_APP_COMMAND, ACTIVATION_RETRY_DELAY_MS, requestAppActivation } from "./app";

describe("requestAppActivation", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
  });

  it("activate_appをすぐに1回呼び、短い遅延のあとにもう1回だけ呼ぶ", () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    requestAppActivation((fn, ms) => scheduled.push({ fn, ms }));

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(ACTIVATE_APP_COMMAND);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(ACTIVATION_RETRY_DELAY_MS);

    scheduled[0].fn();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    // 再試行は1回だけ(再試行がさらに予約されない)。
    expect(scheduled).toHaveLength(1);
  });

  it("コマンド名はRust側(commands::activate_app)と一致する", () => {
    expect(ACTIVATE_APP_COMMAND).toBe("activate_app");
  });

  it("再試行の遅延は短い(入力の開始を待たせない範囲、0より大きく500ms以下)", () => {
    expect(ACTIVATION_RETRY_DELAY_MS).toBeGreaterThan(0);
    expect(ACTIVATION_RETRY_DELAY_MS).toBeLessThanOrEqual(500);
  });

  it("コマンドが失敗しても例外を投げず、console.errorも出さない(入力は続けられる)", async () => {
    invokeMock.mockRejectedValue("boom");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => requestAppActivation(() => {})).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
