//! E2Eテスト: テキストのオブジェクト化(T33、PRD FR-012改訂)。
//!
//! 確定したテキストを後から選択・移動・ダブルクリックで再編集でき、いずれも取り消せることを検証する。
//! 入力欄の基本動作(IME・Esc・空文字・Cmd+C)は`text-tool.spec.ts`、判定ロジックは
//! `textLayout.test.ts`(`decideTextEdit`)・`shapeEdit.test.ts`・`documentState.test.ts`。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { diffFromSnapshot, saveSnapshot } from "./fixtures/canvasSnapshot";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "./fixtures/tauriMock";

const sampleCaptureResult: MockCaptureResult = {
  id: "e2e-text-object-1",
  sourcePath: "/tmp/tadcap-captures/e2e-text-object-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

type Region = { x: number; y: number; width: number; height: number };
/** 注釈の既定色(#FF5C8A)。 */
const PINK = { r: 255, g: 92, b: 138 };
const COLOR_TOLERANCE = 40;
/** クリック位置(40,100)に置いた文字の行(300x200の「中」=18px・行の高さ23px)。 */
const TEXT_ROW: Region = { x: 30, y: 85, width: 150, height: 30 };

async function countPink(canvas: Locator, region: Region): Promise<number> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, args: { region: Region; target: typeof PINK; tol: number }) => {
      const { data } = el
        .getContext("2d")!
        .getImageData(args.region.x, args.region.y, args.region.width, args.region.height);
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
    { region, target: PINK, tol: COLOR_TOLERANCE },
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

async function dblclick(page: Page, canvas: Locator, at: [number, number]): Promise<void> {
  const [x, y] = await toViewport(canvas, at);
  await page.mouse.dblclick(x, y);
}

async function drag(page: Page, canvas: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const [fx, fy] = await toViewport(canvas, from);
  const [tx, ty] = await toViewport(canvas, to);
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 6 });
  await page.mouse.up();
}

/** テキストツールで(40,100)に`text`を置いて確定する。 */
async function placeText(page: Page, canvas: Locator, text: string): Promise<Locator> {
  await page.getByRole("button", { name: "テキスト" }).click();
  await click(page, canvas, [40, 100]);
  const input = page.getByRole("textbox", { name: "テキスト入力" });
  await expect(input).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect(input).toHaveCount(0);
  return input;
}

test.describe("テキストのオブジェクト化(T33)", () => {
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
    });
    await page.goto("/");
  });

  test("テキストツール中に確定済みのテキストをクリックすると選択され(入力欄は開かない)、移動と取り消しができる", async ({
    page,
  }) => {
    const canvas = await captureAndWaitReady(page);
    const input = await placeText(page, canvas, "Hello");
    await page.keyboard.press("Escape"); // 選択解除
    expect(await overlayHasSelection(page)).toBe(false);
    await saveSnapshot(canvas, "placed");
    expect(await countPink(canvas, TEXT_ROW)).toBeGreaterThan(0);

    await click(page, canvas, [55, 100]);
    expect(await overlayHasSelection(page)).toBe(true);
    await expect(input).toHaveCount(0);

    await drag(page, canvas, [55, 100], [55, 160]);
    await expect(input).toHaveCount(0);
    expect(await countPink(canvas, TEXT_ROW)).toBe(0);
    expect(await countPink(canvas, { ...TEXT_ROW, y: 145 })).toBeGreaterThan(0);

    await page.keyboard.press("Meta+Z");
    expect(await diffFromSnapshot(canvas, "placed")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("ダブルクリックで元の文字の入った入力欄が開き、Enterで変更・取り消し/やり直しで往復できる(IME変換中のEnterでは確定しない)", async ({
    page,
  }) => {
    const canvas = await captureAndWaitReady(page);
    const input = await placeText(page, canvas, "Hi");
    await saveSnapshot(canvas, "before");

    await dblclick(page, canvas, [45, 100]);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Hi");
    // 再編集中はオブジェクトを描かない(入力欄と二重に見えない)。
    expect(await countPink(canvas, TEXT_ROW)).toBe(0);

    await page.keyboard.type(" there");
    await input.evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }),
      );
    });
    await expect(input).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(input).toHaveCount(0);
    await saveSnapshot(canvas, "after");
    expect(await diffFromSnapshot(canvas, "before")).toBeGreaterThan(0);
    // 文字が伸びた分、右側にも画素がある。
    expect(await countPink(canvas, { x: 70, y: 85, width: 60, height: 30 })).toBeGreaterThan(0);

    await page.keyboard.press("Meta+Z");
    expect(await diffFromSnapshot(canvas, "before")).toBe(0);
    await page.keyboard.press("Meta+Shift+Z");
    expect(await diffFromSnapshot(canvas, "after")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("再編集中のEscは編集前のまま、空にして確定すると削除され、取り消しで戻る", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await saveSnapshot(canvas, "original");
    const input = await placeText(page, canvas, "Keep");
    await page.keyboard.press("Escape");
    await saveSnapshot(canvas, "placed");

    await dblclick(page, canvas, [50, 100]);
    await expect(input).toHaveValue("Keep");
    await page.keyboard.type("XYZ");
    await page.keyboard.press("Escape");
    await expect(input).toHaveCount(0);
    expect(await diffFromSnapshot(canvas, "placed")).toBe(0);

    await dblclick(page, canvas, [50, 100]);
    await page.keyboard.press("Meta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await expect(input).toHaveCount(0);
    expect(await diffFromSnapshot(canvas, "original")).toBe(0);

    await page.keyboard.press("Meta+Z");
    expect(await diffFromSnapshot(canvas, "placed")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("ツール未選択・図形ツール中でもダブルクリックで再編集でき、モザイク中は開かない", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    const input = await placeText(page, canvas, "Tool");

    await page.getByRole("button", { name: "テキスト" }).click(); // ツール未選択へ
    await dblclick(page, canvas, [50, 100]);
    await expect(input).toHaveValue("Tool");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "矢印" }).click();
    await dblclick(page, canvas, [50, 100]);
    await expect(input).toHaveValue("Tool");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "モザイク" }).click();
    await dblclick(page, canvas, [50, 100]);
    await expect(input).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
