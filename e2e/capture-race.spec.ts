//! E2Eテスト: ドラッグ中に非同期でCanvasが差し替えられるケースの回帰テスト
//! (MUST-1、コードレビュー`output/reports/review/REVIEW_tadcap_mvp.md`2026-09-24)。
//!
//! `bindArrowTool()`/`bindMosaicTool()`はDOM/Canvas APIに直接依存するため
//! Vitest(Node、DOM無し)では自動テスト対象外(`src/canvas/tools/arrowTool.ts`
//! モジュールdoc参照)。修正の核である判定ロジック(`canvasState.ts::isSameCanvasImage()`)は
//! `canvasState.test.ts`がユニットテストするが、実際の`pointerdown`〜`pointerup`の
//! DOM結線が正しく機能することは本ファイルで検証する。
//!
//! 再現条件(レビューの記述どおり): (1)矢印ツールでCanvas上をpointerdownしたまま、
//! (2)別経路のキャプチャ完了(グローバルショートカット相当。ここでは
//! `window.__TAURI_INTERNALS__.invoke("capture_screen")`を直接呼び、マウスボタンの
//! 状態と独立に発火させる)、(3)その後pointerupでドラッグを終了する。
//! 修正前は、古い(サイズ・内容とも別画像時点の)snapshotを新しい画像の上に
//! 上書きしたうえで矢印を焼き込んでしまう。修正後は、画像の差し替えを検知して
//! ドラッグを中断し、新しい画像はそのまま(無編集)で残るべき。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "./fixtures/tauriMock";

/** 1枚目(既定配色: 緑寄り/青寄り)。300×200。 */
const firstCaptureResult: MockCaptureResult = {
  id: "e2e-race-capture-1",
  sourcePath: "/tmp/tadcap-captures/e2e-race-capture-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

/** 2枚目(1枚目・矢印色のいずれとも混同しない配色: 黄色寄り/黒寄り)。150×100。 */
const secondCaptureResult: MockCaptureResult = {
  id: "e2e-race-capture-2",
  sourcePath: "/tmp/tadcap-captures/e2e-race-capture-2.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:01.000Z",
};
const SECOND_WIDTH = 150;
const SECOND_HEIGHT = 100;
const SECOND_TILE_SIZE = 6;
const SECOND_COLOR_A: [number, number, number, number] = [250, 210, 40, 255];
const SECOND_COLOR_B: [number, number, number, number] = [15, 15, 15, 255];

/** 矢印の既定色(`styles.css` `--arrow-color`)。RGB。 */
const ARROW_COLOR = { r: 255, g: 92, b: 138 };
const COLOR_TOLERANCE = 40;

/** Canvas全体を走査し、矢印色に近い画素が1つでもあるかを判定する。 */
async function hasArrowColoredPixelAnywhere(canvas: Locator): Promise<boolean> {
  return canvas.evaluate((canvasEl: HTMLCanvasElement, target) => {
    const ctx = canvasEl.getContext("2d");
    if (!ctx) {
      return false;
    }
    const { data } = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
    for (let i = 0; i < data.length; i += 4) {
      const dr = Math.abs(data[i] - target.r);
      const dg = Math.abs(data[i + 1] - target.g);
      const db = Math.abs(data[i + 2] - target.b);
      if (dr <= target.tolerance && dg <= target.tolerance && db <= target.tolerance) {
        return true;
      }
    }
    return false;
  }, { ...ARROW_COLOR, tolerance: COLOR_TOLERANCE });
}

/**
 * Canvas全体が、指定したチェッカーボード配色(`sampleCapturePng.ts`と同じ生成式)と
 * 一致しているか(=1枚目のsnapshotで汚染されていないか)を判定する。
 */
async function matchesCheckerboard(
  canvas: Locator,
  params: {
    width: number;
    height: number;
    tileSize: number;
    colorA: [number, number, number, number];
    colorB: [number, number, number, number];
  },
): Promise<boolean> {
  return canvas.evaluate((canvasEl: HTMLCanvasElement, p) => {
    const ctx = canvasEl.getContext("2d");
    if (!ctx) {
      return false;
    }
    if (canvasEl.width !== p.width || canvasEl.height !== p.height) {
      return false;
    }
    const { data } = ctx.getImageData(0, 0, p.width, p.height);
    for (let y = 0; y < p.height; y += 5) {
      for (let x = 0; x < p.width; x += 5) {
        const tileX = Math.floor(x / p.tileSize);
        const tileY = Math.floor(y / p.tileSize);
        const expected = (tileX + tileY) % 2 === 0 ? p.colorA : p.colorB;
        const idx = (y * p.width + x) * 4;
        if (
          data[idx] !== expected[0] ||
          data[idx + 1] !== expected[1] ||
          data[idx + 2] !== expected[2]
        ) {
          return false;
        }
      }
    }
    return true;
  }, params);
}

async function invokeCaptureScreen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
    };
    return w.__TAURI_INTERNALS__.invoke("capture_screen");
  });
}

test.describe("MUST-1回帰: ドラッグ中の非同期Canvas差し替え", () => {
  const firstPng = createFixtureCapturePng();
  const secondPng = createFixtureCapturePng(
    SECOND_WIDTH,
    SECOND_HEIGHT,
    SECOND_COLOR_A,
    SECOND_COLOR_B,
  );

  let pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    await routeCrossOriginAssets(page, firstPng);
    pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        pageErrors.push(msg.text());
      }
    });
  });

  test(
    "矢印ドラッグ中に別経路のキャプチャが完了しても、古い画像が新しい画像に焼き込まれず、" +
      "ドラッグは中断される",
    async ({ page }) => {
      await installTauriMocks(page, {
        initialPermissionState: "granted",
        capture: { kind: "success", result: firstCaptureResult },
        captureImageBase64: firstPng.toString("base64"),
        secondCapture: {
          result: secondCaptureResult,
          captureImageBase64: secondPng.toString("base64"),
        },
      });
      await page.goto("/");

      // 1. 1枚目をキャプチャ(300x200)。
      await page.getByRole("button", { name: "キャプチャ" }).click();
      const canvas = page.locator("#capture-canvas");
      await page.waitForFunction(() => {
        const el = document.querySelector<HTMLCanvasElement>("#capture-canvas");
        return !!el && el.width === 300 && el.height === 200;
      });

      // 2. 矢印ツールへ切替 → Canvas上でpointerdownしたまま保持する。
      await page.getByRole("button", { name: "矢印" }).click();
      const box = await canvas.boundingBox();
      if (!box) {
        throw new Error("#capture-canvas is not visible");
      }
      const start = { x: box.x + 30, y: box.y + 150 };
      const mid = { x: box.x + 150, y: box.y + 150 };

      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(mid.x, mid.y, { steps: 4 });

      // プレビューが描かれていること(通常のドラッグとして開始できている確認)。
      expect(await hasArrowColoredPixelAnywhere(canvas)).toBe(true);

      // 3. マウスボタンを離さないまま、別経路(グローバルショートカット相当)の
      //    キャプチャ完了を発火させる(2枚目、150x100、別配色)。
      await invokeCaptureScreen(page);
      await page.waitForFunction(
        ({ width, height }) => {
          const el = document.querySelector<HTMLCanvasElement>("#capture-canvas");
          return !!el && el.width === width && el.height === height;
        },
        { width: SECOND_WIDTH, height: SECOND_HEIGHT },
      );

      // 4. 差し替え後にもう一度動かしてからpointerupでドラッグを終了する
      //    (pointermove側・finishDrag側の両方の中断経路を通す)。
      await page.mouse.move(mid.x + 10, mid.y + 5, { steps: 2 });
      await page.mouse.up();

      // 検証: Canvasは2枚目のサイズ・ピクセルのまま(1枚目のsnapshotで汚染されていない)。
      await expect
        .poll(() =>
          matchesCheckerboard(canvas, {
            width: SECOND_WIDTH,
            height: SECOND_HEIGHT,
            tileSize: SECOND_TILE_SIZE,
            colorA: SECOND_COLOR_A,
            colorB: SECOND_COLOR_B,
          }),
        )
        .toBe(true);

      // 矢印は焼き込まれていない(ドラッグは中断され確定描画されなかった)。
      expect(await hasArrowColoredPixelAnywhere(canvas)).toBe(false);

      // 履歴には2件追加され、2枚目が選択されている。
      await expect(page.locator(".history-sidebar__item")).toHaveCount(2);
      await expect(page.locator(".history-sidebar__item--selected")).toHaveCount(1);

      expect(pageErrors).toEqual([]);
    },
  );
});
