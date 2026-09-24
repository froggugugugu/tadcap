//! UIスクリーンショット撮影(T19、UI再設計のBefore/After証跡)。
//!
//! `npm run e2e`(ルートの `playwright.config.ts`)の既定 `testMatch` はファイル名に
//! `.spec.`/`.test.` を含むファイルのみを対象にするため、本ファイル(`.visual.ts`)は
//! 対象外になり通常のE2E実行を遅くしない。撮影専用の
//! `e2e/screenshots/playwright.config.ts`(`npm run e2e:screenshots:before` /
//! `npm run e2e:screenshots:after`)でのみ実行する。
//!
//! `e2e/capture-flow.spec.ts` と同じIPCモック(`../fixtures/tauriMock.ts` /
//! `../fixtures/sampleCapturePng.ts`)を使い、OSネイティブ導線には触れない。
//! 3状態(空状態 / 画像表示+矢印・モザイク適用後+履歴あり / 権限バナー表示)を
//! `output/reports/ui/<UI_SCREENSHOT_LABEL>/` にPNGで保存する
//! (`UI_SCREENSHOT_LABEL` 環境変数、既定 `"after"`)。

import { mkdirSync } from "node:fs";
import path from "node:path";

import { test, type Page } from "@playwright/test";

import { createFixtureCapturePng } from "../fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "../fixtures/tauriMock";

const LABEL = process.env.UI_SCREENSHOT_LABEL ?? "after";
const OUTPUT_DIR = path.join(process.cwd(), "output/reports/ui", LABEL);

const sampleCaptureResult: MockCaptureResult = {
  id: "ui-screenshot-1",
  sourcePath: "/tmp/tadcap-captures/ui-screenshot-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUTPUT_DIR, `${name}.png`) });
}

/** キャンバスのビューポート座標での矩形をドラッグする(`capture-flow.spec.ts`と同じ手順)。 */
async function dragOnCanvas(
  page: Page,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  const canvas = page.locator("#capture-canvas");
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
}

test.beforeAll(() => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
});

test.describe("UIスクリーンショット(T19 Before/After証跡)", () => {
  const fixturePng = createFixtureCapturePng();
  const captureImageBase64 = fixturePng.toString("base64");

  test.beforeEach(async ({ page }) => {
    // 画像は `read_capture_image` モックで渡す。asset URL は実機と同じく別オリジン
    // (`tauriMock.ts`「画像の配信経路」参照)。
    await routeCrossOriginAssets(page, fixturePng);
  });

  test("状態1: 空状態", async ({ page }) => {
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: sampleCaptureResult },
      captureImageBase64,
    });
    await page.goto("/");
    await shoot(page, "01-empty");
  });

  test("状態2: 画像表示 + 矢印・モザイク適用後 + 履歴あり", async ({ page }) => {
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: sampleCaptureResult },
      captureImageBase64,
    });
    await page.goto("/");

    await page.getByRole("button", { name: "キャプチャ" }).click();
    await page.waitForFunction(() => {
      const el = document.querySelector<HTMLCanvasElement>("#capture-canvas");
      return !!el && el.width > 0 && el.height > 0;
    });

    await page.getByRole("button", { name: "矢印" }).click();
    await dragOnCanvas(page, [30, 150], [250, 150]);

    await page.getByRole("button", { name: "モザイク" }).click();
    await dragOnCanvas(page, [60, 20], [140, 100]);

    await shoot(page, "02-canvas-history");
  });

  test("状態3: 権限バナー表示", async ({ page }) => {
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "permissionDenied" },
      captureImageBase64,
    });
    await page.goto("/");

    await page.getByRole("button", { name: "キャプチャ" }).click();
    await page.locator(".permission-banner").waitFor({ state: "visible" });

    await shoot(page, "03-permission-banner");
  });
});
