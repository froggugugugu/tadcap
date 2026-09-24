//! E2Eテスト: オブジェクト層(T32、PRD FR-006 オブジェクト共通基準・FR-008/FR-014改訂)。
//!
//! 確定後の再調整(選択→移動・リサイズ)、取り消し、上限50個の焼き込み、コピー結果にハンドルが
//! 写らないこと、モザイク・テキストがオブジェクトより下(ベース)に効くことを検証する。
//! 状態遷移そのものは`documentState.test.ts`/`commands.test.ts`/`objectModel.test.ts`で検証済み。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { diffFromSnapshot, saveSnapshot } from "./fixtures/canvasSnapshot";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  getClipboardImageStats,
  getClipboardWriteCount,
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "./fixtures/tauriMock";

const sampleCaptureResult: MockCaptureResult = {
  id: "e2e-object-layer-1",
  sourcePath: "/tmp/tadcap-captures/e2e-object-layer-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

type RGB = { r: number; g: number; b: number };
type Region = { x: number; y: number; width: number; height: number };

/** 注釈の既定色(#FF5C8A)。 */
const PINK: RGB = { r: 255, g: 92, b: 138 };
const BLUE: RGB = { r: 0, g: 122, b: 255 };
const COLOR_TOLERANCE = 40;

async function countColorPixels(canvas: Locator, region: Region, target: RGB = PINK): Promise<number> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, args: { region: Region; target: RGB; tol: number }) => {
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
    { region, target, tol: COLOR_TOLERANCE },
  );
}

/** オーバーレイ(選択ハンドル)に不透明な画素があるか。 */
async function overlayHasHandles(page: Page): Promise<boolean> {
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

/** Canvasピクセル座標をビューポート座標へ変換する。 */
async function toViewport(canvas: Locator, p: [number, number]): Promise<[number, number]> {
  const box = await canvas.boundingBox();
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }));
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  return [box.x + (p[0] * box.width) / size.w, box.y + (p[1] * box.height) / size.h];
}

async function drag(page: Page, canvas: Locator, from: [number, number], to: [number, number], steps = 6): Promise<void> {
  const [fx, fy] = await toViewport(canvas, from);
  const [tx, ty] = await toViewport(canvas, to);
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps });
  await page.mouse.up();
}

async function click(page: Page, canvas: Locator, at: [number, number]): Promise<void> {
  const [x, y] = await toViewport(canvas, at);
  await page.mouse.click(x, y);
}

test.describe("オブジェクト層(T32)", () => {
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

  test("描いて確定した矢印を後から選んで移動・リサイズでき、取り消しで元に戻る", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await page.getByRole("button", { name: "矢印" }).click();
    await drag(page, canvas, [40, 150], [200, 150]);
    // 別の図形を描き、ツール切替も挟む(T31ではこの時点で矢印は焼き込まれ編集できなかった)。
    await page.getByRole("button", { name: "矩形" }).click();
    await drag(page, canvas, [230, 20], [280, 60]);
    await page.getByRole("button", { name: "矩形" }).click(); // ツール未選択へ
    expect(await overlayHasHandles(page)).toBe(false);
    await saveSnapshot(canvas, "beforeEdit");

    // 胴体をクリックして選択 → そのままドラッグで上へ移動。
    await click(page, canvas, [120, 150]);
    expect(await overlayHasHandles(page)).toBe(true);
    await drag(page, canvas, [120, 150], [120, 60]);
    expect(await countColorPixels(canvas, { x: 90, y: 50, width: 60, height: 20 })).toBeGreaterThan(0);
    expect(await countColorPixels(canvas, { x: 90, y: 140, width: 60, height: 20 })).toBe(0);

    // 終点ハンドル(200,60)を下へドラッグしてリサイズ(始点は固定)。
    await drag(page, canvas, [200, 60], [200, 180]);
    expect(await countColorPixels(canvas, { x: 185, y: 150, width: 25, height: 40 })).toBeGreaterThan(0);
    expect(await countColorPixels(canvas, { x: 36, y: 50, width: 16, height: 20 })).toBeGreaterThan(0);

    // 取り消し2回(リサイズ・移動)で編集前とバイト一致。矩形は残っている。
    await page.keyboard.press("Meta+Z");
    await page.keyboard.press("Meta+Z");
    expect(await diffFromSnapshot(canvas, "beforeEdit")).toBe(0);
    expect(await countColorPixels(canvas, { x: 225, y: 15, width: 60, height: 50 })).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });

  test("51個目を描くと最古が元画像へ焼き込まれて選べなくなり、1回の取り消しで元に戻る", async ({ page }) => {
    test.setTimeout(60_000);
    const canvas = await captureAndWaitReady(page);
    await page.getByRole("button", { name: "矩形" }).click();

    // 10x10の矩形を30px間隔で並べる(描き始めが既存の枠線に掛からない間隔)。
    const origin = (i: number): [number, number] => [5 + (i % 10) * 30, 5 + Math.floor(i / 10) * 30];
    for (let i = 0; i < 50; i += 1) {
      const [x, y] = origin(i);
      await drag(page, canvas, [x, y], [x + 10, y + 10], 2);
    }
    // 50個目までは最古(左上)も選べる。
    await click(page, canvas, [5, 10]);
    expect(await overlayHasHandles(page)).toBe(true);
    await page.keyboard.press("Escape");
    await saveSnapshot(canvas, "fifty");

    const [x, y] = origin(50);
    await drag(page, canvas, [x, y], [x + 10, y + 10], 2);
    await page.keyboard.press("Escape");
    // 最古は画素として残る(焼き込み)が、クリックしても選べない。
    expect(await countColorPixels(canvas, { x: 3, y: 3, width: 14, height: 14 })).toBeGreaterThan(0);
    await click(page, canvas, [5, 10]);
    expect(await overlayHasHandles(page)).toBe(false);

    // 1回の取り消しで51個目の追加と焼き込みの両方が戻り、最古は再び選べる。
    await page.keyboard.press("Meta+Z");
    expect(await diffFromSnapshot(canvas, "fifty")).toBe(0);
    await click(page, canvas, [5, 10]);
    expect(await overlayHasHandles(page)).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test("選択中(ハンドル表示中)にCmd+Cでコピーしても、コピー結果にハンドルは写らない", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await page.getByRole("button", { name: "円" }).click();
    await drag(page, canvas, [60, 40], [220, 160]);
    expect(await overlayHasHandles(page)).toBe(true);

    await page.keyboard.press("Meta+C");
    await expect(page.locator("#clipboard-status")).toHaveText("クリップボードにコピーしました。");
    expect(await getClipboardWriteCount(page)).toBe(1);
    // キー操作ではポインタが動かないため選択は保たれている(ハンドル表示中のコピー)。
    expect(await overlayHasHandles(page)).toBe(true);

    const stats = await getClipboardImageStats(page, PINK, COLOR_TOLERANCE);
    expect(stats).not.toBeNull();
    expect(stats!.targetColorPixels).toBeGreaterThan(0); // 円(合成結果)は写る。
    expect(stats!.nearWhitePixels).toBe(0); // ハンドル(白塗り)は写らない。
    expect(stats!.equalsCanvas).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test("モザイクは元画像にだけ効き、上にある矩形は隠れない", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await page.getByRole("button", { name: "矩形" }).click();
    await drag(page, canvas, [60, 50], [200, 150]);
    const rectRegion: Region = { x: 55, y: 45, width: 150, height: 110 };
    const before = await countColorPixels(canvas, rectRegion);
    expect(before).toBeGreaterThan(0);
    await saveSnapshot(canvas, "withRect");

    await page.getByRole("button", { name: "モザイク" }).click();
    await drag(page, canvas, [40, 30], [220, 170]);

    expect(await diffFromSnapshot(canvas, "withRect")).toBeGreaterThan(0); // 背景はピクセル化された
    expect(await countColorPixels(canvas, rectRegion)).toBeGreaterThanOrEqual(Math.floor(before * 0.9));

    // 矩形は後から動かせる(モザイクに埋まっていない)。
    await page.getByRole("button", { name: "モザイク" }).click();
    await drag(page, canvas, [61, 100], [101, 100]);
    expect(await countColorPixels(canvas, { x: 236, y: 60, width: 8, height: 80 })).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });

  // 【改訂 2026-09-24 T33】テキストもオブジェクトになり、描いた順の重ね順に入る(T32では元画像へ
  // 焼き込まれ常に矩形より下だった)。後から置いたテキストは矩形の上に描かれ、取り消しで消える。
  test("テキストもオブジェクトとして重ね順に入り、後から置けば矩形より上になる", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await page.getByRole("button", { name: "矩形" }).click();
    await drag(page, canvas, [40, 60], [200, 140]);
    // 矩形の左辺の帯(テキストが通る高さ)。
    const band: Region = { x: 36, y: 85, width: 10, height: 30 };
    const pinkBefore = await countColorPixels(canvas, band);
    expect(pinkBefore).toBeGreaterThan(0);
    await saveSnapshot(canvas, "withRect");

    await page.getByRole("button", { name: "テキスト" }).click();
    await page.getByRole("button", { name: "青" }).click();
    await click(page, canvas, [15, 100]);
    await expect(page.getByRole("textbox", { name: "テキスト入力" })).toBeFocused();
    await page.keyboard.type("MMMMMMMM");
    await page.keyboard.press("Enter");

    // 左辺の上に青い文字が重なり、矩形の色の画素が減る(テキストが上)。
    expect(await countColorPixels(canvas, band, BLUE)).toBeGreaterThan(0);
    expect(await countColorPixels(canvas, band)).toBeLessThan(pinkBefore);
    // 取り消し1回(テキストの追加)で矩形だけの状態とバイト一致(元画像へは焼き込まれていない)。
    await page.keyboard.press("Meta+Z");
    expect(await diffFromSnapshot(canvas, "withRect")).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});
