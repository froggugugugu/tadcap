//! E2E テスト: 画像が無いときのツール(レビュー 2026-10-26 SHOULD、UI_quick-edits §1・§2.1・§4.2)。
//!
//! 起動直後・履歴の最後の 1 件の削除・すべて削除で画像が無くなったとき、ツールボタンは押せず(`disabled`、
//! 1 キー切替も効かない)、選択中のツールは外れ、トリミングの帯・スタンプの種類は出ない。判定そのもの
//! (`toolButtonState`・`withoutImage`・`cropBarView`)はユニットテストが受け持ち、ここでは DOM の結線を確かめる。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import { installTauriMocks, routeCrossOriginAssets, type MockCaptureResult } from "./fixtures/tauriMock";

function captureResult(n: number): MockCaptureResult {
  return {
    id: `e2e-empty-${n}`,
    sourcePath: `/tmp/tadcap-captures/e2e-empty-${n}.png`,
    kind: "range",
    createdAt: `2024-01-01T00:00:0${n}.000Z`,
  };
}

/** UI_quick-edits §1.3 の名前(ツールバーの並び)。 */
const TOOL_NAMES = ["矢印(A)", "矩形(R)", "円(O)", "テキスト(T)", "スタンプ(N)", "モザイク(M)", "スポットライト(S)", "トリミング(C)"];

function toolButton(page: Page, name: string): Locator {
  return page.getByRole("button", { name, exact: true });
}

function pressedTools(page: Page): Locator {
  return page.locator(".tool-toolbar__button[aria-pressed='true']");
}

function kindPicker(page: Page): Locator {
  return page.getByRole("group", { name: "スタンプの種類" });
}

async function expectAllToolsDisabled(page: Page): Promise<void> {
  for (const name of TOOL_NAMES) {
    await expect(toolButton(page, name)).toBeDisabled();
  }
}

async function expectAllToolsEnabled(page: Page): Promise<void> {
  for (const name of TOOL_NAMES) {
    await expect(toolButton(page, name)).toBeEnabled();
  }
}

test.describe("画像が無いときのツール", () => {
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
      capture: { kind: "success", result: captureResult(9) },
      captureImageBase64: fixturePng.toString("base64"),
      captureResults: [captureResult(1), captureResult(2), captureResult(3)],
    });
    await page.goto("/");
  });

  test("起動直後(画像なし)はツールボタンがすべて disabled で、キーでも選べず、帯とスタンプの種類は出ない", async ({ page }) => {
    await expect(page.locator("#tool-toolbar .tool-toolbar__button")).toHaveCount(TOOL_NAMES.length);
    await expectAllToolsDisabled(page);
    await page.keyboard.press("c");
    await page.keyboard.press("n");
    await expect(pressedTools(page)).toHaveCount(0);
    await expect(page.locator("#crop-bar")).toBeHidden();
    await expect(kindPicker(page)).toBeHidden();

    // 画像を入れると押せる(ツールはまだ選ばれていない)。
    await captureAndWaitReady(page);
    await expectAllToolsEnabled(page);
    await expect(pressedTools(page)).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("画像を 1 つ入れて削除すると、選択中のトリミングが外れて帯と範囲が消え、ボタンは押せなくなる", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    const crop = toolButton(page, "トリミング(C)");
    await crop.click();
    await expect(crop).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#crop-bar")).toBeVisible();
    const box = await canvas.boundingBox();
    if (!box) {
      throw new Error("#capture-canvas is not visible");
    }
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator("canvas.crop-overlay")).toBeVisible();

    const item = page.locator(".history-sidebar__item").first();
    await item.hover();
    await item.getByRole("button", { name: "この履歴を削除" }).click();

    await expect(page.locator("#empty-state")).toBeVisible();
    await expect(crop).toHaveAttribute("aria-pressed", "false");
    await expect(pressedTools(page)).toHaveCount(0);
    await expect(page.locator("#crop-bar")).toBeHidden();
    await expect(page.locator("canvas.crop-overlay")).toBeHidden();
    await expectAllToolsDisabled(page);
    expect(pageErrors).toEqual([]);
  });

  test("履歴をすべて削除するとスタンプの種類も消え、次にキャプチャしてもツールは選ばれていない", async ({ page }) => {
    await captureAndWaitReady(page, 1);
    await captureAndWaitReady(page, 2);
    await page.keyboard.press("n");
    await expect(toolButton(page, "スタンプ(N)")).toHaveAttribute("aria-pressed", "true");
    await expect(kindPicker(page)).toBeVisible();

    await page.getByRole("button", { name: "履歴をすべて削除" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "削除" }).click();

    await expect(page.locator("#empty-state")).toBeVisible();
    await expect(kindPicker(page)).toBeHidden();
    await expect(pressedTools(page)).toHaveCount(0);
    await expectAllToolsDisabled(page);

    // 空状態から再びキャプチャすると押せるが、前に選んでいたツールは戻らない。
    await captureAndWaitReady(page, 1);
    await expectAllToolsEnabled(page);
    await expect(pressedTools(page)).toHaveCount(0);
    await expect(kindPicker(page)).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
});
