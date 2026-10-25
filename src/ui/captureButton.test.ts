import { describe, expect, it } from "vitest";

import { captureErrorMessage } from "./captureButton";

describe("captureErrorMessage", () => {
  it("permission_deniedのときは権限案内文言を返す(専用の案内UIはT08で実装)", () => {
    expect(captureErrorMessage("permission_denied")).toBe(
      "画面収録の権限が必要です。",
    );
  });

  // SHOULD(レビュー 2026-10-26): Rust 側の生の文字列(`AppError::Internal` の中身)は画面に出さない。原因調査用の
  // 詳細は呼び出し側(`captureButton.ts`・`main.ts`)の `console.error` に残す。トレイ・ショートカット起点の
  // `capture://error` も同じ関数を通す。
  it("その他の文字列エラーは生の文字列を出さず汎用メッセージを返す", () => {
    expect(captureErrorMessage("boom")).toBe("キャプチャに失敗しました。");
    expect(captureErrorMessage("screencapture exited with status 1")).toBe("キャプチャに失敗しました。");
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
