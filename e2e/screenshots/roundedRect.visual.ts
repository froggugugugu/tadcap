//! 矩形の角丸(v0.2.0後の人間フィードバック)の目視確認用スクリーンショット。
//!
//! 角の半径は`rectangleTool.ts::rectangleCornerRadius()`(線幅×2.5、短辺×0.25で頭打ち)。
//! 通常の矩形・Shiftの正方形・小さい矩形(短辺で頭打ち)を1枚に並べ、角丸の係数の見た目を確かめる。
//! 背景は既定のチェッカーボード(1枚目)と、線幅が上限(14px)になる大きな白い画像(2枚目、実寸の切り出し)。
//!
//! 実行: `npm run e2e:screenshots:after`(このファイルも`*.visual.ts`として自動的に含まれる)。

import { mkdirSync } from "node:fs";
import path from "node:path";

import { test, type Locator, type Page } from "@playwright/test";

import { createFixtureCapturePng } from "../fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "../fixtures/tauriMock";

const OUTPUT_PATH = path.join(process.cwd(), "output/reports/ui/rounded-rect.png");
const OUTPUT_PATH_5K = path.join(process.cwd(), "output/reports/ui/rounded-rect-5k.png");

const sampleCaptureResult: MockCaptureResult = {
  id: "rounded-rect-1",
  sourcePath: "/tmp/tadcap-captures/rounded-rect-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

test.use({ deviceScaleFactor: 2 });

test.beforeAll(() => {
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
});

async function openWith(page: Page, png: Buffer): Promise<Locator> {
  await routeCrossOriginAssets(page, png);
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: { kind: "success", result: sampleCaptureResult },
    captureImageBase64: png.toString("base64"),
  });
  await page.goto("/");
  await page.getByRole("button", { name: "キャプチャ" }).click();
  await page.locator("#history-sidebar li").first().waitFor();
  await page.getByRole("button", { name: "矩形", exact: true }).click();
  return page.locator("#capture-canvas");
}

/** Canvasピクセル座標でドラッグする(`shift`でShift押下)。 */
async function drag(page: Page, canvas: Locator, from: [number, number], to: [number, number], shift = false): Promise<void> {
  const box = (await canvas.boundingBox())!;
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }));
  const sx = box.width / size.w;
  const sy = box.height / size.h;
  if (shift) {
    await page.keyboard.down("Shift");
  }
  await page.mouse.move(box.x + from[0] * sx, box.y + from[1] * sy);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0] * sx, box.y + to[1] * sy, { steps: 8 });
  await page.mouse.up();
  if (shift) {
    await page.keyboard.up("Shift");
  }
}

test("矩形の角丸: 通常・Shiftの正方形・小さい矩形", async ({ page }) => {
  const canvas = await openWith(page, createFixtureCapturePng());
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }));
  const w = size.w;
  const h = size.h;
  await drag(page, canvas, [w * 0.05, h * 0.1], [w * 0.45, h * 0.6]);
  await drag(page, canvas, [w * 0.55, h * 0.1], [w * 0.8, h * 0.3], true);
  await drag(page, canvas, [w * 0.1, h * 0.75], [w * 0.1 + 24, h * 0.75 + 14]);
  // 最後の矩形の選択ハンドルを外す(空き領域をクリック)。
  await page.keyboard.press("Escape");
  await canvas.screenshot({ path: OUTPUT_PATH });
});

test("矩形の角丸: 5K相当(線幅上限14px・半径35px)の実寸の切り出し", async ({ page }) => {
  const white = [255, 255, 255, 255] as const;
  const canvas = await openWith(page, createFixtureCapturePng(5120, 2880, white, white));
  await drag(page, canvas, [400, 400], [2400, 1600]);
  await page.keyboard.press("Escape");
  // 左上の角付近を実寸(1 Canvasピクセル = 1画素)で切り出す。
  const dataUrl = await canvas.evaluate((el: HTMLCanvasElement) => {
    const crop = document.createElement("canvas");
    crop.width = 320;
    crop.height = 200;
    crop.getContext("2d")!.drawImage(el, 320, 320, 320, 200, 0, 0, 320, 200);
    return crop.toDataURL("image/png");
  });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(OUTPUT_PATH_5K, Buffer.from(dataUrl.split(",")[1]!, "base64"));
});
