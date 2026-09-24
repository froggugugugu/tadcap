//! E2Eテスト: 選択中のオブジェクトの操作と履歴ごとの保持(T34、PRD FR-006/010/012/013/014改訂)。
//!
//! 削除(Delete/Backspace)・色の変更・テキストの文字サイズ変更・最前面/最背面・履歴を切り替えて
//! 戻った後の再調整と取り消しを検証する。判定・状態遷移は`documentState.test.ts`・
//! `documentArchive.test.ts`・`selectionKeys.test.ts`・`arrangeButtons.test.ts`。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { diffFromSnapshot, saveSnapshot } from "./fixtures/canvasSnapshot";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "./fixtures/tauriMock";

const firstCaptureResult: MockCaptureResult = {
  id: "e2e-object-ops-1",
  sourcePath: "/tmp/tadcap-captures/e2e-object-ops-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};
const secondCaptureResult: MockCaptureResult = {
  id: "e2e-object-ops-2",
  sourcePath: "/tmp/tadcap-captures/e2e-object-ops-2.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:01.000Z",
};

type RGB = { r: number; g: number; b: number };
type Region = { x: number; y: number; width: number; height: number };
const PINK: RGB = { r: 255, g: 92, b: 138 };
const RED: RGB = { r: 255, g: 59, b: 48 };
const BLUE: RGB = { r: 0, g: 122, b: 255 };
const TOL = 40;

async function countColor(canvas: Locator, region: Region | null, target: RGB): Promise<number> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, args: { region: Region | null; target: RGB; tol: number }) => {
      const r = args.region ?? { x: 0, y: 0, width: el.width, height: el.height };
      const { data } = el.getContext("2d")!.getImageData(r.x, r.y, r.width, r.height);
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i]! - args.target.r) <= args.tol &&
          Math.abs(data[i + 1]! - args.target.g) <= args.tol &&
          Math.abs(data[i + 2]! - args.target.b) <= args.tol
        ) {
          count += 1;
        }
      }
      return count;
    },
    { region, target, tol: TOL },
  );
}

async function overlayHasSelection(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const overlay = document.querySelector<HTMLCanvasElement>(".shape-overlay");
    if (!overlay || overlay.hidden) {
      return false;
    }
    const { data } = overlay.getContext("2d")!.getImageData(0, 0, overlay.width, overlay.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! > 0) {
        return true;
      }
    }
    return false;
  });
}

async function toViewport(canvas: Locator, p: [number, number]): Promise<[number, number]> {
  const box = await canvas.boundingBox();
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }));
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  return [box.x + (p[0] * box.width) / size.w, box.y + (p[1] * box.height) / size.h];
}

async function click(page: Page, canvas: Locator, at: [number, number]): Promise<void> {
  const [x, y] = await toViewport(canvas, at);
  await page.mouse.click(x, y);
}

async function drag(page: Page, canvas: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const [fx, fy] = await toViewport(canvas, from);
  const [tx, ty] = await toViewport(canvas, to);
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 6 });
  await page.mouse.up();
}

test.describe("選択中のオブジェクトの操作と履歴ごとの保持(T34)", () => {
  const fixturePng = createFixtureCapturePng();
  let pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    await routeCrossOriginAssets(page, fixturePng);
    pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        pageErrors.push(msg.text());
      }
    });
  });

  async function start(page: Page, withSecond = false): Promise<Locator> {
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: firstCaptureResult },
      captureImageBase64: fixturePng.toString("base64"),
      ...(withSecond
        ? {
            secondCapture: {
              result: secondCaptureResult,
              captureImageBase64: createFixtureCapturePng(220, 160, [240, 240, 20, 255], [10, 10, 10, 255]).toString(
                "base64",
              ),
            },
          }
        : {}),
    });
    await page.goto("/");
    return captureAndWaitReady(page);
  }

  test("Delete/Backspaceで選択中のオブジェクトを削除でき、取り消しで戻る。入力欄のBackspaceは奪わない", async ({ page }) => {
    const canvas = await start(page);
    await saveSnapshot(canvas, "original");
    await page.getByRole("button", { name: "矩形" }).click();
    await drag(page, canvas, [40, 40], [140, 120]);
    await drag(page, canvas, [170, 40], [270, 120]);
    await page.keyboard.press("Escape");
    await saveSnapshot(canvas, "two");

    await click(page, canvas, [40, 80]); // 左の矩形の左辺
    await page.keyboard.press("Delete");
    expect(await countColor(canvas, { x: 36, y: 60, width: 8, height: 40 }, PINK)).toBe(0);
    expect(await countColor(canvas, { x: 166, y: 60, width: 8, height: 40 }, PINK)).toBeGreaterThan(0);
    await click(page, canvas, [170, 80]);
    await page.keyboard.press("Backspace");
    expect(await diffFromSnapshot(canvas, "original")).toBe(0);

    await page.keyboard.press("Meta+Z");
    await page.keyboard.press("Meta+Z");
    expect(await diffFromSnapshot(canvas, "two")).toBe(0);

    // テキスト入力欄のBackspaceは文字の削除(オブジェクトは消えない)。
    await page.getByRole("button", { name: "テキスト" }).click();
    await click(page, canvas, [60, 170]);
    const input = page.getByRole("textbox", { name: "テキスト入力" });
    await page.keyboard.type("ab");
    await page.keyboard.press("Backspace");
    await expect(input).toHaveValue("a");
    await page.keyboard.press("Escape");
    expect(await diffFromSnapshot(canvas, "two")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("選択中に色見本を押すとそのオブジェクトの色が変わり、取り消せる。以後に描く色も変わる", async ({ page }) => {
    const canvas = await start(page);
    await page.getByRole("button", { name: "矩形" }).click();
    await drag(page, canvas, [40, 40], [140, 120]);
    await saveSnapshot(canvas, "pink");

    await page.getByRole("button", { name: "青" }).click();
    expect(await overlayHasSelection(page)).toBe(true); // 色見本を押しても選択は外れない
    expect(await countColor(canvas, null, PINK)).toBe(0);
    expect(await countColor(canvas, null, BLUE)).toBeGreaterThan(0);

    await page.keyboard.press("Meta+Z");
    expect(await diffFromSnapshot(canvas, "pink")).toBe(0);

    await page.keyboard.press("Escape");
    await drag(page, canvas, [170, 40], [270, 120]);
    expect(await countColor(canvas, { x: 166, y: 60, width: 8, height: 40 }, BLUE)).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });

  test("テキストを選択中に文字サイズを押すと大きさが変わり、取り消せる", async ({ page }) => {
    const canvas = await start(page);
    await page.getByRole("button", { name: "テキスト" }).click();
    await click(page, canvas, [30, 100]);
    await page.keyboard.type("Size");
    await page.keyboard.press("Enter"); // 確定したテキストは選択状態
    await saveSnapshot(canvas, "medium");
    const mediumPixels = await countColor(canvas, null, PINK);

    await page.getByRole("button", { name: "文字サイズ 大" }).click();
    expect(await countColor(canvas, null, PINK)).toBeGreaterThan(mediumPixels * 1.5);
    await expect(page.getByRole("button", { name: "文字サイズ 大" })).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("Meta+Z");
    expect(await diffFromSnapshot(canvas, "medium")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("最前面へ・最背面へ(ボタン・⌘⇧F/⌘⇧B)で重なりの上下が変わり、選択中だけ有効で、取り消せる", async ({ page }) => {
    const front = page.getByRole("button", { name: "最前面へ" });
    const back = page.getByRole("button", { name: "最背面へ" });
    const canvas = await start(page);
    await expect(front).toBeDisabled();
    await expect(back).toBeDisabled();

    await page.getByRole("button", { name: "矢印" }).click();
    await page.getByRole("button", { name: "赤" }).click();
    await drag(page, canvas, [40, 100], [260, 100]); // 赤: 横
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "青" }).click();
    await drag(page, canvas, [150, 30], [150, 180]); // 青: 縦(後から描いたので上)
    await page.keyboard.press("Escape");
    await expect(front).toBeDisabled();

    const cross: Region = { x: 148, y: 98, width: 5, height: 5 };
    expect(await countColor(canvas, cross, BLUE)).toBeGreaterThan(0);
    expect(await countColor(canvas, cross, RED)).toBe(0);

    await click(page, canvas, [80, 100]); // 赤を選ぶ
    await expect(front).toBeEnabled();
    await front.click();
    expect(await overlayHasSelection(page)).toBe(true);
    expect(await countColor(canvas, cross, RED)).toBeGreaterThan(0);
    expect(await countColor(canvas, cross, BLUE)).toBe(0);

    await page.keyboard.press("Meta+Shift+B");
    expect(await countColor(canvas, cross, BLUE)).toBeGreaterThan(0);
    await page.keyboard.press("Meta+Shift+F");
    expect(await countColor(canvas, cross, RED)).toBeGreaterThan(0);
    await back.click();
    expect(await countColor(canvas, cross, BLUE)).toBeGreaterThan(0);

    await page.keyboard.press("Meta+Z"); // 最背面へ の取り消し → 赤が上
    expect(await countColor(canvas, cross, RED)).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });

  test("別の画像へ切り替えて戻っても、オブジェクトを動かせて取り消しも続きから戻せる", async ({ page }) => {
    const canvas = await start(page, true);
    await saveSnapshot(canvas, "original1");
    await page.getByRole("button", { name: "矩形" }).click();
    await drag(page, canvas, [40, 40], [140, 120]);
    await page.keyboard.press("Escape");
    await saveSnapshot(canvas, "edited1");

    // 2枚目をキャプチャして描く(1枚目は履歴の2番目へ)。
    await captureAndWaitReady(page, 2);
    await drag(page, canvas, [20, 20], [120, 100]);
    await page.keyboard.press("Escape");

    // 1枚目へ戻る。
    await page.locator(".history-sidebar__thumbnail-button").nth(1).click();
    await expect.poll(() => diffFromSnapshot(canvas, "edited1")).toBe(0);

    // 矩形を選び直して動かせる(履歴画像に焼き込まれていない)。
    await click(page, canvas, [40, 80]);
    expect(await overlayHasSelection(page)).toBe(true);
    await drag(page, canvas, [40, 80], [100, 80]);
    expect(await countColor(canvas, { x: 36, y: 60, width: 8, height: 40 }, PINK)).toBe(0);
    expect(await countColor(canvas, { x: 96, y: 60, width: 8, height: 40 }, PINK)).toBeGreaterThan(0);

    // 取り消し: 移動 → (切り替え前の)描画 の順に戻る。
    await page.keyboard.press("Meta+Z");
    expect(await diffFromSnapshot(canvas, "edited1")).toBe(0);
    await page.keyboard.press("Meta+Z");
    expect(await diffFromSnapshot(canvas, "original1")).toBe(0);

    // 2枚目へ戻っても、2枚目の矩形を選べる。
    await page.locator(".history-sidebar__thumbnail-button").nth(0).click();
    await expect.poll(() => canvas.evaluate((el: HTMLCanvasElement) => el.width)).toBe(220);
    await click(page, canvas, [20, 60]);
    expect(await overlayHasSelection(page)).toBe(true);
    expect(pageErrors).toEqual([]);
  });
});
