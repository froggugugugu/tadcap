//! 矩形枠ツール(T25、PRD FR-007)の目視確認用スクリーンショット。
//!
//! `computeRectangleGeometry()`/`computeRectangleBoundingRect()`の算出は
//! `rectangleTool.test.ts`でユニットテスト済みだが、実際に`ctx.strokeRect()`でCanvasへ
//! 焼き込んだ見た目(塗りつぶしなしの枠線になっているか)はDOM/Canvas API依存のため
//! 自動テスト対象外になる(project-config.md §11、`rectangleTool.ts`モジュールdoc参照)。
//! 既存のUIスクリーンショット環境(`e2e/screenshots/`、T19・T24)を流用し、手動目視確認用の
//! 画像を1枚生成する。
//!
//! 実行: `npm run e2e:screenshots:after`(このファイルも`*.visual.ts`として自動的に含まれる)。

import { mkdirSync } from "node:fs";
import path from "node:path";

import { test } from "@playwright/test";

import { createFixtureCapturePng } from "../fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "../fixtures/tauriMock";

const OUTPUT_PATH = path.join(process.cwd(), "output/reports/ui/rectangle.png");

const sampleCaptureResult: MockCaptureResult = {
  id: "rectangle-1",
  sourcePath: "/tmp/tadcap-captures/rectangle-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

// Canvas要素を4倍の物理解像度でスクリーンショットし、枠線の太さを見やすくする
// (`arrowTaper.visual.ts`と同じ理由)。
test.use({ deviceScaleFactor: 4 });

test.beforeAll(() => {
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
});

test("矩形枠: 塗りつぶしなしの枠線のみが焼き込まれる", async ({ page }) => {
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

  await page.getByRole("button", { name: "矩形" }).click();

  const canvas = page.locator("#capture-canvas");
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 30, box.y + box.height - 30, {
    steps: 8,
  });
  await page.mouse.up();

  await canvas.screenshot({ path: OUTPUT_PATH });
});
