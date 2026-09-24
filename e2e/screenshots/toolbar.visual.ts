//! ツールバー全体の目視確認用スクリーンショット(T28: 色・フォントサイズ選択UIを追加した後の
//! 過密具合・グループ分けの確認)。ウィンドウ既定幅(800px、`tauri.conf.json`)で撮る。
//! 実行: `npx playwright test --config=e2e/screenshots/playwright.config.ts toolbar`。

import { mkdirSync } from "node:fs";
import path from "node:path";

import { test } from "@playwright/test";

import { createFixtureCapturePng } from "../fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "../fixtures/tauriMock";

const OUTPUT_DIR = path.join(process.cwd(), "output/reports/ui");

test.use({ deviceScaleFactor: 2, viewport: { width: 800, height: 600 } });

test.beforeAll(() => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
});

test("ツールバー全体(800px幅、色・文字サイズ選択後)", async ({ page }) => {
  const fixturePng = createFixtureCapturePng();
  await routeCrossOriginAssets(page, fixturePng);
  const sampleCaptureResult: MockCaptureResult = {
    id: "toolbar-t28",
    sourcePath: "/tmp/tadcap-captures/toolbar-t28.png",
    kind: "range",
    createdAt: "2024-01-01T00:00:00.000Z",
  };
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: { kind: "success", result: sampleCaptureResult },
    captureImageBase64: fixturePng.toString("base64"),
  });
  await page.goto("/");
  await page.getByRole("button", { name: "キャプチャ" }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector<HTMLCanvasElement>("#capture-canvas");
    return !!el && el.width > 0 && el.height > 0;
  });
  await page.locator(".toolbar").screenshot({ path: path.join(OUTPUT_DIR, "toolbar-t28.png") });

  // 選択状態の見え方(青・文字サイズ大・矩形ツール)。
  await page.getByRole("button", { name: "矩形" }).click();
  await page.getByRole("button", { name: "青" }).click();
  await page.getByRole("button", { name: "文字サイズ 大" }).click();
  await page.mouse.move(0, 300);
  await page.locator(".toolbar").screenshot({ path: path.join(OUTPUT_DIR, "toolbar-t28-selected.png") });
});
