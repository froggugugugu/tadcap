//! 選択中のオブジェクトの操作(T34)の目視確認用スクリーンショット。矩形・矢印を描いて矩形を選択し、
//! ツールバーの「最前面へ」「最背面へ」が有効になった状態を、ツールバーを含めて撮る。
//!
//! 実行: `npx playwright test --config=e2e/screenshots/playwright.config.ts objectOps`

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
  id: "object-ops-1",
  sourcePath: "/tmp/tadcap-captures/object-ops-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

test.use({ deviceScaleFactor: 2, viewport: { width: 900, height: 420 } });

test.beforeAll(() => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
});

async function drag(page: Page, x: number, y: number, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(x + from[0], y + from[1]);
  await page.mouse.down();
  await page.mouse.move(x + to[0], y + to[1], { steps: 8 });
  await page.mouse.up();
}

test("選択中はツールバーの最前面へ・最背面へが有効", async ({ page }) => {
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

  await page.getByRole("button", { name: "矢印" }).click();
  await drag(page, box.x, box.y, [30, 170], [200, 80]);
  await page.getByRole("button", { name: "矩形" }).click();
  await drag(page, box.x, box.y, [120, 40], [270, 140]);
  await expect(page.getByRole("button", { name: "最前面へ" })).toBeEnabled();

  await page.screenshot({ path: path.join(OUTPUT_DIR, "object-ops.png") });
});
