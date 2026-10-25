//! E2Eテスト: 数字キー 1〜6 の色のプリセットと、矢印キーによる選択中の注釈の移動(v1.2.0、UI_quick-edits §7)。
//!
//! 判定そのもの(修飾キー・IME・入力欄・画像なし・確認中・Shift で 10px・端で止まる)は
//! `src/ui/colorKeys.test.ts`・`src/ui/selectionKeys.test.ts`・`src/canvas/documentState.test.ts` で確かめ、
//! ここでは `window` への結線と、ツールチップ・テキスト入力・取り消し・自動マスキングの確認中との共存を確かめる。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { diffFromSnapshot, saveSnapshot } from "./fixtures/canvasSnapshot";
import { captureAndWaitReady } from "./fixtures/captureReady";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
  type MockScanCandidate,
} from "./fixtures/tauriMock";

const sampleCaptureResult: MockCaptureResult = {
  id: "e2e-keyboard-shortcuts-1",
  sourcePath: "/tmp/tadcap-captures/e2e-keyboard-shortcuts-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

const CANDIDATES: MockScanCandidate[] = [{ x: 12, y: 12, width: 96, height: 24, kind: "contact" }];

/** `src/ui/colorPicker.ts::COLOR_PRESETS` と同じ並び(1 番目のプリセットが 1)。 */
const COLOR_KEYS = [
  { key: "1", label: "ピンク" },
  { key: "2", label: "赤" },
  { key: "3", label: "橙" },
  { key: "4", label: "黄" },
  { key: "5", label: "緑" },
  { key: "6", label: "青" },
] as const;

type RGB = { r: number; g: number; b: number };
type Region = { x: number; y: number; width: number; height: number };
const PINK: RGB = { r: 255, g: 92, b: 138 };
const RED: RGB = { r: 255, g: 59, b: 48 };
const BLUE: RGB = { r: 0, g: 122, b: 255 };
const TOL = 40;

function swatch(page: Page, label: string): Locator {
  return page.getByRole("button", { name: label, exact: true });
}

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

/**
 * 行の帯(`band`)の中で、`target` 色がほぼそのまま(境界のにじみを除く)出ている最も左の列。無ければ `-1`。
 * 整数ピクセルの移動なら描画のにじみ方は変わらないので、この列の差がそのまま移動量になる。
 */
async function leftmostColumn(canvas: Locator, target: RGB, band: { y: number; height: number }): Promise<number> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, args: { band: { y: number; height: number }; target: RGB; tol: number }) => {
      const { data } = el.getContext("2d")!.getImageData(0, args.band.y, el.width, args.band.height);
      for (let x = 0; x < el.width; x += 1) {
        for (let row = 0; row < args.band.height; row += 1) {
          const i = (row * el.width + x) * 4;
          if (
            Math.abs(data[i]! - args.target.r) <= args.tol &&
            Math.abs(data[i + 1]! - args.target.g) <= args.tol &&
            Math.abs(data[i + 2]! - args.target.b) <= args.tol
          ) {
            return x;
          }
        }
      }
      return -1;
    },
    { band, target, tol: 8 },
  );
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

test.describe("数字キーの色のプリセットと矢印キーの移動(v1.2.0)", () => {
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
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: sampleCaptureResult },
      captureImageBase64: fixturePng.toString("base64"),
      textScan: { candidates: CANDIDATES },
    });
    await page.goto("/");
  });

  test("色見本のツールチップが「名前(キー)」の形で aria-keyshortcuts が入り、aria-label は名前のまま", async ({ page }) => {
    for (const { key, label } of COLOR_KEYS) {
      const button = swatch(page, label);
      await expect(button).toHaveAttribute("aria-label", label);
      await expect(button).toHaveAttribute("title", `${label}(${key})`);
      await expect(button).toHaveAttribute("aria-keyshortcuts", key);
    }
    expect(pageErrors).toEqual([]);
  });

  test("2 を押すと 2 番目のプリセットが選択状態になり、次に描く矢印がその色。選択中の注釈の色も変わり取り消せる", async ({
    page,
  }) => {
    // 画像が無い間は効かない。
    await page.keyboard.press("2");
    await expect(swatch(page, "ピンク")).toHaveAttribute("aria-pressed", "true");
    await expect(swatch(page, "赤")).toHaveAttribute("aria-pressed", "false");

    const canvas = await captureAndWaitReady(page);
    await page.keyboard.press("2");
    await expect(swatch(page, "赤")).toHaveAttribute("aria-pressed", "true");
    await expect(swatch(page, "ピンク")).toHaveAttribute("aria-pressed", "false");
    // 7 以降は割り当てなし。
    await page.keyboard.press("7");
    await expect(swatch(page, "赤")).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("a");
    await drag(page, canvas, [40, 100], [260, 100]);
    expect(await countColor(canvas, null, RED)).toBeGreaterThan(0);
    expect(await countColor(canvas, null, PINK)).toBe(0);

    // 描いた直後の矢印は選択中。6 でその色も青になり(ボタンと同じ経路)、⌘Z で赤に戻る。
    await page.keyboard.press("6");
    await expect(swatch(page, "青")).toHaveAttribute("aria-pressed", "true");
    expect(await countColor(canvas, null, BLUE)).toBeGreaterThan(0);
    expect(await countColor(canvas, null, RED)).toBe(0);
    await page.keyboard.press("Meta+Z");
    expect(await countColor(canvas, null, RED)).toBeGreaterThan(0);
    expect(await countColor(canvas, null, BLUE)).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("テキストの入力中に 2 を押すと文字が入り、色は変わらない", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await page.keyboard.press("t");
    await click(page, canvas, [60, 100]);
    const input = page.getByRole("textbox", { name: "テキスト入力" });
    await expect(input).toBeFocused();

    await page.keyboard.press("2");
    await expect(input).toHaveValue("2");
    await expect(swatch(page, "ピンク")).toHaveAttribute("aria-pressed", "true");
    await expect(swatch(page, "赤")).toHaveAttribute("aria-pressed", "false");
    expect(pageErrors).toEqual([]);
  });

  test("矩形を選んで → を 3 回押すと 3px 右に動き、⇧→ で 10px、⌘Z で元の位置。選択なし・入力欄では動かない", async ({
    page,
  }) => {
    const canvas = await captureAndWaitReady(page);
    await page.keyboard.press("r");
    await drag(page, canvas, [40, 40], [140, 120]); // 描いた直後は選択中
    await saveSnapshot(canvas, "drawn");
    const band = { y: 60, height: 40 };
    const left = await leftmostColumn(canvas, PINK, band);
    expect(left).toBeGreaterThan(0);

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await leftmostColumn(canvas, PINK, band)).toBe(left + 3);

    await page.keyboard.press("Shift+ArrowRight");
    expect(await leftmostColumn(canvas, PINK, band)).toBe(left + 13);

    // 1 押下 = 1 手。⌘Z 1 回で ⇧→ の 10px が戻り、さらに 3 回で元の位置。
    await page.keyboard.press("Meta+Z");
    expect(await leftmostColumn(canvas, PINK, band)).toBe(left + 3);
    await page.keyboard.press("Meta+Z");
    await page.keyboard.press("Meta+Z");
    await page.keyboard.press("Meta+Z");
    expect(await leftmostColumn(canvas, PINK, band)).toBe(left);
    expect(await diffFromSnapshot(canvas, "drawn")).toBe(0);

    // 選択を外すと矢印キーは効かない。
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    expect(await diffFromSnapshot(canvas, "drawn")).toBe(0);

    // テキストの入力欄では文字カーソルが動く(矢印キーを奪わない)。
    await page.keyboard.press("t");
    await click(page, canvas, [60, 170]);
    const input = page.getByRole("textbox", { name: "テキスト入力" });
    await expect(input).toBeFocused();
    await page.keyboard.type("ab");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("c");
    await expect(input).toHaveValue("acb");
    await page.keyboard.press("Escape");
    expect(await diffFromSnapshot(canvas, "drawn")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("自動マスキングの確認中は数字キーで色が変わらず、矢印キーでも動かない", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await page.keyboard.press("r");
    await drag(page, canvas, [40, 40], [140, 120]);
    await saveSnapshot(canvas, "drawn");

    await page.locator("#auto-mask-button").click();
    await expect(page.locator("#mask-bar")).toBeVisible();
    await page.keyboard.press("2");
    await expect(swatch(page, "ピンク")).toHaveAttribute("aria-pressed", "true");
    await expect(swatch(page, "赤")).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    expect(await diffFromSnapshot(canvas, "drawn")).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});
