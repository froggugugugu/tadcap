//! E2Eテスト: キャプチャ→矢印/モザイク編集→クリップボードコピー→履歴表示のフロー(T13)。
//!
//! ARCH §10 決定#4により、Tauriランタイムは起動せずVite dev server上のページを chromium で
//! 開き、`e2e/fixtures/tauriMock.ts` でTauri IPCをモックする(OSネイティブ導線
//! (`screencapture` 実起動・実クリップボード・実権限ダイアログ)は対象外)。
//!
//! T14申し送り(履歴サイドバーのセレクタ)を踏襲する:
//! `#history-sidebar` / `.history-sidebar__list` / `.history-sidebar__thumbnail-button`
//! (`aria-pressed`) / `.history-sidebar__item--selected`。

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
  id: "e2e-capture-1",
  sourcePath: "/tmp/tadcap-captures/e2e-capture-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

/** 矢印の既定色(`styles.css` `--arrow-color`)。RGB。 */
const ARROW_COLOR = { r: 255, g: 92, b: 138 };
/** 色比較の許容誤差(アンチエイリアシング・線幅の丸め差を吸収する)。 */
const COLOR_TOLERANCE = 40;

/** Canvas上の1点(px)のRGBAを読み取る。 */
async function readCanvasPixel(
  canvas: Locator,
  point: [number, number],
): Promise<[number, number, number, number]> {
  return canvas.evaluate((canvasEl: HTMLCanvasElement, [x, y]: [number, number]) => {
    const ctx = canvasEl.getContext("2d");
    if (!ctx) {
      throw new Error("2D context not available");
    }
    const data = ctx.getImageData(x, y, 1, 1).data;
    return [data[0], data[1], data[2], data[3]] as [
      number,
      number,
      number,
      number,
    ];
  }, point);
}

/** Canvas上の矩形領域内に、矢印の既定色に近い画素が1つでもあるかを判定する。 */
async function hasArrowColoredPixel(
  canvas: Locator,
  region: { x: number; y: number; width: number; height: number },
): Promise<boolean> {
  return canvas.evaluate(
    (
      canvasEl: HTMLCanvasElement,
      args: {
        region: { x: number; y: number; width: number; height: number };
        target: { r: number; g: number; b: number };
        tolerance: number;
      },
    ) => {
      const ctx = canvasEl.getContext("2d");
      if (!ctx) {
        return false;
      }
      const { region, target, tolerance } = args;
      const { data } = ctx.getImageData(
        region.x,
        region.y,
        region.width,
        region.height,
      );
      for (let i = 0; i < data.length; i += 4) {
        const dr = Math.abs(data[i] - target.r);
        const dg = Math.abs(data[i + 1] - target.g);
        const db = Math.abs(data[i + 2] - target.b);
        if (dr <= tolerance && dg <= tolerance && db <= tolerance) {
          return true;
        }
      }
      return false;
    },
    { region, target: ARROW_COLOR, tolerance: COLOR_TOLERANCE },
  );
}

/** キャンバスのビューポート座標での矩形をドラッグする(pointerdown/move/up)。 */
async function dragOnCanvas(
  page: Page,
  canvas: Locator,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  const start = { x: box.x + from[0], y: box.y + from[1] };
  const end = { x: box.x + to[0], y: box.y + to[1] };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

test.describe("キャプチャ→編集→クリップボードコピー→履歴表示のフロー", () => {
  const fixturePng = createFixtureCapturePng();
  const captureImageBase64 = fixturePng.toString("base64");
  /** ページ内の未捕捉例外・console.error(Canvas汚染の `SecurityError` 等)。 */
  let pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    // 実機と同じく、asset URL は webview と別オリジンから配信する
    // (tauriMock.ts「画像の配信経路」参照。実機不具合②〜⑤の再発防止)。
    await routeCrossOriginAssets(page, fixturePng);
    pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        pageErrors.push(msg.text());
      }
    });
  });

  test("キャプチャ→矢印描画→モザイク適用→クリップボードコピーで履歴に1件表示・選択される", async ({
    page,
  }) => {
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: sampleCaptureResult },
      captureImageBase64,
    });
    await page.goto("/");

    // 1. キャプチャ開始 → capture://completed 受信 → Canvasに画像表示。
    // T30: 「canvas.width > 0」待ちはCanvas既定サイズ(300x150)でも成立してしまう競合が
    // あるため(T29申し送り)、コピーボタン有効化+履歴反映を待つ共通ヘルパーに置き換えた。
    const canvas = await captureAndWaitReady(page);

    // 履歴サイドバーに1件追加され、選択状態になる(T14申し送りのセレクタ)。
    await expect(page.locator(".history-sidebar__item")).toHaveCount(1);
    await expect(page.locator(".history-sidebar__item--selected")).toHaveCount(
      1,
    );
    await expect(
      page.locator(".history-sidebar__thumbnail-button"),
    ).toHaveAttribute("aria-pressed", "true");

    // 2. 矢印ツールへ切替 → ドラッグ。
    const arrowButton = page.getByRole("button", { name: "矢印" });
    await arrowButton.click();
    await expect(arrowButton).toHaveAttribute("aria-pressed", "true");

    await dragOnCanvas(page, canvas, [30, 150], [250, 150]);

    // 矢印の既定色(#FF5C8A)付近の画素があることを検証する(壊れにくい判定、T13タスク指示)。
    const arrowDrawn = await hasArrowColoredPixel(canvas, {
      x: 100,
      y: 130,
      width: 100,
      height: 40,
    });
    expect(arrowDrawn).toBe(true);

    // 3. モザイクツールへ切替(排他: 矢印は選択解除される)→ ドラッグ。
    const mosaicButton = page.getByRole("button", { name: "モザイク" });
    await mosaicButton.click();
    await expect(mosaicButton).toHaveAttribute("aria-pressed", "true");
    await expect(arrowButton).toHaveAttribute("aria-pressed", "false");

    const mosaicSamplePoint: [number, number] = [100, 60];
    const beforeMosaicPixel = await readCanvasPixel(canvas, mosaicSamplePoint);

    await dragOnCanvas(page, canvas, [60, 20], [140, 100]);

    const afterMosaicPixel = await readCanvasPixel(canvas, mosaicSamplePoint);
    // モザイク前後でピクセルが変化していること(フィクスチャ画像はチェッカーボードのため
    // ブロック平均により必ず混色する。sampleCapturePng.tsのモジュールdoc参照)。
    expect(afterMosaicPixel).not.toEqual(beforeMosaicPixel);

    // 4. クリップボードにコピー。
    const clipboardButton = page.getByRole("button", {
      name: "クリップボードにコピー",
    });
    await expect(clipboardButton).toBeEnabled();
    await clipboardButton.click();

    await expect(page.locator("#clipboard-status")).toHaveText(
      "クリップボードにコピーしました。",
    );
    expect(await getClipboardWriteCount(page)).toBe(1);

    // 履歴は引き続き1件・選択状態のまま(コピー成功時は選択中項目の画像を上書きするのみ、T14)。
    await expect(page.locator(".history-sidebar__item")).toHaveCount(1);
    await expect(page.locator(".history-sidebar__item--selected")).toHaveCount(
      1,
    );

    // 実機不具合②〜⑤の再発防止: 読込失敗表示・Canvas汚染の例外が一度も出ていないこと。
    await expect(page.locator("#capture-status")).not.toHaveText(
      "画像の表示に失敗しました。",
    );
    expect(pageErrors).toEqual([]);
  });

  test("画面収録権限が未許可(permission_denied)の場合、キャプチャ実行時に権限バナーが表示される", async ({
    page,
  }) => {
    await installTauriMocks(page, {
      // 起動時チェックは許可済みにし、ボタンのinvoke reject経路(入口1)を専用で検証する。
      initialPermissionState: "granted",
      capture: { kind: "permissionDenied" },
      captureImageBase64,
    });
    await page.goto("/");

    const banner = page.locator(".permission-banner");
    // T13で発見した不具合(project-config.md §11参照): `src/styles.css`の
    // `.permission-banner { display: flex; ... }` がUAスタイルシートの
    // `[hidden] { display: none }` を上書きしてしまい、`hidden`属性を設定しても
    // バナーが常に可視状態になっていた。T19で `[hidden] { display: none !important; }`
    // を追加して修正したため、この行は現在passする。
    await expect(banner).toBeHidden();

    await page.getByRole("button", { name: "キャプチャ" }).click();

    await expect(banner).toBeVisible();
    await expect(banner).toContainText("画面収録の権限が許可されていません。");
    await expect(page.locator("#capture-status")).toHaveText(
      "画面収録の権限が必要です。",
    );
  });
});
