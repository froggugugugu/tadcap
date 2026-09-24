//! テキストツール(T27)の小・中・大の目視確認用スクリーンショット。典型的なスクリーンショット
//! (2000x1000)に矢印を1本描き、その横に小・中・大の3サイズを書いて、矢印の太さと並べて違和感が
//! ないか・影で背景に埋もれないかを確認する。あわせて、入力欄を開いたままの状態と確定後の状態を
//! 撮り、入力欄の文字の位置・大きさが焼き込み結果と一致するかを確認する。
//!
//! フォントサイズはツールバーの「文字サイズ 小/中/大」ボタン(T28)をクリックして切り替える。
//! 実行: `npx playwright test --config=e2e/screenshots/playwright.config.ts textSizes`。

import { mkdirSync } from "node:fs";
import path from "node:path";

import { test, type Page } from "@playwright/test";

import { createFixtureCapturePng } from "../fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "../fixtures/tauriMock";

const OUTPUT_DIR = path.join(process.cwd(), "output/reports/ui");

test.use({ deviceScaleFactor: 2 });

test.beforeAll(() => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
});

const FONT_SIZE_BUTTON_LABEL = { small: "文字サイズ 小", medium: "文字サイズ 中", large: "文字サイズ 大" } as const;

async function setFontSize(page: Page, size: "small" | "medium" | "large"): Promise<void> {
  await page.getByRole("button", { name: FONT_SIZE_BUTTON_LABEL[size] }).click();
}

test("テキスト小・中・大(2000x1000)を矢印と並べて目視確認", async ({ page }) => {
  const fixturePng = createFixtureCapturePng(2000, 1000);
  await routeCrossOriginAssets(page, fixturePng);
  const sampleCaptureResult: MockCaptureResult = {
    id: "text-sizes-2000x1000",
    sourcePath: "/tmp/tadcap-captures/text-sizes-2000x1000.png",
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

  const canvas = page.locator("#capture-canvas");
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  const at = (fx: number, fy: number): [number, number] => [box.x + box.width * fx, box.y + box.height * fy];

  // 比較用の矢印(左下→右上)。
  await page.getByRole("button", { name: "矢印" }).click();
  await page.mouse.move(...at(0.06, 0.85));
  await page.mouse.down();
  await page.mouse.move(...at(0.3, 0.3), { steps: 8 });
  await page.mouse.up();

  await page.getByRole("button", { name: "テキスト" }).click();
  const rows: Array<{ size: "small" | "medium" | "large"; y: number; text: string }> = [
    { size: "small", y: 0.2, text: "小 Small テキスト" },
    { size: "medium", y: 0.45, text: "中 Medium テキスト" },
    { size: "large", y: 0.75, text: "大 Large テキスト" },
  ];
  for (const row of rows) {
    await setFontSize(page, row.size);
    await page.mouse.click(...at(0.36, row.y));
    await page.keyboard.insertText(row.text);
    if (row.size === "medium") {
      // 入力欄を開いたままの見た目(確定後と位置・大きさが一致するかの比較用)。
      await page.locator(".canvas-area").screenshot({
        path: path.join(OUTPUT_DIR, "text-input-before-commit.png"),
      });
    }
    await page.keyboard.press("Enter");
    if (row.size === "medium") {
      await page.locator(".canvas-area").screenshot({
        path: path.join(OUTPUT_DIR, "text-input-after-commit.png"),
      });
    }
  }

  await canvas.screenshot({ path: path.join(OUTPUT_DIR, "text-sizes.png") });
});
