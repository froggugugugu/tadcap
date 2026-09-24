//! E2Eテスト: 色・フォントサイズ選択UI(T28、PRD FR-013)。
//!
//! DOM生成・結線(`src/ui/colorPicker.ts::initColorPicker`・`fontSizePicker.ts::initFontSizePicker`)
//! はVitest対象外のため、ここで選択状態の表示と以後の描画への反映を検証する。色の定義・変換は
//! `colorPicker.test.ts`/`fontSizePicker.test.ts`。複数ツールを横断するUIフローはT30で追加する。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  getClipboardWriteCount,
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "./fixtures/tauriMock";

const sampleCaptureResult: MockCaptureResult = {
  id: "e2e-tool-settings-1",
  sourcePath: "/tmp/tadcap-captures/e2e-tool-settings-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

const PINK = { r: 255, g: 92, b: 138 };
const BLUE = { r: 0, g: 122, b: 255 };
const TOLERANCE = 40;

async function countPixels(canvas: Locator, target: { r: number; g: number; b: number }): Promise<number> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, args: { target: typeof PINK; tol: number }) => {
      const ctx = el.getContext("2d");
      if (!ctx) {
        return 0;
      }
      const { data } = ctx.getImageData(0, 0, el.width, el.height);
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - args.target.r) <= args.tol &&
          Math.abs(data[i + 1] - args.target.g) <= args.tol &&
          Math.abs(data[i + 2] - args.target.b) <= args.tol
        ) {
          count += 1;
        }
      }
      return count;
    },
    { target, tol: TOLERANCE },
  );
}

async function drawRectangleAndCommit(page: Page, canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press("Enter");
}

test.describe("色・フォントサイズ選択UI(T28)", () => {
  const fixturePng = createFixtureCapturePng();
  let pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    await routeCrossOriginAssets(page, fixturePng);
    pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: sampleCaptureResult },
      captureImageBase64: fixturePng.toString("base64"),
    });
    await page.goto("/");
  });

  test("起動直後はピンク・文字サイズ中が選択状態で、クリックで切り替わる", async ({ page }) => {
    await expect(page.getByRole("button", { name: "ピンク" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "文字サイズ 中" })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "青" }).click();
    await page.getByRole("button", { name: "文字サイズ 大" }).click();

    await expect(page.getByRole("button", { name: "青" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "ピンク" })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "文字サイズ 大" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "文字サイズ 中" })).toHaveAttribute("aria-pressed", "false");
    expect(pageErrors).toEqual([]);
  });

  test("選んだ色が以後の描画に使われ、描いた後の色変更は焼き込み済みの図形を変えない", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await page.getByRole("button", { name: "矩形" }).click();
    await page.getByRole("button", { name: "青" }).click();
    await drawRectangleAndCommit(page, canvas);

    const blue = await countPixels(canvas, BLUE);
    expect(blue).toBeGreaterThan(100);
    expect(await countPixels(canvas, PINK)).toBe(0);

    await page.getByRole("button", { name: "ピンク" }).click();
    expect(await countPixels(canvas, BLUE)).toBe(blue);
    expect(await countPixels(canvas, PINK)).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("カラーピッカーで選んだ色が反映され、ピッカーにフォーカスが残ってもCmd+Cは奪われない", async ({
    page,
  }) => {
    const canvas = await captureAndWaitReady(page);
    const picker = page.getByLabel("その他の色");
    // OSのカラーパネルは操作できないため、選択結果の`input`イベントを直接発火する。
    await picker.evaluate((el: HTMLInputElement) => {
      el.focus();
      el.value = "#007aff";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // #007AFFはプリセット「青」と一致するため、青が選択状態になる。
    await expect(page.getByRole("button", { name: "青" })).toHaveAttribute("aria-pressed", "true");

    await expect(page.getByRole("button", { name: "クリップボードにコピー" })).toBeEnabled();
    await expect(picker).toBeFocused();
    await page.keyboard.press("Meta+C");
    await expect(page.locator("#clipboard-status")).toHaveText("クリップボードにコピーしました。");
    expect(await getClipboardWriteCount(page)).toBe(1);

    await page.getByRole("button", { name: "矩形" }).click();
    await drawRectangleAndCommit(page, canvas);
    expect(await countPixels(canvas, BLUE)).toBeGreaterThan(100);
    expect(pageErrors).toEqual([]);
  });

  test("プリセット外の色を選ぶとカラーピッカーが選択状態になる", async ({ page }) => {
    await page.getByLabel("その他の色").evaluate((el: HTMLInputElement) => {
      el.value = "#123456";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(page.locator(".color-swatch--custom")).toHaveClass(/color-swatch--selected/);
    for (const name of ["ピンク", "赤", "橙", "黄", "緑", "青"]) {
      await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "false");
    }
    expect(pageErrors).toEqual([]);
  });
});
