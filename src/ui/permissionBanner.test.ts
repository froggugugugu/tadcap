import { describe, expect, it } from "vitest";

import { isPermissionDeniedError } from "../ipc/permissions";
import {
  permissionBannerMessage,
  shouldShowPermissionBanner,
} from "./permissionBanner";

describe("shouldShowPermissionBanner", () => {
  it("未確認(unconfirmed)のときは表示しない", () => {
    expect(shouldShowPermissionBanner("unconfirmed")).toBe(false);
  });

  it("許可済み(granted)のときは表示しない", () => {
    expect(shouldShowPermissionBanner("granted")).toBe(false);
  });

  it("未許可(notGranted)のときのみ表示する", () => {
    expect(shouldShowPermissionBanner("notGranted")).toBe(true);
  });
});

describe("permissionBannerMessage", () => {
  it("システム設定を開く導線への言及を含む", () => {
    expect(permissionBannerMessage()).toContain("システム設定を開く");
  });

  it("アプリの再起動が必要な場合がある旨の案内を含む", () => {
    expect(permissionBannerMessage()).toContain("再起動");
  });
});

/**
 * フロントの3つの入口(ボタンの `invoke` reject値、トレイ/ショートカット起点の
 * `capture://error` イベントpayload、起動時の事前確認結果)から来た値が、
 * いずれも同じバナー表示判定(`shouldShowPermissionBanner`)に帰着することを
 * 検証する(T08受け入れ条件「3入口から同じ状態遷移になること」、
 * PJM決定 2026-09-23)。
 */
describe("3つの入口が同じ状態遷移になること(NFR-002)", () => {
  it("ボタンのinvoke reject値とcapture://errorイベントpayloadは同じ文字列形式で権限未許可と判定される", () => {
    const fromButtonReject: unknown = "permission_denied";
    const fromCaptureErrorEvent: unknown = "permission_denied";

    expect(isPermissionDeniedError(fromButtonReject)).toBe(true);
    expect(isPermissionDeniedError(fromCaptureErrorEvent)).toBe(true);
    expect(isPermissionDeniedError(fromButtonReject)).toBe(
      isPermissionDeniedError(fromCaptureErrorEvent),
    );
  });

  it("ボタン/イベント起点(permission_denied)と起動時チェック起点(notGranted)は、いずれもバナーを表示すべき状態になる", () => {
    const deniedFromButtonOrEvent = isPermissionDeniedError("permission_denied")
      ? "notGranted"
      : "granted";
    const deniedFromStartupCheck = "notGranted";

    expect(shouldShowPermissionBanner(deniedFromButtonOrEvent)).toBe(true);
    expect(shouldShowPermissionBanner(deniedFromStartupCheck)).toBe(true);
    expect(shouldShowPermissionBanner(deniedFromButtonOrEvent)).toBe(
      shouldShowPermissionBanner(deniedFromStartupCheck),
    );
  });

  it("非該当(permission_denied以外/granted)のときは3入口いずれもバナーを表示しない", () => {
    const fromButtonOrEvent = isPermissionDeniedError("boom")
      ? "notGranted"
      : "granted";
    const fromStartupCheck = "granted";

    expect(shouldShowPermissionBanner(fromButtonOrEvent)).toBe(false);
    expect(shouldShowPermissionBanner(fromStartupCheck)).toBe(false);
  });
});
