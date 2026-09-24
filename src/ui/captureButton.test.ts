import { describe, expect, it } from "vitest";

import { captureErrorMessage } from "./captureButton";

describe("captureErrorMessage", () => {
  it("permission_deniedのときは権限案内文言を返す(専用の案内UIはT08で実装)", () => {
    expect(captureErrorMessage("permission_denied")).toBe(
      "画面収録の権限が必要です。",
    );
  });

  it("その他の文字列エラーはメッセージ本文を含める", () => {
    expect(captureErrorMessage("boom")).toBe("キャプチャに失敗しました: boom");
  });

  it("文字列以外のエラーは汎用メッセージを返す", () => {
    expect(captureErrorMessage(new Error("boom"))).toBe(
      "キャプチャに失敗しました。",
    );
  });

  it("undefinedでも汎用メッセージを返す", () => {
    expect(captureErrorMessage(undefined)).toBe("キャプチャに失敗しました。");
  });
});
