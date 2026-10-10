//! E2E テスト: 番号・記号スタンプ(QE-T13、PRD_quick-edits FR-001〜FR-004、UI_quick-edits §2)。
//!
//! 置いた順の番号(1・2・3)、消すと詰まる・⌘Z で戻る、色・文字サイズの変更、記号は数えない、
//! 重ね順を変えても番号が変わらない、種類の切替の出し入れで既存のボタンが動かないことを確かめる。
//!
//! 番号の読み取り: 注釈の状態を読むテスト用の口は無いので、**見た目の比較**で確かめる。地を 1 色の
//! 画像にし、スタンプの周りの画素を「同じ番号のスタンプの画素」と比べる(位置が違っても地が同じなので
//! 同じ番号なら一致する。描く位置の端数による縁のにじみは許容の幅で吸収する)。番号の決め方
//! (`stampNumbers()`)・直径・記号の色は `stampShape.test.ts`・`documentSurface.test.ts` が受け持つ。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { diffFromSnapshot, saveSnapshot } from "./fixtures/canvasSnapshot";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "./fixtures/tauriMock";

const captureResult: MockCaptureResult = {
  id: "e2e-stamp-1",
  sourcePath: "/tmp/tadcap-captures/e2e-stamp-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

/** 1 色の地(スタンプの直径が下限より大きくなる大きさ。中で直径 42px)。 */
const WIDTH = 1200;
const HEIGHT = 800;
const GROUND: readonly [number, number, number, number] = [236, 238, 242, 255];

/** スタンプを置く位置(Canvas ピクセル)。互いの影が重ならない間隔にする。 */
const P1: Point = [200, 200];
const P2: Point = [450, 200];
const P3: Point = [700, 200];
const P4: Point = [200, 500];
const P5: Point = [450, 500];
/** 比べる範囲の半径(大の直径 63px + 影が収まる)。 */
const HALF = 48;
/** 画素が「違う」とみなすチャンネルの差。 */
const CHANNEL_TOLERANCE = 64;
/** 同じ見た目とみなす違う画素の数の上限(端数による縁のにじみ)。 */
const SAME_MAX = 40;
/** 違う番号とみなす違う画素の数の下限。 */
const DIFFERENT_MIN = 60;

type Point = [number, number];

function toolButton(page: Page): Locator {
  return page.getByRole("button", { name: "スタンプ(N)" });
}

function kindPicker(page: Page): Locator {
  return page.getByRole("group", { name: "スタンプの種類" });
}

function kindButton(page: Page, name: string): Locator {
  return page.getByRole("button", { name, exact: true });
}

async function toViewport(canvas: Locator, p: Point): Promise<Point> {
  const box = await canvas.boundingBox();
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }));
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  return [box.x + (p[0] * box.width) / size.w, box.y + (p[1] * box.height) / size.h];
}

async function click(page: Page, canvas: Locator, at: Point): Promise<void> {
  const [x, y] = await toViewport(canvas, at);
  await page.mouse.click(x, y);
}

/** 今の Canvas の、`center` の周りの画素(RGBA)。 */
async function crop(canvas: Locator, center: Point): Promise<number[]> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, args: { cx: number; cy: number; half: number }) => {
      const { data } = el
        .getContext("2d")!
        .getImageData(args.cx - args.half, args.cy - args.half, args.half * 2, args.half * 2);
      return Array.from(data);
    },
    { cx: center[0], cy: center[1], half: HALF },
  );
}

/** 2 つの範囲で違う画素の数。 */
function differingPixels(a: number[], b: number[]): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i]! - b[i]!) > CHANNEL_TOLERANCE ||
      Math.abs(a[i + 1]! - b[i + 1]!) > CHANNEL_TOLERANCE ||
      Math.abs(a[i + 2]! - b[i + 2]!) > CHANNEL_TOLERANCE
    ) {
      count += 1;
    }
  }
  return count;
}

function expectSameLook(a: number[], b: number[]): void {
  expect(differingPixels(a, b)).toBeLessThanOrEqual(SAME_MAX);
}

function expectDifferentLook(a: number[], b: number[]): void {
  expect(differingPixels(a, b)).toBeGreaterThanOrEqual(DIFFERENT_MIN);
}

/** 色・文字サイズ・重ね順のボタンの位置(種類の出し入れで動かないことの確認用)。 */
async function fixedButtonBoxes(page: Page): Promise<string> {
  const names = ["ピンク", "青", "その他の色", "文字サイズ 小", "文字サイズ 大", "最前面へ(⌘⇧F)", "最背面へ(⌘⇧B)"];
  const boxes = [];
  for (const name of names) {
    const target =
      name === "その他の色" ? page.getByLabel(name) : page.getByRole("button", { name, exact: true });
    boxes.push(await target.boundingBox());
  }
  return JSON.stringify(boxes);
}

test.describe("番号・記号スタンプ(QE-T13)", () => {
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
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: captureResult },
      captureImageBase64: fixturePng.toString("base64"),
    });
    await page.goto("/");
  });

  test("種類の切替はスタンプツールの間だけ出し、出し入れしても色・文字サイズ・重ね順のボタンは動かない", async ({
    page,
  }) => {
    await captureAndWaitReady(page);
    await expect(toolButton(page)).toHaveAttribute("aria-keyshortcuts", "N");
    await expect(toolButton(page)).toHaveAttribute("title", "スタンプ(N)");
    await expect(kindPicker(page)).toBeHidden();
    const before = await fixedButtonBoxes(page);

    // N キーで選ぶと出る(既定は番号)。
    await page.keyboard.press("n");
    await expect(toolButton(page)).toHaveAttribute("aria-pressed", "true");
    await expect(kindPicker(page)).toBeVisible();
    await expect(kindPicker(page).getByRole("button")).toHaveCount(5);
    await expect(kindButton(page, "スタンプ 番号")).toHaveAttribute("aria-pressed", "true");
    await expect(kindButton(page, "スタンプ 質問")).toHaveAttribute("title", "スタンプ 質問");
    expect(await fixedButtonBoxes(page)).toBe(before);

    // ほかのツールでは隠す。
    await page.getByRole("button", { name: "矢印(A)" }).click();
    await expect(kindPicker(page)).toBeHidden();
    expect(await fixedButtonBoxes(page)).toBe(before);

    // 選んだ種類はツールを持ち替えても覚えている(取り消しの対象外・永続化しない)。
    await toolButton(page).click();
    await kindButton(page, "スタンプ バツ").click();
    await expect(kindButton(page, "スタンプ バツ")).toHaveAttribute("aria-pressed", "true");
    await expect(kindButton(page, "スタンプ 番号")).toHaveAttribute("aria-pressed", "false");
    await toolButton(page).click();
    await expect(kindPicker(page)).toBeHidden();
    await page.keyboard.press("n");
    await expect(kindButton(page, "スタンプ バツ")).toHaveAttribute("aria-pressed", "true");
    expect(pageErrors).toEqual([]);
  });

  test(
    "番号: 置いた順に 1・2・3 → 2 番目を消すと 1・2 → ⌘Z で 1・2・3 → 色・文字サイズを変えても番号は同じ → " +
      "記号を挟んでも次の番号は 4 → ⌘⇧B で番号が変わらない",
    async ({ page }) => {
      const canvas = await captureAndWaitReady(page);
      await toolButton(page).click();
      const empty = await crop(canvas, P2);

      // 1・2・3 を置く。3 つの見た目はすべて違う(番号が違う)。
      await click(page, canvas, P1);
      await click(page, canvas, P2);
      await click(page, canvas, P3);
      await saveSnapshot(canvas, "s123");
      const one = await crop(canvas, P1);
      const two = await crop(canvas, P2);
      const three = await crop(canvas, P3);
      expectDifferentLook(one, empty);
      expectDifferentLook(one, two);
      expectDifferentLook(two, three);
      expectDifferentLook(one, three);

      // 2 番目を消すと、3 番目が 2 に詰まる。
      await click(page, canvas, P2);
      await page.keyboard.press("Delete");
      expectSameLook(await crop(canvas, P2), empty);
      expectSameLook(await crop(canvas, P3), two);
      expectSameLook(await crop(canvas, P1), one);

      // ⌘Z で 1・2・3 に戻る(画素まで同じ)。
      await page.keyboard.press("Meta+Z");
      expect(await diffFromSnapshot(canvas, "s123")).toBe(0);

      // 選択中のスタンプの種類は変えない(種類は「これから置く」設定)。
      await click(page, canvas, P1);
      await kindButton(page, "スタンプ チェック").click();
      await expect(kindButton(page, "スタンプ チェック")).toHaveAttribute("aria-pressed", "true");
      expect(await diffFromSnapshot(canvas, "s123")).toBe(0);

      // 1 番目の色・文字サイズを変えても、ほかの番号は変わらない。
      await page.getByRole("button", { name: "青", exact: true }).click();
      const blueOne = await crop(canvas, P1);
      expectDifferentLook(blueOne, one);
      await page.getByRole("button", { name: "文字サイズ 大", exact: true }).click();
      expectDifferentLook(await crop(canvas, P1), blueOne);
      expectSameLook(await crop(canvas, P2), two);
      expectSameLook(await crop(canvas, P3), three);
      // それぞれ 1 手で戻る。
      await page.keyboard.press("Meta+Z");
      expectSameLook(await crop(canvas, P1), blueOne);
      await page.keyboard.press("Meta+Z");
      expect(await diffFromSnapshot(canvas, "s123")).toBe(0);

      // 色・文字サイズの設定は取り消しの対象外なので、選択を外してから 1・2・3 と同じ設定に戻す。
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "最背面へ(⌘⇧B)" })).toBeDisabled();
      await page.getByRole("button", { name: "ピンク", exact: true }).click();
      await page.getByRole("button", { name: "文字サイズ 中", exact: true }).click();
      expect(await diffFromSnapshot(canvas, "s123")).toBe(0);

      // 記号(✓)を置いてから番号を置く → 次の番号は 4(記号は数えない)。
      await click(page, canvas, P4);
      await kindButton(page, "スタンプ 番号").click();
      await click(page, canvas, P5);
      const four = await crop(canvas, P5);
      expectDifferentLook(await crop(canvas, P4), empty);
      for (const other of [one, two, three]) {
        expectDifferentLook(four, other);
      }
      // 記号なしで置き直した番号(1・2・3 の次 = 4)と同じ見た目になる。
      await page.keyboard.press("Meta+Z");
      await page.keyboard.press("Meta+Z");
      expect(await diffFromSnapshot(canvas, "s123")).toBe(0);
      await click(page, canvas, P5);
      expectSameLook(await crop(canvas, P5), four);
      await saveSnapshot(canvas, "s1234");

      // 3 番目を最背面へ(⌘⇧B)・最前面へ(⌘⇧F)送っても番号は変わらない(重ね順ではなく置いた順)。
      await click(page, canvas, P3);
      await expect(page.getByRole("button", { name: "最背面へ(⌘⇧B)" })).toBeEnabled();
      await page.keyboard.press("Meta+Shift+B");
      expect(await diffFromSnapshot(canvas, "s1234")).toBe(0);
      await click(page, canvas, P1);
      await page.keyboard.press("Meta+Shift+F");
      expect(await diffFromSnapshot(canvas, "s1234")).toBe(0);
      expect(pageErrors).toEqual([]);
    },
  );
});
