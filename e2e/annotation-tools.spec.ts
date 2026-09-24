//! E2Eテスト: 追加機能(T20〜T29)の横断フロー(T30、PRD FR-006/007/011〜014)。
//!
//! `tool-settings.spec.ts`(T28)・`undo-redo.spec.ts`(T29)・`shape-edit.spec.ts`(T31)・
//! `text-tool.spec.ts`(T27)がそれぞれの機能単体を検証しているのに対し、本ファイルは
//! 「色を変えながら複数ツールで描く」「全ツールを混ぜてからUndo/Redo」「コピー結果の検証」
//! 「新規キャプチャ後の履歴反映」というツール横断のユーザーフローのみを対象にし、
//! 既存specと同じ観点は重複させない(T30タスク指示)。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { diffFromSnapshot, saveSnapshot } from "./fixtures/canvasSnapshot";
import { captureAndWaitReady } from "./fixtures/captureReady";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  getClipboardImageStats,
  getClipboardWriteCount,
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "./fixtures/tauriMock";

const firstCaptureResult: MockCaptureResult = {
  id: "e2e-annotation-tools-1",
  sourcePath: "/tmp/tadcap-captures/e2e-annotation-tools-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

/** 新規キャプチャの反映を検証するテスト専用(id/サイズ/配色とも1枚目と異なる)。 */
const secondCaptureResult: MockCaptureResult = {
  id: "e2e-annotation-tools-2",
  sourcePath: "/tmp/tadcap-captures/e2e-annotation-tools-2.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:01.000Z",
};

/** プリセット6色(`src/ui/colorPicker.ts::COLOR_PRESETS`と一致させる)。ピンクは既定色のため未使用。 */
const RED = { r: 255, g: 59, b: 48 };
const ORANGE = { r: 255, g: 149, b: 0 };
const YELLOW = { r: 255, g: 204, b: 0 };
const GREEN = { r: 52, g: 199, b: 89 };
const BLUE = { r: 0, g: 122, b: 255 };
const COLOR_TOLERANCE = 40;

type Region = { x: number; y: number; width: number; height: number };
type RGB = { r: number; g: number; b: number };

/** Canvas上の矩形領域(Canvasピクセル)に、指定色に近い画素が何個あるか。 */
async function countColorPixels(canvas: Locator, region: Region, target: RGB, tol = COLOR_TOLERANCE): Promise<number> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, args: { region: Region; target: RGB; tol: number }) => {
      const ctx = el.getContext("2d");
      if (!ctx) {
        return 0;
      }
      const { data } = ctx.getImageData(args.region.x, args.region.y, args.region.width, args.region.height);
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
    { region, target, tol },
  );
}

/** オーバーレイ(編集中図形のハンドル)に不透明な画素があるか(`shape-edit.spec.ts`と同じ判定)。 */
async function overlayHasHandles(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const overlay = document.querySelector<HTMLCanvasElement>(".shape-overlay");
    if (!overlay || overlay.hidden) {
      return false;
    }
    const ctx = overlay.getContext("2d");
    if (!ctx) {
      return false;
    }
    const { data } = ctx.getImageData(0, 0, overlay.width, overlay.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) {
        return true;
      }
    }
    return false;
  });
}

/** Canvas上の点(Canvasピクセル座標)をビューポート座標へ変換して、from→toをドラッグする。 */
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

/** Canvas上の点(Canvasピクセル座標)をクリックしてテキスト入力欄を開く。 */
async function openTextAt(page: Page, canvas: Locator, point: [number, number]): Promise<Locator> {
  const box = await canvas.boundingBox();
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }));
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  const sx = box.width / size.w;
  const sy = box.height / size.h;
  await page.mouse.click(box.x + point[0] * sx, box.y + point[1] * sy);
  const input = page.getByRole("textbox", { name: "テキスト入力" });
  await expect(input).toBeFocused();
  return input;
}

async function selectTool(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
}

/** 色プリセットのボタンを選ぶ。「赤」など短い名前は他要素との部分一致を避け`exact: true`で指定する。 */
async function selectColor(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
}

/** `.history-sidebar__thumbnail`(<img>)に指定色に近い画素があるか(履歴サムネイル検証用)。 */
async function thumbnailHasColor(thumbnail: Locator, target: RGB, tol = COLOR_TOLERANCE): Promise<boolean> {
  return thumbnail.evaluate((img: HTMLImageElement, args: { target: RGB; tol: number }) => {
    return new Promise<boolean>((resolve) => {
      const check = (): void => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx || canvas.width === 0 || canvas.height === 0) {
          resolve(false);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < data.length; i += 4) {
          if (
            Math.abs(data[i] - args.target.r) <= args.tol &&
            Math.abs(data[i + 1] - args.target.g) <= args.tol &&
            Math.abs(data[i + 2] - args.target.b) <= args.tol
          ) {
            resolve(true);
            return;
          }
        }
        resolve(false);
      };
      if (img.complete) {
        check();
      } else {
        img.onload = check;
      }
    });
  }, { target, tol });
}

test.describe("追加機能(T20〜T29)の横断フロー(T30)", () => {
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

  test("色を変えながら矢印・矩形・円・テキストを描くと、それぞれの領域に選んだ色の画素があり、モザイクは色の影響を受けない", async ({
    page,
  }) => {
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: firstCaptureResult },
      captureImageBase64: fixturePng.toString("base64"),
    });
    await page.goto("/");
    const canvas = await captureAndWaitReady(page);

    // 矢印: 赤。
    await selectTool(page, "矢印");
    await selectColor(page, "赤");
    await drag(page, canvas, [10, 15], [100, 15]);
    expect(await countColorPixels(canvas, { x: 5, y: 0, width: 110, height: 35 }, RED)).toBeGreaterThan(0);

    // 矩形: 橙(矢印はツール切替で確定済み)。
    await selectTool(page, "矩形");
    await selectColor(page, "橙");
    await drag(page, canvas, [125, 10], [195, 60]);
    expect(await countColorPixels(canvas, { x: 120, y: 5, width: 80, height: 60 }, ORANGE)).toBeGreaterThan(0);

    // 円: 緑(矩形はツール切替で確定済み)。
    await selectTool(page, "円");
    await selectColor(page, "緑");
    await drag(page, canvas, [210, 10], [285, 70]);
    expect(await countColorPixels(canvas, { x: 205, y: 5, width: 85, height: 70 }, GREEN)).toBeGreaterThan(0);

    // テキスト: 青(円はツール切替で確定済み)。
    await selectTool(page, "テキスト");
    await selectColor(page, "青");
    await openTextAt(page, canvas, [40, 120]);
    await page.keyboard.type("Hi");
    await page.keyboard.press("Enter");
    expect(await countColorPixels(canvas, { x: 25, y: 95, width: 120, height: 55 }, BLUE)).toBeGreaterThan(0);

    // モザイク: 黄を選んだ状態で適用しても、モザイクの結果には選択色が使われない
    // (`mosaicTool.ts`はブロック平均のみで`toolSettings.color`を参照しない)。
    await selectTool(page, "モザイク");
    await selectColor(page, "黄");
    const mosaicRegion: Region = { x: 195, y: 145, width: 90, height: 50 };
    const beforePixel = await canvas.evaluate(
      (el: HTMLCanvasElement, p: { x: number; y: number }) =>
        Array.from(el.getContext("2d")!.getImageData(p.x, p.y, 1, 1).data),
      { x: 240, y: 170 },
    );
    await drag(page, canvas, [200, 150], [280, 195]);
    const afterPixel = await canvas.evaluate(
      (el: HTMLCanvasElement, p: { x: number; y: number }) =>
        Array.from(el.getContext("2d")!.getImageData(p.x, p.y, 1, 1).data),
      { x: 240, y: 170 },
    );
    expect(afterPixel).not.toEqual(beforePixel);
    expect(await countColorPixels(canvas, mosaicRegion, YELLOW)).toBe(0);

    expect(pageErrors).toEqual([]);
  });

  test("矢印→矩形(リサイズ・移動)→円→テキスト→モザイクを混ぜた後、Cmd+Zの連打で元画像とバイト一致、Cmd+Shift+Zの連打で最終状態と一致", async ({
    page,
  }) => {
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: firstCaptureResult },
      captureImageBase64: fixturePng.toString("base64"),
    });
    await page.goto("/");
    const canvas = await captureAndWaitReady(page);
    await saveSnapshot(canvas, "original");

    // 1. 矢印。
    await selectTool(page, "矢印");
    await drag(page, canvas, [20, 150], [90, 150]);

    // 2. 矩形を描いてから、右下ハンドルでリサイズ→内側ドラッグで移動(ツール切替で確定、T31)。
    await selectTool(page, "矩形");
    await drag(page, canvas, [110, 20], [170, 60]);
    await drag(page, canvas, [170, 60], [190, 80]); // 右下ハンドルでリサイズ → (110,20)-(190,80)
    await drag(page, canvas, [150, 50], [170, 70]); // 内側ドラッグで+20,+20移動 → (130,40)-(210,100)

    // 3. 円(矩形はツール切替で確定済み)。
    await selectTool(page, "円");
    await drag(page, canvas, [220, 20], [280, 70]);

    // 4. テキスト(円はツール切替で確定済み)。Enterで確定。
    await selectTool(page, "テキスト");
    await openTextAt(page, canvas, [30, 90]);
    await page.keyboard.type("Ab");
    await page.keyboard.press("Enter");

    // 5. モザイク(即焼き込み)。
    await selectTool(page, "モザイク");
    await drag(page, canvas, [200, 120], [270, 170]);

    await saveSnapshot(canvas, "edited");
    expect(await diffFromSnapshot(canvas, "original")).toBeGreaterThan(0);
    expect(await overlayHasHandles(page)).toBe(false);

    // 5操作(矢印・矩形[リサイズ+移動]・円・テキスト・モザイク)ぶん、Cmd+Zで1つずつ元へ戻る。
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press("Meta+Z");
    }
    expect(await diffFromSnapshot(canvas, "original")).toBe(0);
    await expect(page.getByRole("button", { name: "取り消し" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "やり直し" })).toBeEnabled();

    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press("Meta+Shift+Z");
    }
    expect(await diffFromSnapshot(canvas, "edited")).toBe(0);
    await expect(page.getByRole("button", { name: "やり直し" })).toBeDisabled();

    expect(pageErrors).toEqual([]);
  });

  test("描いた後にコピーすると、コピー結果がCanvasと一致しハンドルや入力欄は写らない", async ({ page }) => {
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: firstCaptureResult },
      captureImageBase64: fixturePng.toString("base64"),
    });
    await page.goto("/");
    const canvas = await captureAndWaitReady(page);

    // 矢印(ツール切替で確定)→ 矩形(編集中のまま、ツール切替を挟まずに直接コピー)。
    await selectTool(page, "矢印");
    await selectColor(page, "赤");
    await drag(page, canvas, [20, 150], [90, 150]);
    await selectTool(page, "矩形");
    await selectColor(page, "橙");
    await drag(page, canvas, [110, 20], [180, 70]);
    expect(await overlayHasHandles(page)).toBe(true);

    await page.getByRole("button", { name: "クリップボードにコピー" }).click();
    await expect(page.locator("#clipboard-status")).toHaveText("クリップボードにコピーしました。");
    expect(await getClipboardWriteCount(page)).toBe(1);

    // コピー直前に編集中の矩形が確定され、ハンドルは消える。
    expect(await overlayHasHandles(page)).toBe(false);
    const firstStats = await getClipboardImageStats(page, RED, COLOR_TOLERANCE);
    expect(firstStats).not.toBeNull();
    expect(firstStats!.targetColorPixels).toBeGreaterThan(0); // 矢印(赤)が焼き込まれて写る。
    expect(firstStats!.nearWhitePixels).toBe(0); // ハンドル(白塗り)は写らない。
    expect(firstStats!.equalsCanvas).toBe(true);

    // テキスト。入力欄を開いたまま(Enterを押さない)コピーする。
    await selectTool(page, "テキスト");
    await selectColor(page, "青");
    const input = await openTextAt(page, canvas, [30, 120]);
    await page.keyboard.type("Zz");
    await expect(input).toBeVisible();

    await page.getByRole("button", { name: "クリップボードにコピー" }).click();
    await expect(page.locator("#clipboard-status")).toHaveText("クリップボードにコピーしました。");
    expect(await getClipboardWriteCount(page)).toBe(2);

    // コピー直前に入力中のテキストが確定され、入力欄(枠線)は消える。
    await expect(input).toHaveCount(0);
    const secondStats = await getClipboardImageStats(page, BLUE, COLOR_TOLERANCE);
    expect(secondStats).not.toBeNull();
    expect(secondStats!.targetColorPixels).toBeGreaterThan(0); // テキスト(青)が焼き込まれて写る。
    expect(secondStats!.nearWhitePixels).toBe(0); // 入力欄の枠(白の点線)は写らない。
    expect(secondStats!.equalsCanvas).toBe(true);

    expect(pageErrors).toEqual([]);
  });

  test("描いた後に新規キャプチャすると、直前の履歴サムネイルに描いた内容が反映され、取り消し・やり直しは空になる", async ({
    page,
  }) => {
    const secondPng = createFixtureCapturePng(220, 160, [240, 240, 20, 255], [10, 10, 10, 255]);
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: firstCaptureResult },
      captureImageBase64: fixturePng.toString("base64"),
      secondCapture: {
        result: secondCaptureResult,
        captureImageBase64: secondPng.toString("base64"),
      },
    });
    await page.goto("/");

    // 1枚目をキャプチャし、赤い矢印を描いて確定する。
    const canvas = await captureAndWaitReady(page);
    await selectTool(page, "矢印");
    await selectColor(page, "赤");
    await drag(page, canvas, [20, 100], [200, 100]);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "取り消し" })).toBeEnabled();

    // 2枚目をキャプチャする(`captureAndWaitReady`は「キャプチャ」ボタンのクリックと、
    // 履歴件数が指定値に達するまでの待機を兼ねる)。
    await captureAndWaitReady(page, 2);

    await expect(page.locator(".history-sidebar__item")).toHaveCount(2);
    // 新しい項目が先頭(選択中)、直前の項目は2番目に押し出される(`historyStore.ts`仕様)。
    await expect(page.locator(".history-sidebar__item--selected")).toHaveCount(1);
    const previousThumbnail = page
      .locator(".history-sidebar__item")
      .nth(1)
      .locator(".history-sidebar__thumbnail");
    expect(await thumbnailHasColor(previousThumbnail, RED, COLOR_TOLERANCE)).toBe(true);

    // 取り消し対象は常に「現在表示中の画像」に限定されるため、差し替え後は空になる
    // (T24申し送り・T29実装)。
    await expect(page.getByRole("button", { name: "取り消し" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "やり直し" })).toBeDisabled();

    expect(pageErrors).toEqual([]);
  });

  test("色・文字サイズ・取り消し/やり直しのaria-labelが期待どおり存在する", async ({ page }) => {
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: firstCaptureResult },
      captureImageBase64: fixturePng.toString("base64"),
    });
    await page.goto("/");
    await captureAndWaitReady(page);

    // 色プリセット。「赤」は単独の一文字ラベルで部分一致の余地があるため`exact: true`で厳密に判定する。
    for (const name of ["ピンク", "赤", "橙", "黄", "緑", "青"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(page.getByLabel("その他の色")).toBeVisible();

    // 文字サイズ。
    for (const name of ["文字サイズ 小", "文字サイズ 中", "文字サイズ 大"]) {
      await expect(page.getByRole("button", { name })).toBeVisible();
    }

    // 取り消し・やり直し(実際のaria-labelはショートカット表記込みだが、部分一致で検証する)。
    await expect(page.getByRole("button", { name: "取り消し" })).toBeVisible();
    await expect(page.getByRole("button", { name: "やり直し" })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
