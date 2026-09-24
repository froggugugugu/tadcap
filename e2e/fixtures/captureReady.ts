//! 「キャプチャ」ボタンを押して画像の反映完了を待つ共通ヘルパー(T30)。
//!
//! # 背景(T29申し送り・T30タスク指示)
//!
//! 既存specの一部は `page.waitForFunction(() => canvas.width > 0 && canvas.height > 0)` で
//! 画像反映を待っていたが、`<canvas>` 要素はHTML仕様上の既定サイズが `300x150` であり、
//! `width`/`height` 属性が一度も設定されていない状態でもこの条件を満たしてしまう
//! (`capture://completed` 受信 → `read_capture_image` → `renderImageToCanvas()` が
//! Canvasへ実際に画像を反映する**前**に `waitForFunction` が解決してしまう競合)。
//!
//! 本ヘルパーは代わりに「コピーボタンが有効になる」(`canvasState.image` セット済み、
//! `ui/clipboardButton.ts::isClipboardCopyEnabled`)と「履歴に指定件数が追加される」
//! (`main.ts::handleCaptureCompleted` の末尾、`addHistoryItem` 呼び出し後)の両方を待つ。
//! 履歴への追加は画像反映(`renderImageToCanvas`)・Undo/Redoクリア・履歴保存用画像抽出
//! (`captureHistoryAssets`)がすべて完了した**後**にしか起きないため、この2条件が揃った
//! 時点で画像反映は確実に完了している(`tool-settings.spec.ts`/`undo-redo.spec.ts`が
//! 先行して使っていたパターンを共通化したもの)。
//!
//! 2回目以降のキャプチャ(新規キャプチャで履歴が増えるケース)でも、`expectedHistoryCount`
//! に増加後の件数を渡せばそのまま使える(コピーボタンは1回目のキャプチャ以降ずっと
//! 有効なままのため、単独では2回目以降の完了を示す条件にならない。履歴件数の一致条件と
//! 組み合わせて初めて確実になる)。

import { expect, type Locator, type Page } from "@playwright/test";

/**
 * 「キャプチャ」ボタンをクリックし、画像の反映完了(コピーボタン有効化 + 履歴件数一致)を
 * 待ったうえで `#capture-canvas` の `Locator` を返す。
 *
 * @param expectedHistoryCount 待機後に期待する履歴件数(既定1)。2回目以降のキャプチャで
 *   履歴が積み上がるケースでは、呼び出し側が現在件数+1を渡す。
 */
export async function captureAndWaitReady(
  page: Page,
  expectedHistoryCount = 1,
): Promise<Locator> {
  await page.getByRole("button", { name: "キャプチャ" }).click();
  await expect(
    page.getByRole("button", { name: "クリップボードにコピー" }),
  ).toBeEnabled();
  await expect(page.locator("#history-sidebar li")).toHaveCount(
    expectedHistoryCount,
  );
  return page.locator("#capture-canvas");
}
