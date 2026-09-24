//! オブジェクト層(T32)の目視確認用スクリーンショット。矢印・矩形・円を描いた後、ツールを外して
//! 矩形だけを選択した状態(他の2つは選択されていない)を撮る。ハンドルはオーバーレイ
//! (`.shape-overlay`)に描かれ、Canvasのピクセルには含まれない(`e2e/object-layer.spec.ts`で検証)。
//!
//! 実行: `npx playwright test --config=e2e/screenshots/playwright.config.ts objectSelect`

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
  id: "object-select-1",
  sourcePath: "/tmp/tadcap-captures/object-select-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

// 細部(ハンドル・線幅)が見えるよう高解像度で撮る(`shapeEdit.visual.ts`と同じ理由)。
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

test("複数オブジェクトのうち矩形だけを選択中", async ({ page }) => {
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
  const canvas = page.locator("#capture-canvas");
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }

  await page.getByRole("button", { name: "矢印" }).click();
  await drag(page, box.x, box.y, [30, 180], [120, 110]);
  await page.getByRole("button", { name: "矩形" }).click();
  await drag(page, box.x, box.y, [140, 30], [270, 100]);
  await page.getByRole("button", { name: "円" }).click();
  await drag(page, box.x, box.y, [30, 20], [120, 90]);
  // ツールを外し、矩形の枠線をクリックして選び直す(描いた直後の円の選択は外れる)。
  await page.getByRole("button", { name: "円" }).click();
  await page.mouse.click(box.x + 141, box.y + 65);

  await page.screenshot({
    path: path.join(OUTPUT_DIR, "object-select.png"),
    clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 },
  });
});
