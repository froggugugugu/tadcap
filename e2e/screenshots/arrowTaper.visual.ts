//! テーパー矢印(T24、PRD FR-006改訂)の目視確認用スクリーンショット。
//!
//! `computeTaperArrowPolygon()`の頂点算出は`arrowTool.test.ts`でユニットテスト済みだが、
//! 実際に`ctx.fill()`でCanvasへ焼き込んだ見た目(始点が細く終点に向かって徐々に太くなるか、
//! 矢じりと胴が滑らかに繋がっているか)はDOM/Canvas API依存のため自動テスト対象外になる
//! (project-config.md §11、`arrowTool.ts`モジュールdoc参照)。既存のUIスクリーンショット環境
//! (`e2e/screenshots/`、T19)を流用し、手動目視確認用の画像を1枚生成する。
//!
//! フィクスチャ画像(`sampleCapturePng.ts`)は300x200pxのため`arrowLineWidth()`は最小の
//! 2px付近になり、そのままでは太さの変化が分かりにくい。`deviceScaleFactor`を上げて
//! Canvas要素をズームした状態でスクリーンショットすることで、線の太さの変化を見やすくする。
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

const OUTPUT_PATH = path.join(
  process.cwd(),
  "output/reports/ui/arrow-taper.png",
);

const sampleCaptureResult: MockCaptureResult = {
  id: "arrow-taper-1",
  sourcePath: "/tmp/tadcap-captures/arrow-taper-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

// Canvas要素を4倍の物理解像度でスクリーンショットし、細い線の太さの変化を見やすくする。
test.use({ deviceScaleFactor: 4 });

test.beforeAll(() => {
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
});

test("テーパー矢印: 始点が細く終点が太く、矢じりと胴が滑らかに繋がる", async ({ page }) => {
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

  await page.getByRole("button", { name: "矢印" }).click();

  const canvas = page.locator("#capture-canvas");
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  // 斜めドラッグにすることで、水平/垂直特有の対称性に頼らず形状を目視確認できるようにする。
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, {
    steps: 8,
  });
  await page.mouse.up();

  await canvas.screenshot({ path: OUTPUT_PATH });
});
