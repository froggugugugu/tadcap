//! テーパー矢印(T25追補、人間フィードバックを受けた太さ・矢じり・ドロップシャドウ改訂)の
//! 目視確認用スクリーンショット。3つのCanvasサイズ(典型的なスクリーンショット2000x1000、
//! 5K相当5120x2880、小さい画像400x300)でそれぞれ生成し、`arrowLineWidth()`のクランプが
//! 意図どおりに効いているか(典型サイズで20px前後、5K相当は上限48pxでクランプ、小さい画像は
//! 下限6pxでクランプ)、矢じり・ドロップシャドウが見た目としてインパクトのある太さになって
//! いるかを目視確認する(project-config.md §11参照。第三者製品名はリポジトリに書かない方針)。
//!
//! 既存のUIスクリーンショット環境(`e2e/screenshots/`、T19・T24の`arrowTaper.visual.ts`)を
//! 流用する。実行: `npm run e2e:screenshots:after`。

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

// Canvas要素を4倍の物理解像度でスクリーンショットし、細部(胴の先細り・矢じり・シャドウ)を
// 見やすくする(`arrowTaper.visual.ts`と同じ理由)。
test.use({ deviceScaleFactor: 4 });

test.beforeAll(() => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
});

const SIZES: ReadonlyArray<{ label: string; width: number; height: number }> = [
  { label: "2000x1000", width: 2000, height: 1000 },
  { label: "5120x2880", width: 5120, height: 2880 },
  { label: "400x300", width: 400, height: 300 },
];

for (const size of SIZES) {
  test(`テーパー矢印(${size.label}): 太さ・矢じり・ドロップシャドウを目視確認`, async ({
    page,
  }) => {
    const fixturePng = createFixtureCapturePng(size.width, size.height);
    await routeCrossOriginAssets(page, fixturePng);

    const sampleCaptureResult: MockCaptureResult = {
      id: `arrow-taper-${size.label}`,
      sourcePath: `/tmp/tadcap-captures/arrow-taper-${size.label}.png`,
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

    await page.getByRole("button", { name: "矢印" }).click();

    const canvas = page.locator("#capture-canvas");
    const box = await canvas.boundingBox();
    if (!box) {
      throw new Error("#capture-canvas is not visible");
    }
    // 斜めドラッグ(表示矩形の8%→85%)にすることで、水平/垂直特有の対称性に頼らず
    // 形状を目視確認できるようにする(`arrowTaper.visual.ts`と同じ考え方)。
    await page.mouse.move(box.x + box.width * 0.08, box.y + box.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.85, {
      steps: 8,
    });
    await page.mouse.up();

    await canvas.screenshot({
      path: path.join(OUTPUT_DIR, `arrow-taper-${size.label}.png`),
    });
  });
}
