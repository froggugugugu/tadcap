//! E2Eテスト: v0.2.0確認後の人間フィードバック(トーストの自動消去・矩形の角丸・履歴の件数上限)。
//!
//! - トースト: `src/ui/toast.ts`(成功・情報2.5秒 / エラー5秒、フェード200ms、reduced-motionはフェードなし)。
//!   時間はPlaywrightの`page.clock`で進める(実時間を待たない)
//! - 角丸: `rectangleTool.ts::rectangleCornerRadius()`(線幅×2.5、短辺×0.25で頭打ち)
//! - 履歴: `historyStore.ts::HISTORY_LIMIT`(20件)。21件目で最古の履歴が消える

import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "./fixtures/tauriMock";

const baseResult: MockCaptureResult = {
  id: "e2e-v020-1",
  sourcePath: "/tmp/tadcap-captures/e2e-v020-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

const WHITE = [255, 255, 255, 255] as const;
/** 注釈の既定色(ピンク `#FF5C8A`)。 */
const PINK = { r: 255, g: 92, b: 138 };
const COLOR_TOLERANCE = 40;

async function setUp(
  page: Page,
  options: { png?: Buffer; permissionDenied?: boolean; captureResults?: MockCaptureResult[] } = {},
): Promise<void> {
  const png = options.png ?? createFixtureCapturePng();
  await routeCrossOriginAssets(page, png);
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: options.permissionDenied
      ? { kind: "permissionDenied" }
      : { kind: "success", result: baseResult },
    captureImageBase64: png.toString("base64"),
    captureResults: options.captureResults,
  });
  await page.goto("/");
}

async function readPixel(canvas: Locator, x: number, y: number): Promise<[number, number, number]> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, [px, py]: [number, number]) => {
      const d = el.getContext("2d")!.getImageData(px, py, 1, 1).data;
      return [d[0], d[1], d[2]] as [number, number, number];
    },
    [x, y] as [number, number],
  );
}

function isNear(pixel: [number, number, number], target: { r: number; g: number; b: number }): boolean {
  return (
    Math.abs(pixel[0] - target.r) <= COLOR_TOLERANCE &&
    Math.abs(pixel[1] - target.g) <= COLOR_TOLERANCE &&
    Math.abs(pixel[2] - target.b) <= COLOR_TOLERANCE
  );
}

/** Canvasピクセル座標で from→to をドラッグする。 */
async function drag(page: Page, canvas: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const box = await canvas.boundingBox();
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }));
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  const sx = box.width / size.w;
  const sy = box.height / size.h;
  await page.mouse.move(box.x + from[0] * sx, box.y + from[1] * sy);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0] * sx, box.y + to[1] * sy, { steps: 8 });
  await page.mouse.up();
}

/**
 * ページの時計を止める(以後`runFor()`でだけ進む)。実時間が流れると境界(2.5秒ちょうど等)の
 * 検証が揺れるため。
 */
async function freezeClock(page: Page): Promise<void> {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
}

test.describe("トーストの自動消去", () => {
  test("コピー成功のトーストは約2.5秒後にフェードして消える(aria-liveのrole=statusは維持)", async ({ page }) => {
    await setUp(page);
    await captureAndWaitReady(page);
    await freezeClock(page);

    const status = page.locator("#clipboard-status");
    await page.getByRole("button", { name: "クリップボードにコピー" }).click();
    await expect(status).toHaveText("クリップボードにコピーしました。");
    await expect(status).toHaveAttribute("role", "status");

    await page.clock.runFor(2499);
    await expect(status).toHaveText("クリップボードにコピーしました。");
    await expect(status).not.toHaveClass(/toast--leaving/);
    await page.clock.runFor(1);
    await expect(status).toHaveClass(/toast--leaving/);
    await page.clock.runFor(200);
    await expect(status).toHaveText("");
    await expect(status).toBeHidden();
  });

  test("エラーのトーストは約5秒表示してから消え、権限の案内バナーは消えない", async ({ page }) => {
    await setUp(page, { permissionDenied: true });
    await freezeClock(page);

    const status = page.locator("#capture-status");
    await page.getByRole("button", { name: "キャプチャ" }).click();
    await expect(status).toHaveText("画面収録の権限が必要です。");

    await page.clock.runFor(4999);
    await expect(status).toHaveText("画面収録の権限が必要です。");
    await page.clock.runFor(1 + 200);
    await expect(status).toHaveText("");
    await expect(page.locator(".permission-banner")).toBeVisible();
  });

  test("prefers-reduced-motionではフェードせず2.5秒ちょうどで消える", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await setUp(page);
    await captureAndWaitReady(page);
    await freezeClock(page);

    const status = page.locator("#clipboard-status");
    await page.getByRole("button", { name: "クリップボードにコピー" }).click();
    await expect(status).toHaveText("クリップボードにコピーしました。");
    await page.clock.runFor(2499);
    await expect(status).toHaveText("クリップボードにコピーしました。");
    await expect(status).not.toHaveClass(/toast--leaving/);
    await page.clock.runFor(1);
    await expect(status).toHaveText("");
  });
});

test.describe("矩形の角丸", () => {
  test("描いた矩形の角の外側は背景色のまま、辺の中央と円弧上は注釈色になる", async ({ page }) => {
    // 2000x1000の白一色 → 線幅8px、角の半径 min(8×2.5, 500×0.25) = 20px。
    await setUp(page, { png: createFixtureCapturePng(2000, 1000, WHITE, WHITE) });
    const canvas = await captureAndWaitReady(page);
    await page.getByRole("button", { name: "矩形", exact: true }).click();
    await drag(page, canvas, [400, 300], [1400, 800]);

    // 矩形の角(角丸でなければ線が通る位置)は背景の白。
    for (const [x, y] of [
      [400, 300],
      [1400, 300],
      [400, 800],
      [1400, 800],
    ] as const) {
      expect(isNear(await readPixel(canvas, x, y), { r: 255, g: 255, b: 255 })).toBe(true);
    }
    // 辺の中央は注釈色。
    expect(isNear(await readPixel(canvas, 900, 300), PINK)).toBe(true);
    expect(isNear(await readPixel(canvas, 400, 550), PINK)).toBe(true);
    // 左上の円弧(中心(420,320)・半径20)の45°の点も注釈色。
    expect(isNear(await readPixel(canvas, 406, 306), PINK)).toBe(true);
  });
});

test.describe("履歴の件数上限", () => {
  test("21件目のキャプチャで最古の履歴が消え、20件が残る", async ({ page }) => {
    const results: MockCaptureResult[] = Array.from({ length: 21 }, (_, i) => ({
      ...baseResult,
      id: `e2e-v020-history-${i + 1}`,
      createdAt: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    }));
    await setUp(page, { captureResults: results });

    for (let i = 1; i <= 20; i += 1) {
      await captureAndWaitReady(page, i);
    }
    const oldest = page.getByRole("button", { name: `履歴 ${results[0]!.createdAt}` });
    await expect(oldest).toHaveCount(1);

    await page.getByRole("button", { name: "キャプチャ" }).click();
    await expect(page.getByRole("button", { name: `履歴 ${results[20]!.createdAt}` })).toHaveCount(1);
    await expect(page.locator("#history-sidebar li")).toHaveCount(20);
    await expect(oldest).toHaveCount(0);
    await expect(page.getByRole("button", { name: `履歴 ${results[1]!.createdAt}` })).toHaveCount(1);
  });
});
