//! UIスクリーンショット: 自動マスキングの印と結果バー(AM-T17、UI_auto-masking §2〜§5)。
//!
//! 明るい/暗いキャプチャの上の 4 種の印(うち 1 件を外した状態)・処理中の表示・0 件の結果バーを
//! `output/reports/ui/<UI_SCREENSHOT_LABEL>/auto-mask-*.png` に保存する。印の見分けやすさ
//! (2 重の縁取り・外した印の破線・ラベルの左右)を目で確かめるための証跡で、合否は判定しない。
//!
//! `scan_sensitive_text` は `../fixtures/tauriMock.ts` のモック(矩形と種類だけ)。画像は
//! `../fixtures/sampleCapturePng.ts` のチェッカーボードを明るい色・暗い色で作る。
//! 本ファイルだけを撮るとき:
//! `UI_SCREENSHOT_LABEL=after npx playwright test --config=e2e/screenshots/playwright.config.ts autoMask`

import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { createFixtureCapturePng } from "../fixtures/sampleCapturePng";
import {
  installTauriMocks,
  releaseTextScans,
  routeCrossOriginAssets,
  type MockCaptureResult,
  type MockScanCandidate,
  type TextScanMockBehavior,
} from "../fixtures/tauriMock";

const LABEL = process.env.UI_SCREENSHOT_LABEL ?? "after";
const OUTPUT_DIR = path.join(process.cwd(), "output/reports/ui", LABEL);

const WIDTH = 640;
const HEIGHT = 400;

/** 明るいキャプチャ(白に近い 2 色)。 */
const LIGHT_PNG = createFixtureCapturePng(WIDTH, HEIGHT, [250, 250, 250, 255], [236, 238, 242, 255]);
/** 暗いキャプチャ(エディタの地に近い 2 色)。 */
const DARK_PNG = createFixtureCapturePng(WIDTH, HEIGHT, [30, 30, 30, 255], [44, 46, 54, 255]);

/**
 * 4 種の候補。2 件目と 3 件目は同じ行に並べ、右端に近い 3 件目のラベルが左の外側に回ることを見る
 * (UI 仕様 §4.3)。
 */
const CANDIDATES: MockScanCandidate[] = [
  { x: 36, y: 36, width: 220, height: 28, kind: "contact" },
  { x: 36, y: 132, width: 260, height: 28, kind: "credential" },
  { x: 420, y: 132, width: 200, height: 28, kind: "identifier" },
  { x: 36, y: 240, width: 180, height: 32, kind: "financial" },
];

const captureResult: MockCaptureResult = {
  id: "ui-auto-mask-1",
  sourcePath: "/tmp/tadcap-captures/ui-auto-mask-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

test.use({ deviceScaleFactor: 2, viewport: { width: 1100, height: 640 } });

test.beforeAll(() => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
});

async function openWithImage(page: Page, png: Buffer, textScan: TextScanMockBehavior): Promise<void> {
  await routeCrossOriginAssets(page, png);
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: { kind: "success", result: captureResult },
    captureImageBase64: png.toString("base64"),
    textScan,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "キャプチャ" }).click();
  await expect(page.getByRole("button", { name: "クリップボードにコピー" })).toBeEnabled();
  await expect(page.locator("#history-sidebar li")).toHaveCount(1);
  // キャプチャ直後の自動コピーのトーストが消えてから撮る。
  await expect(page.locator("#clipboard-status")).toBeHidden({ timeout: 10_000 });
}

async function shoot(page: Page, name: string): Promise<void> {
  // 印の重なり順・ラベルの左右の計算が済むまで 1 フレーム待つ。
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  await page.screenshot({ path: path.join(OUTPUT_DIR, `${name}.png`) });
}

async function showMarksWithOneExcluded(page: Page): Promise<void> {
  await page.locator("#auto-mask-button").click();
  await expect(page.locator(".mask-overlay .mask-mark")).toHaveCount(CANDIDATES.length);
  await page.getByRole("button", { name: "識別子の候補", exact: true }).click();
  await expect(page.locator(".mask-bar__count")).toHaveText("候補 4 件(うち 1 件を外しています)");
  // ポインタを印から離し、ホバーの濃い塗りを写さない。
  await page.mouse.move(2, 600);
}

test.describe("UIスクリーンショット: 自動マスキング(AM-T17)", () => {
  test("処理中の表示", async ({ page }) => {
    await openWithImage(page, LIGHT_PNG, { candidates: CANDIDATES, hold: true });
    await page.emulateMedia({ reducedMotion: "reduce" }); // リングを止めて撮る
    await page.locator("#auto-mask-button").click();
    await expect(page.locator(".mask-bar__count")).toHaveText("機密らしい箇所を探しています…");
    await shoot(page, "auto-mask-01-scanning");
    await releaseTextScans(page);
  });

  test("明るいキャプチャ上の印(1 件を外した状態)と結果バー", async ({ page }) => {
    await openWithImage(page, LIGHT_PNG, { candidates: CANDIDATES });
    await showMarksWithOneExcluded(page);
    await shoot(page, "auto-mask-02-light");
  });

  test("暗いキャプチャ上の印(1 件を外した状態)と結果バー", async ({ page }) => {
    await openWithImage(page, DARK_PNG, { candidates: CANDIDATES });
    await showMarksWithOneExcluded(page);
    await shoot(page, "auto-mask-03-dark");
  });

  test("0 件の結果バー", async ({ page }) => {
    await openWithImage(page, LIGHT_PNG, { candidates: [] });
    await page.locator("#auto-mask-button").click();
    await expect(page.locator(".mask-bar__count")).toHaveText("候補は見つかりませんでした。");
    await shoot(page, "auto-mask-04-empty");
  });
});
