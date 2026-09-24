//! E2Eテスト: 直前に描いた図形の編集(リサイズ・移動)と確定・破棄(T31、PRD FR-006/007/011改訂)。
//!
//! ハンドルの描画・ポインタ結線(`src/canvas/tools/shapeTools.ts`)はDOM/Canvas依存のため
//! Vitest対象外で、ここで検証する。判定ロジック自体は`shapeEdit.test.ts`/`documentState.test.ts`(T32で`pendingShape.test.ts`から移行)。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  getClipboardImageStats,
  getClipboardWriteCount,
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "./fixtures/tauriMock";

const sampleCaptureResult: MockCaptureResult = {
  id: "e2e-shape-edit-1",
  sourcePath: "/tmp/tadcap-captures/e2e-shape-edit-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

/** 注釈の既定色(#FF5C8A)。 */
const ANNOTATION_COLOR = { r: 255, g: 92, b: 138 };
const COLOR_TOLERANCE = 40;

type Region = { x: number; y: number; width: number; height: number };

/** Canvas上の矩形領域(Canvasピクセル)に注釈色に近い画素が何個あるか。 */
async function countAnnotationPixels(canvas: Locator, region: Region): Promise<number> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, args: { region: Region; target: typeof ANNOTATION_COLOR; tol: number }) => {
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
    { region, target: ANNOTATION_COLOR, tol: COLOR_TOLERANCE },
  );
}

async function countAnnotationPixelsAll(canvas: Locator): Promise<number> {
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }));
  return countAnnotationPixels(canvas, { x: 0, y: 0, width: size.w, height: size.h });
}

/** オーバーレイ(ハンドル)に不透明な画素があるか。 */
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

/** Canvas上の点(Canvasピクセル)をビューポート座標へ変換して、from→toをドラッグする。 */
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

// T30: 「canvas.width > 0」待ちはCanvas既定サイズ(300x150)でも成立してしまう競合があるため
// (T29申し送り)、コピーボタン有効化+履歴反映を待つ共通ヘルパー(fixtures/captureReady.ts)に
// 置き換えた。
async function captureAndSelect(page: Page, toolName: string): Promise<Locator> {
  const canvas = await captureAndWaitReady(page);
  await page.getByRole("button", { name: toolName }).click();
  return canvas;
}

test.describe("直前に描いた図形の編集(T31)", () => {
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

  test("編集中の図形はコピー時に確定されて写り、ハンドルは写らない", async ({ page }) => {
    const canvas = await captureAndSelect(page, "矩形");
    await drag(page, canvas, [40, 40], [160, 120]);

    // 編集中: ハンドルはオーバーレイに表示され、Canvasには図形だけが描かれている。
    expect(await overlayHasHandles(page)).toBe(true);
    expect(await countAnnotationPixelsAll(canvas)).toBeGreaterThan(0);

    await page.getByRole("button", { name: "クリップボードにコピー" }).click();
    await expect(page.locator("#clipboard-status")).toHaveText("クリップボードにコピーしました。");
    expect(await getClipboardWriteCount(page)).toBe(1);

    const stats = await getClipboardImageStats(page, ANNOTATION_COLOR, COLOR_TOLERANCE);
    expect(stats).not.toBeNull();
    // 図形は写る(確定済み)・ハンドル(白塗り)は写らない・Canvasの内容そのもの。
    expect(stats!.targetColorPixels).toBeGreaterThan(0);
    expect(stats!.nearWhitePixels).toBe(0);
    expect(stats!.equalsCanvas).toBe(true);
    // コピーで確定したため編集状態(ハンドル)は解除されている。
    expect(await overlayHasHandles(page)).toBe(false);
    expect(pageErrors).toEqual([]);
  });

  test("矩形の右下ハンドルでリサイズでき、元の位置の辺は残らない", async ({ page }) => {
    const canvas = await captureAndSelect(page, "矩形");
    await drag(page, canvas, [40, 40], [120, 100]);
    expect(await countAnnotationPixels(canvas, { x: 116, y: 60, width: 8, height: 20 })).toBeGreaterThan(0);

    await drag(page, canvas, [120, 100], [200, 160]);

    // 右辺がx=200へ移り、旧右辺(x=120)の位置には残らない。
    expect(await countAnnotationPixels(canvas, { x: 196, y: 110, width: 8, height: 20 })).toBeGreaterThan(0);
    expect(await countAnnotationPixels(canvas, { x: 116, y: 60, width: 8, height: 20 })).toBe(0);
    // 左上は固定。
    expect(await countAnnotationPixels(canvas, { x: 36, y: 60, width: 8, height: 20 })).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });

  test("矢印は胴体ドラッグで移動でき、Enterで確定される", async ({ page }) => {
    const canvas = await captureAndSelect(page, "矢印");
    await drag(page, canvas, [40, 150], [220, 150]);
    expect(await countAnnotationPixels(canvas, { x: 100, y: 140, width: 60, height: 20 })).toBeGreaterThan(0);

    await drag(page, canvas, [130, 150], [130, 60]);

    expect(await countAnnotationPixels(canvas, { x: 100, y: 50, width: 60, height: 20 })).toBeGreaterThan(0);
    expect(await countAnnotationPixels(canvas, { x: 100, y: 140, width: 60, height: 20 })).toBe(0);

    await page.keyboard.press("Enter");
    expect(await overlayHasHandles(page)).toBe(false);
    expect(await countAnnotationPixels(canvas, { x: 100, y: 50, width: 60, height: 20 })).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });

  // 【改訂 2026-09-24 T32】Escは破棄ではなく選択解除になった(図形はオブジェクトとして残り、
  // 取り消しはCmd+Z)。T31の「Escで描く前に戻る」はCmd+Zで確かめる。
  test("Escは選択解除で図形は残り、Cmd+Zで描く前の画像に戻る", async ({ page }) => {
    const canvas = await captureAndSelect(page, "円");
    await drag(page, canvas, [60, 40], [200, 160]);
    expect(await countAnnotationPixelsAll(canvas)).toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    expect(await overlayHasHandles(page)).toBe(false);
    expect(await countAnnotationPixelsAll(canvas)).toBeGreaterThan(0);

    await page.keyboard.press("Meta+Z");
    expect(await countAnnotationPixelsAll(canvas)).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  // 【改訂 2026-09-24 T32】T31では「次の図形で直前の図形は確定され編集できない」だったが、
  // オブジェクト化で両方とも再調整できる。選択されるのは新しい図形で、Cmd+Zは新しい方から戻る。
  test("次の図形を描くと新しい図形が選択され、前の図形も残り、取り消しは新しい方から戻る", async ({ page }) => {
    const canvas = await captureAndSelect(page, "矩形");
    await drag(page, canvas, [20, 20], [80, 70]);
    await drag(page, canvas, [180, 100], [260, 170]);

    expect(await countAnnotationPixels(canvas, { x: 76, y: 30, width: 8, height: 20 })).toBeGreaterThan(0);
    expect(await countAnnotationPixels(canvas, { x: 256, y: 120, width: 8, height: 20 })).toBeGreaterThan(0);
    await page.keyboard.press("Meta+Z");
    expect(await countAnnotationPixels(canvas, { x: 256, y: 120, width: 8, height: 20 })).toBe(0);
    expect(await countAnnotationPixels(canvas, { x: 76, y: 30, width: 8, height: 20 })).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });
});
