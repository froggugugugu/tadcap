//! UIスクリーンショット: 小さな編集機能の見た目(UI_quick-edits §2・§10)。合否は判定しない目視の証跡。
//!
//! QE-T13: スタンプ — 番号 1 桁・2 桁と記号 4 種 × 小・中・大を明るい画像・暗い画像に置き、
//! 黄の丸の黒い記号と選択の輪も写す。あわせてスタンプの種類を出したツールバーを撮る。
//! 画像は UI §2.3 の例と同じ 2080 × 1204(直径 小 47・中 70・大 104px)。
//! スポットライト(QE-T16)・トリミング(QE-T23)はそれぞれのタスクで本ファイルに足す。
//!
//! 出力: `output/reports/ui/quick-edits-*.png`。本ファイルだけを撮るとき:
//! `npx playwright test --config=e2e/screenshots/playwright.config.ts e2e/screenshots/quickEdits.visual.ts`

import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { createFixtureCapturePng } from "../fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "../fixtures/tauriMock";

const OUTPUT_DIR = path.join(process.cwd(), "output/reports/ui");

const WIDTH = 2080;
const HEIGHT = 1204;

/** 明るいキャプチャ(白に近い 2 色)。 */
const LIGHT_PNG = createFixtureCapturePng(WIDTH, HEIGHT, [250, 250, 250, 255], [236, 238, 242, 255]);
/** 暗いキャプチャ(エディタの地に近い 2 色)。 */
const DARK_PNG = createFixtureCapturePng(WIDTH, HEIGHT, [30, 30, 30, 255], [44, 46, 54, 255]);

const captureResult: MockCaptureResult = {
  id: "ui-quick-edits-stamp",
  sourcePath: "/tmp/tadcap-captures/ui-quick-edits-stamp.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

type Size = "small" | "medium" | "large";
type Point = [number, number];

const SIZE_LABEL: Record<Size, string> = { small: "文字サイズ 小", medium: "文字サイズ 中", large: "文字サイズ 大" };
const SYMBOLS = ["スタンプ チェック", "スタンプ バツ", "スタンプ 注意", "スタンプ 質問"] as const;
/** 行(小・中・大)の縦位置と、列の横位置(Canvas ピクセル)。 */
const ROW_Y: Record<Size, number> = { small: 150, medium: 400, large: 700 };
const COLUMN_X = [150, 370, 590, 810, 1110, 1330, 1550, 1770];

test.use({ deviceScaleFactor: 2, viewport: { width: 1080, height: 800 } });

test.beforeAll(() => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
});

async function openWithImage(page: Page, png: Buffer): Promise<Locator> {
  await routeCrossOriginAssets(page, png);
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: { kind: "success", result: captureResult },
    captureImageBase64: png.toString("base64"),
  });
  await page.goto("/");
  await page.getByRole("button", { name: "キャプチャ" }).click();
  await expect(page.getByRole("button", { name: "クリップボードにコピー" })).toBeEnabled();
  await expect(page.locator("#history-sidebar li")).toHaveCount(1);
  // キャプチャ直後の自動コピーのトーストが消えてから撮る。
  await expect(page.locator("#clipboard-status")).toBeHidden({ timeout: 10_000 });
  return page.locator("#capture-canvas");
}

async function clickAt(page: Page, canvas: Locator, p: Point): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  await page.mouse.click(box.x + (p[0] * box.width) / WIDTH, box.y + (p[1] * box.height) / HEIGHT);
}

async function pick(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
}

/**
 * 選択を外してから文字サイズ・色を選ぶ(選択中のスタンプがあると、その色・大きさが変わるため)。
 */
async function chooseStyle(page: Page, size: Size, color?: string): Promise<void> {
  await page.keyboard.press("Escape");
  await pick(page, SIZE_LABEL[size]);
  if (color) {
    await pick(page, color);
  }
}

/**
 * 小・中・大の各行に 1 桁の番号 3 つ・2 桁の番号 1 つ・記号 4 種を並べ、最後の行に黄の丸
 * (黒い記号)を置いて、番号 2 を選んで輪を出す。番号は置いた順なので、1 桁を先に 9 個置いてから
 * 2 桁(10・11・12)を各行に置く。
 */
async function placeStampSheet(page: Page, canvas: Locator): Promise<void> {
  await page.getByRole("button", { name: "スタンプ(N)" }).click();
  const sizes: Size[] = ["small", "medium", "large"];
  for (const size of sizes) {
    await chooseStyle(page, size);
    await pick(page, "スタンプ 番号");
    for (const x of COLUMN_X.slice(0, 3)) {
      await clickAt(page, canvas, [x, ROW_Y[size]]);
    }
  }
  for (const size of sizes) {
    await chooseStyle(page, size);
    await pick(page, "スタンプ 番号");
    await clickAt(page, canvas, [COLUMN_X[3]!, ROW_Y[size]]);
    for (const [i, symbol] of SYMBOLS.entries()) {
      await pick(page, symbol);
      await clickAt(page, canvas, [COLUMN_X[4 + i]!, ROW_Y[size]]);
    }
  }

  // 黄の丸: 白とのコントラストが低いので記号は黒(UI §2.4)。
  await chooseStyle(page, "medium", "黄");
  await pick(page, "スタンプ 番号");
  await clickAt(page, canvas, [COLUMN_X[0]!, 1000]);
  await pick(page, "スタンプ チェック");
  await clickAt(page, canvas, [COLUMN_X[1]!, 1000]);
  await pick(page, "スタンプ 注意");
  await clickAt(page, canvas, [COLUMN_X[2]!, 1000]);

  // 選択の輪(円の外側 4px、白の実線 + 濃い破線、UI §2.5)。オーバーレイにだけ描く。
  await page.keyboard.press("Escape");
  await clickAt(page, canvas, [COLUMN_X[1]!, ROW_Y.medium]);
  await expect(page.getByRole("button", { name: "最背面へ(⌘⇧B)" })).toBeEnabled();
}

async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

test.describe("スタンプ(QE-T13)", () => {
  test("明るい画像: 番号 1 桁・2 桁と記号 4 種 × 小・中・大、黄の丸、選択の輪", async ({ page }) => {
    const canvas = await openWithImage(page, LIGHT_PNG);
    await placeStampSheet(page, canvas);
    await nextFrame(page);
    await page.locator(".canvas-area").screenshot({ path: path.join(OUTPUT_DIR, "quick-edits-stamp-light.png") });
  });

  test("暗い画像: 番号 1 桁・2 桁と記号 4 種 × 小・中・大、黄の丸、選択の輪", async ({ page }) => {
    const canvas = await openWithImage(page, DARK_PNG);
    await placeStampSheet(page, canvas);
    await nextFrame(page);
    await page.locator(".canvas-area").screenshot({ path: path.join(OUTPUT_DIR, "quick-edits-stamp-dark.png") });
  });

  test("ツールバー: スタンプを選んで種類が出た状態(幅 1080px で 1 段)", async ({ page }) => {
    await openWithImage(page, LIGHT_PNG);
    const toolbar = page.locator("header.toolbar");
    await toolbar.screenshot({ path: path.join(OUTPUT_DIR, "quick-edits-toolbar-default.png") });
    await page.getByRole("button", { name: "スタンプ(N)" }).click();
    await pick(page, "スタンプ 注意");
    await expect(page.getByRole("group", { name: "スタンプの種類" })).toBeVisible();
    // ボタンの色の切り替わり(150ms の transition)を終えてから撮る。
    await toolbar.screenshot({
      path: path.join(OUTPUT_DIR, "quick-edits-toolbar-stamp.png"),
      animations: "disabled",
    });
  });
});
