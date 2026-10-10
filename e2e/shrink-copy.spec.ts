//! E2Eテスト: 縮めてコピー(QE-T08、PRD_quick-edits FR-011・FR-012、ARCH_quick-edits §5.2・§7.1)。
//!
//! 設定がオンで撮った画面の倍率が 2 のとき、⌘C・コピーボタン・撮った直後の自動コピーの全経路で、
//! クリップボードへ渡す画像の幅・高さが倍率で割って四捨五入した大きさになることを確かめる。
//! 倍率 1・不明(`null`・欠落)・設定オフは元の大きさのまま。表示 canvas・履歴のサムネイルは
//! 元の大きさのまま。履歴から開き直しても、その項目の倍率で縮む。
//!
//! 他の spec と同じく Tauri ランタイムは起動せず `e2e/fixtures/tauriMock.ts` で IPC をモックする。
//! 倍率は撮影結果(`capture://completed` の payload)の `pixelRatio` で渡す(PNG の pHYs の読み取りは
//! Rust 側の責務で、`cargo test` で確かめる)。設定画面の UI は QE-T09 で足すため、ここでは
//! `get_shrink_copy` の初期値で設定を切り替える。

import { expect, test, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  getClipboardImageStats,
  getClipboardWriteCount,
  getLastClipboardImageSize,
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "./fixtures/tauriMock";

/** 四捨五入を確かめるため奇数の大きさにする(301 / 2 = 150.5 → 151、201 / 2 = 100.5 → 101)。 */
const WIDTH = 301;
const HEIGHT = 201;
const HALF = { width: 151, height: 101 };
const FULL = { width: WIDTH, height: HEIGHT };

/** フィクスチャのタイル色 A(`sampleCapturePng.ts` の既定)。縮めた画像にも元の色が残ることの確認用。 */
const COLOR_A = { r: 20, g: 180, b: 90 };

function captureResult(n: number, pixelRatio?: 1 | 2 | null): MockCaptureResult {
  const result: MockCaptureResult = {
    id: `e2e-shrink-${n}`,
    sourcePath: "/tmp/tadcap-captures/e2e-shrink.png",
    kind: "range",
    createdAt: `2024-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
  };
  if (pixelRatio !== undefined) {
    result.pixelRatio = pixelRatio;
  }
  return result;
}

const fixturePng = createFixtureCapturePng(WIDTH, HEIGHT);

async function setup(
  page: Page,
  options: { shrinkCopy: boolean; results: MockCaptureResult[] },
): Promise<string[]> {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      pageErrors.push(msg.text());
    }
  });
  await routeCrossOriginAssets(page, fixturePng);
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: { kind: "success", result: options.results[0]! },
    captureResults: options.results,
    captureImageBase64: fixturePng.toString("base64"),
    shrinkCopy: options.shrinkCopy,
  });
  await page.goto("/");
  return pageErrors;
}

/** 直近のコピーの大きさ。RGBA の長さが大きさと合っていることも確かめる。 */
async function lastCopySize(page: Page): Promise<{ width: number; height: number } | null> {
  const size = await getLastClipboardImageSize(page);
  if (size) {
    const length = await page.evaluate(() => {
      const w = window as unknown as { __tadcapE2E?: { lastImage?: { rgba: Uint8Array } } };
      return w.__tadcapE2E?.lastImage?.rgba.length ?? 0;
    });
    expect(length).toBe(size.width * size.height * 4);
  }
  return size;
}

/** コピーボタンを押し、書き込みが 1 回増えるのを待つ。 */
async function copyWithButton(page: Page): Promise<void> {
  const before = await getClipboardWriteCount(page);
  await page.getByRole("button", { name: "クリップボードにコピー" }).click();
  await expect.poll(() => getClipboardWriteCount(page)).toBe(before + 1);
}

/** ⌘C でコピーし、書き込みが 1 回増えるのを待つ。 */
async function copyWithShortcut(page: Page): Promise<void> {
  const before = await getClipboardWriteCount(page);
  await page.keyboard.press("Meta+C");
  await expect.poll(() => getClipboardWriteCount(page)).toBe(before + 1);
}

/** 表示 canvas の大きさ。 */
async function canvasSize(page: Page): Promise<{ width: number; height: number }> {
  return page
    .locator("#capture-canvas")
    .evaluate((el: HTMLCanvasElement) => ({ width: el.width, height: el.height }));
}

/** 履歴の n 番目(0 始まり、新しいものが先頭)を開き、表示中になるのを待つ。 */
async function openHistoryItem(page: Page, index: number): Promise<void> {
  const item = page.locator(".history-sidebar__item").nth(index);
  await item.locator(".history-sidebar__thumbnail-button").click();
  await expect(item).toHaveClass(/history-sidebar__item--selected/);
}

test.describe("縮めてコピー(QE-T08)", () => {
  test("オン × 倍率 2: 撮った直後の自動コピー・⌘C・コピーボタンのすべてで半分(四捨五入)になり、表示と履歴は元の大きさのまま", async ({
    page,
  }) => {
    const pageErrors = await setup(page, { shrinkCopy: true, results: [captureResult(1, 2)] });

    await captureAndWaitReady(page, 1);
    // 撮った直後の自動コピー。
    expect(await lastCopySize(page)).toEqual(HALF);
    // 縮めた画像にも元の色が残る(壊れた・空の画像ではない)。
    const stats = await getClipboardImageStats(page, COLOR_A, 30);
    expect(stats?.targetColorPixels ?? 0).toBeGreaterThan(0);

    await copyWithShortcut(page);
    expect(await lastCopySize(page)).toEqual(HALF);

    await copyWithButton(page);
    expect(await lastCopySize(page)).toEqual(HALF);

    // 表示・編集・履歴は元の解像度のまま(FR-012)。
    expect(await canvasSize(page)).toEqual(FULL);
    const thumbnail = page.locator(".history-sidebar__thumbnail").first();
    await expect
      .poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(160);
    expect(pageErrors).toEqual([]);
  });

  for (const [label, pixelRatio] of [
    ["倍率 1", 1],
    ["倍率が不明(null)", null],
    ["倍率を持たない撮影結果", undefined],
  ] as const) {
    test(`オン × ${label}: どの経路も元の大きさでコピーする`, async ({ page }) => {
      const pageErrors = await setup(page, {
        shrinkCopy: true,
        results: [captureResult(1, pixelRatio)],
      });

      await captureAndWaitReady(page, 1);
      expect(await lastCopySize(page)).toEqual(FULL);
      await copyWithShortcut(page);
      expect(await lastCopySize(page)).toEqual(FULL);
      await copyWithButton(page);
      expect(await lastCopySize(page)).toEqual(FULL);
      expect(pageErrors).toEqual([]);
    });
  }

  test("オフ × 倍率 2: どの経路も元の大きさでコピーし、Canvas と同じ画素になる", async ({ page }) => {
    const pageErrors = await setup(page, { shrinkCopy: false, results: [captureResult(1, 2)] });

    await captureAndWaitReady(page, 1);
    expect(await lastCopySize(page)).toEqual(FULL);
    await copyWithShortcut(page);
    expect(await lastCopySize(page)).toEqual(FULL);
    await copyWithButton(page);
    expect(await lastCopySize(page)).toEqual(FULL);
    const stats = await getClipboardImageStats(page, COLOR_A, 0);
    expect(stats?.equalsCanvas).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test("履歴から開き直しても、その項目の倍率で縮む(倍率 2 の項目は半分、倍率 1 の項目は元の大きさ)", async ({
    page,
  }) => {
    const pageErrors = await setup(page, {
      shrinkCopy: true,
      results: [captureResult(1, 2), captureResult(2, 1)],
    });

    await captureAndWaitReady(page, 1); // 倍率 2
    await captureAndWaitReady(page, 2); // 倍率 1(表示中)。一覧: [2, 1]
    expect(await lastCopySize(page)).toEqual(FULL);

    // 古い項目(倍率 2)を開き直す。
    await openHistoryItem(page, 1);
    await copyWithButton(page);
    expect(await lastCopySize(page)).toEqual(HALF);
    await copyWithShortcut(page);
    expect(await lastCopySize(page)).toEqual(HALF);
    expect(await canvasSize(page)).toEqual(FULL);

    // 新しい項目(倍率 1)へ戻すと元の大きさ。
    await openHistoryItem(page, 0);
    await copyWithButton(page);
    expect(await lastCopySize(page)).toEqual(FULL);

    // もう一度、倍率 2 の項目へ(開き直しを繰り返しても同じ)。
    await openHistoryItem(page, 1);
    await copyWithShortcut(page);
    expect(await lastCopySize(page)).toEqual(HALF);
    expect(pageErrors).toEqual([]);
  });
});
