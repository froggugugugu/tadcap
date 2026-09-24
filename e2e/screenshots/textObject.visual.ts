//! テキストのオブジェクト化(T33)の目視確認用スクリーンショット。矩形・矢印を描いた後にテキストを
//! 置き、ツールを外してテキストをクリックで選び直した状態(行ボックスの選択枠、ハンドル無し)を撮る。
//!
//! 実行: `npx playwright test --config=e2e/screenshots/playwright.config.ts textObject`

import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { createFixtureCapturePng } from "../fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "../fixtures/tauriMock";

const OUTPUT_DIR = path.join(process.cwd(), "output/reports/ui");

const sampleCaptureResult: MockCaptureResult = {
  id: "text-object-1",
  sourcePath: "/tmp/tadcap-captures/text-object-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

// 細部(選択枠・文字の影)が見えるよう高解像度で撮る(`shapeEdit.visual.ts`と同じ理由)。
test.use({ deviceScaleFactor: 3 });

test.beforeAll(() => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
});

async function drag(page: Page, x: number, y: number, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(x + from[0], y + from[1]);
  await page.mouse.down();
  await page.mouse.move(x + to[0], y + to[1], { steps: 8 });
  await page.mouse.up();
}

test("複数オブジェクトのうちテキストを選択中", async ({ page }) => {
  const fixturePng = createFixtureCapturePng();
  await routeCrossOriginAssets(page, fixturePng);
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: { kind: "success", result: sampleCaptureResult },
    captureImageBase64: fixturePng.toString("base64"),
  });
  await page.goto("/");

  await page.getByRole("button", { name: "キャプチャ" }).click();
  await expect(page.locator("#history-sidebar li")).toHaveCount(1);
  const box = await page.locator("#capture-canvas").boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }

  await page.getByRole("button", { name: "矩形" }).click();
  await drag(page, box.x, box.y, [150, 30], [280, 110]);
  await page.getByRole("button", { name: "矢印" }).click();
  await drag(page, box.x, box.y, [40, 180], [140, 120]);
  await page.getByRole("button", { name: "テキスト" }).click();
  await page.mouse.click(box.x + 30, box.y + 60);
  await page.keyboard.type("Check here");
  await page.keyboard.press("Enter");
  // ツールを外して選択解除し、テキストをクリックで選び直す。
  await page.getByRole("button", { name: "テキスト" }).click();
  await page.mouse.click(box.x + 60, box.y + 60);

  await page.screenshot({
    path: path.join(OUTPUT_DIR, "text-object.png"),
    clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 },
  });
});
