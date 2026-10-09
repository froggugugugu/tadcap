//! ツールバー全体の目視確認用スクリーンショット(T28: 色・フォントサイズ選択UIを追加した後の
//! 過密具合・グループ分けの確認)。ウィンドウ既定幅(800px、`tauri.conf.json`)で撮る。
//! 実行: `npx playwright test --config=e2e/screenshots/playwright.config.ts toolbar`。
//!
//! QE-T03(UI_quick-edits §1.4): 既定の窓幅を 1080px にし、狭めたら 2 段に折り返す。
//! 「幅 1080px で 1 段」「幅 800px で 2 段・右のまとまりが右端・横スクロールなし」を
//! ツールバーの高さと位置で確かめ、スクリーンショットを残す。

import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { createFixtureCapturePng } from "../fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "../fixtures/tauriMock";

const OUTPUT_DIR = path.join(process.cwd(), "output/reports/ui");

test.use({ deviceScaleFactor: 2, viewport: { width: 800, height: 600 } });

/** 1 段のときのツールバーの高さ(40px + 下の線 1px)の上限。2 段なら 74px + 1px になる。 */
const ONE_ROW_MAX_HEIGHT = 42;
const TWO_ROW_MIN_HEIGHT = 70;

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

/** 撮影済みの状態にする(QE-T03 の 2 本で共用)。 */
async function openWithCapture(page: Page, id: string): Promise<void> {
  const fixturePng = createFixtureCapturePng();
  await routeCrossOriginAssets(page, fixturePng);
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: {
      kind: "success",
      result: {
        id,
        sourcePath: `/tmp/tadcap-captures/${id}.png`,
        kind: "range",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    },
    captureImageBase64: fixturePng.toString("base64"),
  });
  await page.goto("/");
  await page.getByRole("button", { name: "キャプチャ" }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector<HTMLCanvasElement>("#capture-canvas");
    return !!el && el.width > 0 && el.height > 0;
  });
}

/** ツールバーの高さ・右のまとまりの右端・横スクロールの有無・はみ出したボタンの数。 */
async function measureToolbar(page: Page): Promise<{
  needsWrap: boolean;
  toolbarHeight: number;
  endGap: number;
  horizontalOverflow: boolean;
  clippedButtons: number;
  dividers: number;
}> {
  return page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>(".toolbar");
    const end = document.querySelector<HTMLElement>(".toolbar__end");
    if (!toolbar || !end) {
      throw new Error("toolbar or .toolbar__end not found");
    }
    const toolbarRect = toolbar.getBoundingClientRect();
    const paddingRight = parseFloat(getComputedStyle(toolbar).paddingRight);
    const clippedButtons = Array.from(toolbar.querySelectorAll<HTMLElement>("button")).filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left < toolbarRect.left || rect.right > toolbarRect.right || rect.bottom > toolbarRect.bottom;
    }).length;
    // 折り返さなかったときに必要な幅(ボタンが増える前後どちらでも判定できるように、実測で求める)
    const previousWrap = toolbar.style.flexWrap;
    toolbar.style.flexWrap = "nowrap";
    const needsWrap = toolbar.scrollWidth > toolbar.clientWidth;
    toolbar.style.flexWrap = previousWrap;
    return {
      needsWrap,
      toolbarHeight: toolbarRect.height,
      endGap: toolbarRect.right - paddingRight - end.getBoundingClientRect().right,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      clippedButtons,
      dividers: document.querySelectorAll("#tool-toolbar .tool-toolbar__divider").length,
    };
  });
}

test.describe("QE-T03: 既定の窓幅 1080px", () => {
  test.use({ viewport: { width: 1080, height: 600 } });

  test("1 段に収まり、編集ツールの組の区切りが 1 本", async ({ page }) => {
    await openWithCapture(page, "toolbar-qe-t03-1080");
    const measured = await measureToolbar(page);
    expect(measured.toolbarHeight).toBeLessThanOrEqual(ONE_ROW_MAX_HEIGHT);
    expect(measured.dividers).toBe(1);
    expect(measured.horizontalOverflow).toBe(false);
    expect(measured.clippedButtons).toBe(0);
    expect(Math.abs(measured.endGap)).toBeLessThanOrEqual(1);
    await page.locator(".toolbar").screenshot({ path: path.join(OUTPUT_DIR, "toolbar-qe-t03-1080.png") });
  });
});

test.describe("QE-T03: 窓を 800px に狭めたとき", () => {
  test.use({ viewport: { width: 800, height: 600 } });

  test("収まらないときは 2 段に折り返し、右のまとまりが右端にそろい、横スクロールが出ない", async ({ page }) => {
    await openWithCapture(page, "toolbar-qe-t03-800");
    const measured = await measureToolbar(page);
    // スタンプ・スポットライト・トリミングのボタンが加わるまでは 800px でも 1 段に収まる
    if (measured.needsWrap) {
      expect(measured.toolbarHeight).toBeGreaterThanOrEqual(TWO_ROW_MIN_HEIGHT);
    } else {
      expect(measured.toolbarHeight).toBeLessThanOrEqual(ONE_ROW_MAX_HEIGHT);
    }
    expect(measured.horizontalOverflow).toBe(false);
    expect(measured.clippedButtons).toBe(0);
    expect(Math.abs(measured.endGap)).toBeLessThanOrEqual(1);
    await page.locator(".toolbar").screenshot({ path: path.join(OUTPUT_DIR, "toolbar-qe-t03-800.png") });
    await page.screenshot({ path: path.join(OUTPUT_DIR, "toolbar-qe-t03-800-window.png") });
  });
});
