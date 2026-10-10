//! E2E テスト: スポットライト(QE-T16、PRD_quick-edits FR-008〜FR-010、UI_quick-edits §3)。
//!
//! 穴を 2 つ(重なりあり)開けてコピーし、クリップボードへ渡った RGBA の画素で「穴の中は元のまま・
//! 外は 1 段階(元の画素 × 0.5 ±1)・重なりも暗くない・穴の外の矢印は明るい」を確かめる。あわせて
//! 移動・リサイズ・削除がそれぞれ 1 手で戻ること、最後の穴を消すと暗さが消えること、選択の枠が
//! コピーに写らないこと、履歴のサムネイルに暗さが写ることを確かめる。
//!
//! 暗くする矩形の集合(`spotlightShadeRects()`)・合成の順(1 本のパスで 1 回塗る)・当たり判定は
//! `spotlight.test.ts`・`documentSurface.test.ts`・`shapeEdit.test.ts` が受け持つ。

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

const captureResult: MockCaptureResult = {
  id: "e2e-spotlight-1",
  sourcePath: "/tmp/tadcap-captures/e2e-spotlight-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

const secondCaptureResult: MockCaptureResult = {
  id: "e2e-spotlight-2",
  sourcePath: "/tmp/tadcap-captures/e2e-spotlight-2.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:01.000Z",
};

const WIDTH = 1200;
const HEIGHT = 800;
/** 1 色の地。白に近くない色にして、選択の枠(白)が写っていないことを近白色の数で確かめる。 */
const GROUND: readonly [number, number, number, number] = [200, 180, 160, 255];
/** 暗さ 1 段階(`SPOTLIGHT_SHADE` = 黒 50%)の地の色。 */
const SHADED = { r: 100, g: 90, b: 80 };
/** 矢印の色(プリセットの赤。`src/ui/colorPicker.ts::COLOR_PRESETS`)。 */
const RED = { r: 255, g: 59, b: 48 };

type Point = [number, number];
type Rect = { x: number; y: number; width: number; height: number };

/** 穴 A・B(Canvas ピクセル)。B は A の右下に重なる。 */
const HOLE_A: Rect = { x: 100, y: 100, width: 300, height: 200 };
const HOLE_B: Rect = { x: 300, y: 200, width: 300, height: 250 };
/** 穴の外に引く矢印(始点・終点)と、その周りの範囲(暗さの判定から外す)。 */
const ARROW_FROM: Point = [800, 650];
const ARROW_TO: Point = [1100, 650];
const ARROW_AREA: Rect = { x: 760, y: 600, width: 380, height: 100 };
/** 穴の縁は端数の座標で半端に塗られるため、判定から外す幅(Canvas ピクセル)。 */
const EDGE_MARGIN = 3;

function corners(rect: Rect): { nw: Point; se: Point } {
  return { nw: [rect.x, rect.y], se: [rect.x + rect.width, rect.y + rect.height] };
}

async function toViewport(canvas: Locator, p: Point): Promise<Point> {
  const box = await canvas.boundingBox();
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }));
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  return [box.x + (p[0] * box.width) / size.w, box.y + (p[1] * box.height) / size.h];
}

async function drag(page: Page, canvas: Locator, from: Point, to: Point): Promise<void> {
  const [fx, fy] = await toViewport(canvas, from);
  const [tx, ty] = await toViewport(canvas, to);
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 8 });
  await page.mouse.up();
}

async function click(page: Page, canvas: Locator, at: Point): Promise<void> {
  const [x, y] = await toViewport(canvas, at);
  await page.mouse.click(x, y);
}

async function copy(page: Page): Promise<void> {
  const before = await getClipboardWriteCount(page);
  await page.getByRole("button", { name: "クリップボードにコピー" }).click();
  await expect.poll(() => getClipboardWriteCount(page)).toBe(before + 1);
}

/** 1 画素(Canvas の今の表示)。 */
async function pixelAt(canvas: Locator, p: Point): Promise<[number, number, number]> {
  return canvas.evaluate((el: HTMLCanvasElement, at: Point) => {
    const d = el.getContext("2d")!.getImageData(at[0], at[1], 1, 1).data;
    return [d[0]!, d[1]!, d[2]!] as [number, number, number];
  }, p);
}

interface CopyCheck {
  /** 穴の中(A のみ・B のみ・重なり)で元の地と ±1 を超えて違う画素の数。 */
  holeMismatches: number;
  /** 穴の外(縁・矢印の周りを除く)で「地 × 0.5 ±1」でない画素の数。 */
  outsideMismatches: number;
  /** 調べた画素の数(穴の中・外)。 */
  holeSamples: number;
  outsideSamples: number;
  /** 矢印の範囲にある赤(±40)の画素の数。 */
  arrowRedPixels: number;
}

/** 直近にクリップボードへ渡った RGBA を、地の色・穴・矢印の範囲と照らし合わせる(1 画素おき)。 */
async function checkCopiedImage(page: Page, holes: Rect[]): Promise<CopyCheck> {
  return page.evaluate(
    (args) => {
      const w = window as unknown as {
        __tadcapE2E?: { lastImage?: { rgba: Uint8Array; width: number; height: number } };
      };
      const image = w.__tadcapE2E!.lastImage!;
      const inside = (r: Rect, x: number, y: number, m: number): boolean =>
        x >= r.x + m && x < r.x + r.width - m && y >= r.y + m && y < r.y + r.height - m;
      const near = (r: Rect, x: number, y: number, m: number): boolean =>
        x >= r.x - m && x < r.x + r.width + m && y >= r.y - m && y < r.y + r.height + m;
      const result = { holeMismatches: 0, outsideMismatches: 0, holeSamples: 0, outsideSamples: 0, arrowRedPixels: 0 };
      const [gr, gg, gb] = args.ground;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const i = (y * image.width + x) * 4;
          const r = image.rgba[i]!;
          const g = image.rgba[i + 1]!;
          const b = image.rgba[i + 2]!;
          if (near(args.arrowArea, x, y, 0)) {
            if (Math.abs(r - args.red.r) <= 40 && Math.abs(g - args.red.g) <= 40 && Math.abs(b - args.red.b) <= 40) {
              result.arrowRedPixels += 1;
            }
            continue;
          }
          if ((x + y) % 2 !== 0) {
            continue;
          }
          if (args.holes.some((hole) => inside(hole, x, y, args.margin))) {
            result.holeSamples += 1;
            if (Math.abs(r - gr) > 1 || Math.abs(g - gg) > 1 || Math.abs(b - gb) > 1) {
              result.holeMismatches += 1;
            }
            continue;
          }
          if (args.holes.some((hole) => near(hole, x, y, args.margin))) {
            continue;
          }
          result.outsideSamples += 1;
          if (
            Math.abs(r - Math.round(gr * 0.5)) > 1 ||
            Math.abs(g - Math.round(gg * 0.5)) > 1 ||
            Math.abs(b - Math.round(gb * 0.5)) > 1
          ) {
            result.outsideMismatches += 1;
          }
        }
      }
      return result;
    },
    {
      holes,
      ground: [GROUND[0], GROUND[1], GROUND[2]] as [number, number, number],
      red: RED,
      arrowArea: ARROW_AREA,
      margin: EDGE_MARGIN,
    },
  );
}

/** `.history-sidebar__thumbnail`(<img>)に指定色(±tol)の画素があるか。 */
async function thumbnailHasColor(thumbnail: Locator, target: typeof SHADED, tol: number): Promise<boolean> {
  return thumbnail.evaluate(
    (img: HTMLImageElement, args: { target: typeof SHADED; tol: number }) =>
      new Promise<boolean>((resolve) => {
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
              Math.abs(data[i]! - args.target.r) <= args.tol &&
              Math.abs(data[i + 1]! - args.target.g) <= args.tol &&
              Math.abs(data[i + 2]! - args.target.b) <= args.tol
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
      }),
    { target, tol },
  );
}

function toolButton(page: Page): Locator {
  return page.getByRole("button", { name: "スポットライト(S)" });
}

/** スポットライトツールで穴 A・B を開け、矢印ツールで穴の外に赤い矢印を引く。 */
async function drawHolesAndArrow(page: Page, canvas: Locator): Promise<void> {
  await page.keyboard.press("s");
  await expect(toolButton(page)).toHaveAttribute("aria-pressed", "true");
  for (const hole of [HOLE_A, HOLE_B]) {
    const { nw, se } = corners(hole);
    await drag(page, canvas, nw, se);
    // 開けた直後の穴は選択中で内側も掴めるため、外してから次の穴を(重なる位置に)開ける。
    await page.keyboard.press("Escape");
  }
  await page.keyboard.press("a");
  await page.getByRole("button", { name: "赤", exact: true }).click();
  await drag(page, canvas, ARROW_FROM, ARROW_TO);
  await page.keyboard.press("Escape");
}

test.describe("スポットライト(QE-T16)", () => {
  const fixturePng = createFixtureCapturePng(WIDTH, HEIGHT, GROUND, GROUND);
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

  test(
    "穴 2 つ(重なり)→ コピーの画素: 穴の中は元のまま・外は 1 段階・重なりも暗くない・穴の外の矢印は明るい → " +
      "移動・リサイズ・削除がそれぞれ 1 手 → 最後の穴を消すと暗さが消える",
    async ({ page }) => {
      await installTauriMocks(page, {
        initialPermissionState: "granted",
        capture: { kind: "success", result: captureResult },
        captureImageBase64: fixturePng.toString("base64"),
      });
      await page.goto("/");
      const canvas = await captureAndWaitReady(page);
      await expect(toolButton(page)).toHaveAttribute("aria-keyshortcuts", "S");
      await expect(toolButton(page)).toHaveAttribute("title", "スポットライト(S)");

      await drawHolesAndArrow(page, canvas);
      await copy(page);
      const check = await checkCopiedImage(page, [HOLE_A, HOLE_B]);
      expect(check.holeSamples).toBeGreaterThan(1000);
      expect(check.outsideSamples).toBeGreaterThan(1000);
      expect(check.holeMismatches).toBe(0);
      expect(check.outsideMismatches).toBe(0);
      expect(check.arrowRedPixels).toBeGreaterThan(100);
      // 重なりの中(A と B の両方に入る所)も元のまま(上の holeMismatches に含むが、明示して確かめる)。
      expect(await pixelAt(canvas, [350, 250])).toEqual([GROUND[0], GROUND[1], GROUND[2]]);
      await saveSnapshot(canvas, "two-holes");

      // 移動: 枠の付近で A を選び、選んだ穴は内側でも掴めるので内側から動かす(1 手で戻る)。
      await page.keyboard.press("s");
      await click(page, canvas, [HOLE_A.x, HOLE_A.y + 50]);
      await drag(page, canvas, [200, 150], [200, 120]);
      expect(await diffFromSnapshot(canvas, "two-holes")).toBeGreaterThan(0);
      await page.keyboard.press("Meta+Z");
      expect(await diffFromSnapshot(canvas, "two-holes")).toBe(0);

      // リサイズ: 選択中の A の北西のハンドルを動かす(1 手で戻る)。
      await click(page, canvas, [HOLE_A.x, HOLE_A.y + 50]);
      await drag(page, canvas, [HOLE_A.x, HOLE_A.y], [HOLE_A.x - 40, HOLE_A.y - 40]);
      expect(await diffFromSnapshot(canvas, "two-holes")).toBeGreaterThan(0);
      await page.keyboard.press("Meta+Z");
      expect(await diffFromSnapshot(canvas, "two-holes")).toBe(0);

      // 削除: 選んで Delete(1 手で戻る)。
      await click(page, canvas, [HOLE_A.x, HOLE_A.y + 50]);
      await page.keyboard.press("Delete");
      expect(await diffFromSnapshot(canvas, "two-holes")).toBeGreaterThan(0);
      // A だけの所は暗くなり、B は穴のまま。
      expect(await pixelAt(canvas, [150, 150])).toEqual([SHADED.r, SHADED.g, SHADED.b]);
      expect(await pixelAt(canvas, [500, 400])).toEqual([GROUND[0], GROUND[1], GROUND[2]]);
      await page.keyboard.press("Meta+Z");
      expect(await diffFromSnapshot(canvas, "two-holes")).toBe(0);

      // 最後の穴を消すと暗さが消える(穴の外だった所も元の地に戻る)。
      await click(page, canvas, [HOLE_A.x, HOLE_A.y + 50]);
      await page.keyboard.press("Delete");
      await click(page, canvas, [HOLE_B.x + HOLE_B.width, HOLE_B.y + 150]);
      await page.keyboard.press("Delete");
      expect(await pixelAt(canvas, [50, 50])).toEqual([GROUND[0], GROUND[1], GROUND[2]]);
      expect(await pixelAt(canvas, [1000, 300])).toEqual([GROUND[0], GROUND[1], GROUND[2]]);
      expect(pageErrors).toEqual([]);
    },
  );

  test("選択中の穴の枠・ハンドルはコピーに写らず、履歴のサムネイルに暗さが写る", async ({ page }) => {
    const secondPng = createFixtureCapturePng(220, 160, [240, 240, 20, 255], [10, 10, 10, 255]);
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: captureResult },
      captureImageBase64: fixturePng.toString("base64"),
      secondCapture: { result: secondCaptureResult, captureImageBase64: secondPng.toString("base64") },
    });
    await page.goto("/");
    const canvas = await captureAndWaitReady(page);

    // 穴を 1 つ開けた直後は選択中(四隅の丸ハンドル + 破線の枠がオーバーレイに出る)。
    await page.keyboard.press("s");
    const { nw, se } = corners(HOLE_A);
    await drag(page, canvas, nw, se);
    await expect(page.getByRole("button", { name: "最背面へ(⌘⇧B)" })).toBeEnabled();
    const overlayVisible = await page.evaluate(() => {
      const overlay = document.querySelector<HTMLCanvasElement>(".shape-overlay");
      return overlay !== null && !overlay.hidden;
    });
    expect(overlayVisible).toBe(true);

    // キー操作のコピーでは選択が保たれる(枠を出したままコピーする)。
    const before = await getClipboardWriteCount(page);
    await page.keyboard.press("Meta+C");
    await expect.poll(() => getClipboardWriteCount(page)).toBe(before + 1);
    const stats = await getClipboardImageStats(page, SHADED, 1);
    expect(stats).not.toBeNull();
    // 地は白に近くないので、近白色があれば枠(白の実線)・ハンドル(白塗り)が写っている。
    expect(stats!.nearWhitePixels).toBe(0);
    expect(stats!.equalsCanvas).toBe(true);
    expect(stats!.targetColorPixels).toBeGreaterThan(0);

    // 新規キャプチャで、直前の項目のサムネイルに暗さが写る。
    await captureAndWaitReady(page, 2);
    const previousThumbnail = page
      .locator(".history-sidebar__item")
      .nth(1)
      .locator(".history-sidebar__thumbnail");
    expect(await thumbnailHasColor(previousThumbnail, SHADED, 6)).toBe(true);
    expect(pageErrors).toEqual([]);
  });
});
