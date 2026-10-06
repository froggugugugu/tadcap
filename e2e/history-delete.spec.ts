//! E2Eテスト: 履歴の削除(サムネイルの×・すべて削除)と、履歴が増えても一覧だけがスクロールする
//! レイアウト(v0.2.2後の人間フィードバック)。
//!
//! 他のspecと同じく、Tauriランタイムは起動せず `e2e/fixtures/tauriMock.ts` でIPCをモックする。
//! 各回のキャプチャは別のidにする(`captureResults`)。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import { installTauriMocks, routeCrossOriginAssets, type MockCaptureResult } from "./fixtures/tauriMock";

function captureResult(n: number): MockCaptureResult {
  return {
    id: `e2e-history-${n}`,
    sourcePath: "/tmp/tadcap-captures/e2e-history.png",
    kind: "range",
    createdAt: `2024-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
  };
}

const captureResults = Array.from({ length: 12 }, (_, i) => captureResult(i + 1));

/** 履歴の`li`(新しいものが先頭)。 */
function historyItems(page: Page): Locator {
  return page.locator(".history-sidebar__item");
}

/** 選択中の項目のaria-label(`履歴 <createdAt>`)。 */
async function selectedLabel(page: Page): Promise<string | null> {
  return page.locator(".history-sidebar__item--selected .history-sidebar__thumbnail-button").getAttribute("aria-label");
}

/** n番目(0始まり)の項目にホバーして右上の×を押す。 */
async function deleteItem(page: Page, index: number): Promise<void> {
  const item = historyItems(page).nth(index);
  await item.hover();
  const button = item.getByRole("button", { name: "この履歴を削除" });
  await expect(button).toHaveCSS("opacity", "1");
  await button.click();
}

test.describe("履歴の削除と一覧のスクロール(v0.2.2後)", () => {
  const fixturePng = createFixtureCapturePng();
  let pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    await routeCrossOriginAssets(page, fixturePng);
    pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        pageErrors.push(msg.text());
      }
    });
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: captureResult(99) },
      captureImageBase64: fixturePng.toString("base64"),
      captureResults,
    });
    await page.goto("/");
  });

  async function captureTimes(page: Page, count: number): Promise<void> {
    for (let i = 1; i <= count; i += 1) {
      await captureAndWaitReady(page, i);
    }
  }

  test("×はホバーしたときだけ出て、押すとその履歴だけが消える。表示中を消すと隣を表示し、最後の1件で空状態に戻る", async ({
    page,
  }) => {
    await captureTimes(page, 3); // 一覧: [3, 2, 1]、3を表示中
    const firstDelete = historyItems(page).nth(1).getByRole("button", { name: "この履歴を削除" });
    await expect(firstDelete).toHaveCSS("opacity", "0");

    // 表示中でない項目(2)を消す: 表示は3のまま。
    await deleteItem(page, 1);
    await expect(historyItems(page)).toHaveCount(2);
    expect(await selectedLabel(page)).toBe(`履歴 ${captureResult(3).createdAt}`);

    // 表示中の項目(3)を消す: 隣(1)を選択して表示する。
    await deleteItem(page, 0);
    await expect(historyItems(page)).toHaveCount(1);
    expect(await selectedLabel(page)).toBe(`履歴 ${captureResult(1).createdAt}`);
    await expect(page.getByRole("button", { name: "クリップボードにコピー" })).toBeEnabled();
    await expect(page.locator("#empty-state")).toBeHidden();

    // 最後の1件を消す: 空状態に戻り、コピーとすべて削除は押せない。
    await deleteItem(page, 0);
    await expect(historyItems(page)).toHaveCount(0);
    await expect(page.locator("#empty-state")).toBeVisible();
    await expect(page.getByRole("button", { name: "クリップボードにコピー" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "履歴をすべて削除" })).toBeDisabled();
    expect(await page.locator("#capture-canvas").evaluate((el: HTMLCanvasElement) => el.width)).toBe(0);

    // 空状態から再びキャプチャできる。
    await captureAndWaitReady(page, 1);
    expect(pageErrors).toEqual([]);
  });

  test("すべて削除は確認ダイアログを出し、キャンセルなら何もせず、削除なら全件消して空状態に戻る", async ({ page }) => {
    await captureTimes(page, 2);
    const clearAll = page.getByRole("button", { name: "履歴をすべて削除" });
    const dialog = page.getByRole("dialog");

    await clearAll.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("履歴を2件すべて削除します。元に戻せません。");
    await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeFocused();
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog).toBeHidden();
    await expect(historyItems(page)).toHaveCount(2);

    // Escでも閉じるだけ。
    await clearAll.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(historyItems(page)).toHaveCount(2);

    await clearAll.click();
    await dialog.getByRole("button", { name: "削除" }).click();
    await expect(dialog).toBeHidden();
    await expect(historyItems(page)).toHaveCount(0);
    await expect(page.locator("#empty-state")).toBeVisible();
    await expect(page.getByRole("button", { name: "クリップボードにコピー" })).toBeDisabled();
    expect(pageErrors).toEqual([]);
  });

  test("表示中を消した後に隣の履歴を読み込めなければ、エディタを空にして未選択にし、選び直せば表示できる", async ({
    page,
  }) => {
    await captureTimes(page, 2); // 1は2のキャプチャ時に退避済み
    // 退避からの復元(createImageBitmap)を失敗させる。
    await page.evaluate(() => {
      const w = window as unknown as { __origCreateImageBitmap?: typeof createImageBitmap };
      w.__origCreateImageBitmap = window.createImageBitmap;
      window.createImageBitmap = () => Promise.reject(new Error("e2e: 読込失敗"));
    });

    await deleteItem(page, 0);

    await expect(historyItems(page)).toHaveCount(1);
    await expect(page.locator(".history-sidebar__item--selected")).toHaveCount(0);
    await expect(page.locator("#empty-state")).toBeVisible();
    await expect(page.getByRole("button", { name: "クリップボードにコピー" })).toBeDisabled();
    await expect(page.locator("#capture-status")).toHaveText("履歴画像を読み込めませんでした。履歴から選び直してください。");

    await page.evaluate(() => {
      const w = window as unknown as { __origCreateImageBitmap?: typeof createImageBitmap };
      window.createImageBitmap = w.__origCreateImageBitmap!;
    });
    await historyItems(page).nth(0).locator(".history-sidebar__thumbnail-button").click();
    await expect(page.locator(".history-sidebar__item--selected")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "クリップボードにコピー" })).toBeEnabled();
    await expect(page.locator("#empty-state")).toBeHidden();
  });

  test("履歴が増えてもウィンドウ全体はスクロールせず、履歴の一覧だけがスクロールする", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await captureAndWaitReady(page, 1);
    const canvasBox = await page.locator("#capture-canvas").boundingBox();

    for (let i = 2; i <= 12; i += 1) {
      await captureAndWaitReady(page, i);
    }

    const page_ = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));
    expect(page_.scrollHeight).toBeLessThanOrEqual(page_.clientHeight);

    const list = await page.locator(".history-sidebar__list").evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(list.overflowY).toBe("auto");
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);

    // エディタのキャプチャ画像は1件目のときと同じ位置・大きさのまま(下へずれない)。
    expect(await page.locator("#capture-canvas").boundingBox()).toEqual(canvasBox);
    // すべて削除ボタンは一覧と一緒にスクロールしない。
    await page.locator(".history-sidebar__list").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(page.getByRole("button", { name: "履歴をすべて削除" })).toBeInViewport();
    expect(pageErrors).toEqual([]);
  });
});
