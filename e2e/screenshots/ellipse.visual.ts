//! 円(楕円)枠ツール(T26、PRD FR-011)の目視確認用スクリーンショット。
//!
//! `computeEllipseGeometry()`/`computeEllipseCenterAndRadii()`/`computeEllipseBoundingRect()`の
//! 算出は`ellipseTool.test.ts`でユニットテスト済みだが、実際に`ctx.ellipse()`でCanvasへ
//! 焼き込んだ見た目(塗りつぶしなしの枠線になっているか、Shift押下時に正円になるか)は
//! DOM/Canvas API依存のため自動テスト対象外になる(project-config.md §11、`ellipseTool.ts`
//! モジュールdoc参照)。既存のUIスクリーンショット環境(`e2e/screenshots/`、T19・T25)を流用し、
//! 1枚のCanvas上に(1)通常ドラッグの楕円(縦横比自由)と(2)Shift押下ドラッグの正円の両方を
//! 描いたうえで、手動目視確認用の画像を1枚生成する。
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

const OUTPUT_PATH = path.join(process.cwd(), "output/reports/ui/ellipse.png");

const sampleCaptureResult: MockCaptureResult = {
  id: "ellipse-1",
  sourcePath: "/tmp/tadcap-captures/ellipse-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

// Canvas要素を4倍の物理解像度でスクリーンショットし、枠線の太さを見やすくする
// (`rectangle.visual.ts`と同じ理由)。
test.use({ deviceScaleFactor: 4 });

test.beforeAll(() => {
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
});

test("円(楕円)枠: 塗りつぶしなしの枠線のみが焼き込まれ、Shiftドラッグで正円になる", async ({
  page,
}) => {
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

  await page.getByRole("button", { name: "円" }).click();

  const canvas = page.locator("#capture-canvas");
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }

  // 1本目: 通常のドラッグ(縦横比自由な楕円、左上に描く)。
  await page.mouse.move(box.x + box.width * 0.08, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.48, box.y + box.height * 0.42, {
    steps: 8,
  });
  await page.mouse.up();

  // 2本目: Shift押下ドラッグ(外接矩形が正方形になる正円、右下に描く)。
  // Canvas範囲内に収まる正方形になるよう、あらかじめ外接矩形が正方形に補正された後も
  // 300x200のCanvas範囲を超えない終点を選んでいる。
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.75, {
    steps: 8,
  });
  await page.mouse.up();
  await page.keyboard.up("Shift");

  await canvas.screenshot({ path: OUTPUT_PATH });
});
