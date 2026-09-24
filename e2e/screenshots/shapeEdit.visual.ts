//! 編集中の図形(T31)の目視確認用スクリーンショット。矢印・矩形・円それぞれを描いた直後
//! (編集中=ハンドル表示)の状態を撮る。ハンドルはオーバーレイ(`.shape-overlay`)に描かれ、
//! Canvasのピクセルには含まれない(コピー結果に写らないことは`e2e/shape-edit.spec.ts`で検証)。
//!
//! 実行: `npx playwright test --config=e2e/screenshots/playwright.config.ts shapeEdit`

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

const sampleCaptureResult: MockCaptureResult = {
  id: "shape-edit-1",
  sourcePath: "/tmp/tadcap-captures/shape-edit-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

// 細部(ハンドル・線幅)が見えるよう高解像度で撮る(`rectangle.visual.ts`と同じ理由)。
test.use({ deviceScaleFactor: 3 });

test.beforeAll(() => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
});

const CASES: { tool: string; file: string; from: [number, number]; to: [number, number] }[] = [
  { tool: "矢印", file: "edit-arrow.png", from: [40, 160], to: [240, 50] },
  { tool: "矩形", file: "edit-rectangle.png", from: [50, 40], to: [230, 150] },
  { tool: "円", file: "edit-ellipse.png", from: [50, 40], to: [230, 150] },
];

for (const c of CASES) {
  test(`編集中の${c.tool}: ハンドルがオーバーレイに表示される`, async ({ page }) => {
    const fixturePng = createFixtureCapturePng();
    await routeCrossOriginAssets(page, fixturePng);
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
    await page.getByRole("button", { name: c.tool }).click();

    const canvas = page.locator("#capture-canvas");
    const box = await canvas.boundingBox();
    if (!box) {
      throw new Error("#capture-canvas is not visible");
    }
    await page.mouse.move(box.x + c.from[0], box.y + c.from[1]);
    await page.mouse.down();
    await page.mouse.move(box.x + c.to[0], box.y + c.to[1], { steps: 8 });
    await page.mouse.up();

    // ハンドルがCanvasの外縁に少しはみ出すため、周囲に余白を付けて撮る。
    await page.screenshot({
      path: path.join(OUTPUT_DIR, c.file),
      clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 },
    });
  });
}
