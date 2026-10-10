//! E2E テスト: トリミング(QE-T23、PRD_quick-edits FR-005〜FR-007、ARCH_quick-edits §7.1 C・§7.3・§10.2、ADR-002)。
//!
//! 範囲を囲む → Esc でやめる → 囲み直して Enter で切り詰める流れと、トリミングが他の機能と組み合わさったときの
//! 振る舞い(注釈のずれ・範囲外の注釈の削除・番号の詰まり・1 手の取り消し・トリミングより前の手・2 回の
//! トリミング・注釈の大きさの基準 `styleBasis`・モザイクの粗さ `captureSize`・スポットライトの穴・縮めてコピー・
//! 履歴の切り替え・自動マスキング)を、Canvas とクリップボードへ渡った画像の画素で確かめる。
//!
//! 注釈の状態を読むテスト用の口は無いので、**見た目の比較**で確かめる。切り詰める範囲の左上をチェッカー
//! ボードの周期(12px)の倍数にしておくと、切った後の Canvas は「切る前の Canvas の範囲の部分」と画素まで
//! 一致する(注釈が正しくずれ、大きさが変わらず、範囲の外の注釈が消えていれば)。
//!
//! 範囲の整数化・注釈の計画(`crop.test.ts`)、取り消しの手(`documentState.test.ts`・`commands.test.ts`)、
//! ハンドルの当たり判定・やめる条件(`cropTool.test.ts`)、帯の文言(`cropBar.test.ts`)、⌘Z の判定
//! (`undoButton.test.ts`)、大きさの変化での候補の破棄(`autoMask.test.ts`)はユニットテストが受け持つ。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { diffFromSnapshot, saveSnapshot } from "./fixtures/canvasSnapshot";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  getClipboardImageStats,
  getClipboardWriteCount,
  getLastClipboardImageSize,
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
  type MockScanCandidate,
} from "./fixtures/tauriMock";

type Point = [number, number];
type Rect = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

function captureResult(n: number, pixelRatio?: 1 | 2 | null): MockCaptureResult {
  const result: MockCaptureResult = {
    id: `e2e-crop-${n}`,
    sourcePath: `/tmp/tadcap-captures/e2e-crop-${n}.png`,
    kind: "range",
    createdAt: `2024-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
  };
  if (pixelRatio !== undefined) {
    result.pixelRatio = pixelRatio;
  }
  return result;
}

/**
 * 大きい画像(対角線 ≈ 2884px)。矢印の太さ ≈ 39px・文字 ≈ 69px・モザイクのブロック 23px になり、
 * 切った後(1200 × 720、対角線 1400px)の大きさで決めた場合(太さ ≈ 19px・文字 ≈ 34px・ブロック 11 → 12px)と
 * 見分けられる。
 */
const BIG: Size = { width: 2400, height: 1600 };
/** 切り詰める範囲(左上はチェッカーボードの周期 12px の倍数)。 */
const CROP: Rect = { x: 600, y: 480, width: 1200, height: 720 };
/** `mosaicBlockSize(2400, 1600)`(撮った時点の大きさで決まるブロック)。 */
const BIG_BLOCK = 23;

const RED = { r: 255, g: 59, b: 48 };
const COLOR_TOLERANCE = 40;

function cropButton(page: Page): Locator {
  return page.getByRole("button", { name: "トリミング(C)" });
}

function cropBar(page: Page): Locator {
  return page.locator("#crop-bar");
}

function cropOverlay(page: Page): Locator {
  return page.locator("canvas.crop-overlay");
}

function corners(rect: Rect): { nw: Point; se: Point } {
  return { nw: [rect.x, rect.y], se: [rect.x + rect.width, rect.y + rect.height] };
}

function shift(p: Point, by: Rect): Point {
  return [p[0] - by.x, p[1] - by.y];
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

async function canvasSize(canvas: Locator): Promise<Size> {
  return canvas.evaluate((el: HTMLCanvasElement) => ({ width: el.width, height: el.height }));
}

/** トリミングツールで `rect` を囲む(帯に寸法が出るまで待つ)。 */
async function selectRange(page: Page, canvas: Locator, rect: Rect): Promise<void> {
  const { nw, se } = corners(rect);
  await drag(page, canvas, nw, se);
  await expect(cropOverlay(page)).toBeVisible();
}

/** 範囲を囲んで Enter で切り詰め、Canvas が `rect` の大きさになるのを待つ。 */
async function cropTo(page: Page, canvas: Locator, rect: Rect): Promise<void> {
  await selectRange(page, canvas, rect);
  await expect(cropBar(page).locator(".crop-bar__size")).toHaveText(`残す範囲 ${rect.width} × ${rect.height}`);
  await page.keyboard.press("Enter");
  await expect.poll(() => canvasSize(canvas)).toEqual({ width: rect.width, height: rect.height });
  await expect(cropOverlay(page)).toBeHidden();
}

/** 今の Canvas の `rect` の画素を名前付きで保存する(切る前の範囲の部分・スタンプの周りの比較用)。 */
async function saveRegion(canvas: Locator, name: string, rect: Rect): Promise<void> {
  await canvas.evaluate(
    (el: HTMLCanvasElement, args: { key: string; rect: Rect }) => {
      const w = window as unknown as { __regions?: Record<string, Uint8ClampedArray> };
      w.__regions ??= {};
      const { x, y, width, height } = args.rect;
      w.__regions[args.key] = el.getContext("2d")!.getImageData(x, y, width, height).data.slice();
    },
    { key: name, rect },
  );
}

/**
 * 保存した部分と、今の Canvas の `rect`(同じ大きさ)で、いずれかのチャンネルが `tolerance` を超えて
 * 違う画素の数。
 */
async function diffFromRegion(canvas: Locator, name: string, rect: Rect, tolerance = 0): Promise<number> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, args: { key: string; rect: Rect; tolerance: number }) => {
      const w = window as unknown as { __regions: Record<string, Uint8ClampedArray> };
      const before = w.__regions[args.key]!;
      const { x, y, width, height } = args.rect;
      const now = el.getContext("2d")!.getImageData(x, y, width, height).data;
      if (now.length !== before.length) {
        return Number.POSITIVE_INFINITY;
      }
      let count = 0;
      for (let i = 0; i < now.length; i += 4) {
        if (
          Math.abs(now[i]! - before[i]!) > args.tolerance ||
          Math.abs(now[i + 1]! - before[i + 1]!) > args.tolerance ||
          Math.abs(now[i + 2]! - before[i + 2]!) > args.tolerance
        ) {
          count += 1;
        }
      }
      return count;
    },
    { key: name, rect, tolerance },
  );
}

/** `rect` の中で `target`(±`COLOR_TOLERANCE`)の画素の数。 */
async function countColor(canvas: Locator, rect: Rect, target: typeof RED): Promise<number> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, args: { rect: Rect; target: typeof RED; tol: number }) => {
      const { x, y, width, height } = args.rect;
      const { data } = el.getContext("2d")!.getImageData(x, y, width, height);
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
    { rect, target, tol: COLOR_TOLERANCE },
  );
}

/**
 * スナップショット `before` から変わった画素の外接矩形の中央の行・列で、色が切り替わる間隔の最頻値
 * (= モザイクのブロックの大きさ)。隣のブロックの平均がたまたま同じでも、最頻値は変わらない。
 */
async function mosaicBlockOf(canvas: Locator, before: string): Promise<number | null> {
  return canvas.evaluate((el: HTMLCanvasElement, key: string) => {
    const w = window as unknown as { __snapshots: Record<string, Uint8ClampedArray> };
    const prev = w.__snapshots[key]!;
    const now = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
    let minX = el.width;
    let minY = el.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < el.height; y += 1) {
      for (let x = 0; x < el.width; x += 1) {
        const i = (y * el.width + x) * 4;
        if (now[i] !== prev[i] || now[i + 1] !== prev[i + 1] || now[i + 2] !== prev[i + 2]) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxX < 0) {
      return null;
    }
    const same = (a: number, b: number): boolean =>
      now[a] === now[b] && now[a + 1] === now[b + 1] && now[a + 2] === now[b + 2];
    const gaps = new Map<number, number>();
    const addGaps = (positions: number[]): void => {
      for (let k = 1; k < positions.length; k += 1) {
        const gap = positions[k]! - positions[k - 1]!;
        gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
      }
    };
    const midY = Math.floor((minY + maxY) / 2);
    const rowChanges: number[] = [];
    for (let x = minX + 1; x <= maxX; x += 1) {
      if (!same((midY * el.width + x) * 4, (midY * el.width + x - 1) * 4)) rowChanges.push(x);
    }
    const midX = Math.floor((minX + maxX) / 2);
    const columnChanges: number[] = [];
    for (let y = minY + 1; y <= maxY; y += 1) {
      if (!same((y * el.width + midX) * 4, ((y - 1) * el.width + midX) * 4)) columnChanges.push(y);
    }
    addGaps(rowChanges);
    addGaps(columnChanges);
    let best: number | null = null;
    let bestCount = 0;
    for (const [gap, count] of gaps) {
      if (count > bestCount) {
        best = gap;
        bestCount = count;
      }
    }
    return best;
  }, before);
}

async function copyWithShortcut(page: Page): Promise<void> {
  const before = await getClipboardWriteCount(page);
  await page.keyboard.press("Meta+C");
  await expect.poll(() => getClipboardWriteCount(page)).toBe(before + 1);
}

/** `.history-sidebar__thumbnail`(<img>)の縦横比。 */
async function thumbnailAspect(thumbnail: Locator): Promise<number> {
  return thumbnail.evaluate(
    (img: HTMLImageElement) =>
      new Promise<number>((resolve) => {
        const read = (): void => resolve(img.naturalWidth / img.naturalHeight);
        if (img.complete && img.naturalWidth > 0) {
          read();
        } else {
          img.onload = read;
        }
      }),
  );
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });
  return errors;
}

test.describe("トリミング(QE-T23)", () => {
  test.describe("大きい画像", () => {
    const fixturePng = createFixtureCapturePng(BIG.width, BIG.height);
    let pageErrors: string[] = [];

    test.beforeEach(async ({ page }) => {
      pageErrors = trackPageErrors(page);
      await routeCrossOriginAssets(page, fixturePng);
      await installTauriMocks(page, {
        initialPermissionState: "granted",
        capture: { kind: "success", result: captureResult(1) },
        captureImageBase64: fixturePng.toString("base64"),
      });
      await page.goto("/");
    });

    test(
      "囲む → 確定前の ⌘C は元の大きさ → Esc でやめる → 囲み直して Enter: 大きさ・範囲外のスタンプが消えて番号が詰まる → " +
        "⌘Z 1 回で大きさ・位置・消えた注釈・番号が戻る → ⇧⌘Z で再び",
      async ({ page }) => {
        const canvas = await captureAndWaitReady(page);
        await expect(cropButton(page)).toHaveAttribute("aria-keyshortcuts", "C");

        // 番号スタンプ 1(範囲の外)・2・3(範囲の中)。2 は切った後に 1 の位置へ、3 は切る前の 2 と同じ
        // チェッカーボードの位相の位置へ来るように置く。
        const s1: Point = [300, 300];
        const s2: Point = [CROP.x + s1[0], CROP.y + s1[1]];
        const s3: Point = [1500, 900];
        const s2After = shift(s2, CROP);
        const s3After = shift(s3, CROP);
        expect(s2After).toEqual(s1);
        const half = 100;
        const around = (p: Point): Rect => ({ x: p[0] - half, y: p[1] - half, width: half * 2, height: half * 2 });

        await page.keyboard.press("n");
        for (const at of [s1, s2, s3]) {
          await click(page, canvas, at);
        }
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: "最背面へ(⌘⇧B)" })).toBeDisabled();
        await saveSnapshot(canvas, "before");
        await saveRegion(canvas, "one", around(s1));
        await saveRegion(canvas, "two", around(s2));
        // 3 の位置(切った後)と同じ位相の、切る前の 2 の位置の地。
        expect(Math.abs((s3After[0] - s2[0]) % 12)).toBe(0);
        expect(Math.abs((s3After[1] - s2[1]) % 12)).toBe(0);

        // C で選ぶと帯が出る(範囲なしの案内)。
        await page.keyboard.press("c");
        await expect(cropButton(page)).toHaveAttribute("aria-pressed", "true");
        await expect(cropBar(page)).toBeVisible();
        await expect(cropBar(page)).toContainText("ドラッグで残す範囲を囲んでください。");

        await selectRange(page, canvas, CROP);
        await expect(cropBar(page).locator(".crop-bar__size")).toHaveText("残す範囲 1200 × 720");
        await expect(cropBar(page).getByRole("button", { name: "確定" })).toBeEnabled();

        // 確定前の ⌘C は切り詰めていない画像で、範囲の暗さ・枠・ハンドル(オーバーレイ)は写らない。
        await copyWithShortcut(page);
        expect(await getLastClipboardImageSize(page)).toEqual(BIG);
        const stats = await getClipboardImageStats(page, RED, 0);
        expect(stats!.equalsCanvas).toBe(true);
        expect(await diffFromSnapshot(canvas, "before")).toBe(0);

        // Esc でやめる: 範囲が消え、画像は変わらない。
        await page.keyboard.press("Escape");
        await expect(cropOverlay(page)).toBeHidden();
        await expect(cropBar(page)).toContainText("ドラッグで残す範囲を囲んでください。");
        expect(await canvasSize(canvas)).toEqual(BIG);
        expect(await diffFromSnapshot(canvas, "before")).toBe(0);

        // 囲み直して Enter で切り詰める。
        await cropTo(page, canvas, CROP);
        await expect(page.getByText("切り抜きました。⌘Z で戻せます。")).toBeVisible();
        // 1 は範囲の外で消え、2 → 1、3 → 2 に詰まる(位置は範囲の左上の分だけずれる、大きさは変わらない)。
        expect(await diffFromRegion(canvas, "one", around(s2After), 64)).toBeLessThanOrEqual(40);
        expect(await diffFromRegion(canvas, "two", around(s3After), 64)).toBeLessThanOrEqual(40);
        expect(await diffFromRegion(canvas, "two", around(s2After), 64)).toBeGreaterThanOrEqual(60);
        await saveSnapshot(canvas, "after");

        // ⌘Z 1 回で元の大きさ・位置・消えた注釈・番号まで戻る。
        await page.keyboard.press("Meta+Z");
        await expect.poll(() => canvasSize(canvas)).toEqual(BIG);
        expect(await diffFromSnapshot(canvas, "before")).toBe(0);
        // ⇧⌘Z で再び切り詰める。
        await page.keyboard.press("Meta+Shift+Z");
        await expect.poll(() => canvasSize(canvas)).toEqual({ width: CROP.width, height: CROP.height });
        expect(await diffFromSnapshot(canvas, "after")).toBe(0);
        expect(pageErrors).toEqual([]);
      },
    );

    test(
      "トリミングより前のモザイク・矢印も続けて戻せる・2 回のトリミング → 範囲の指定中の ⌘Z / ⇧⌘Z は指定をやめるだけ → " +
        "全体と同じ範囲は確定できない",
      async ({ page }) => {
        const canvas = await captureAndWaitReady(page);
        await saveSnapshot(canvas, "s0");
        await page.keyboard.press("m");
        await drag(page, canvas, [700, 560], [1100, 860]);
        await saveSnapshot(canvas, "s1");
        await page.keyboard.press("a");
        await drag(page, canvas, [1200, 600], [1600, 1000]);
        await page.keyboard.press("Escape");
        await saveSnapshot(canvas, "s2");

        await page.keyboard.press("c");
        await cropTo(page, canvas, CROP);
        await saveSnapshot(canvas, "s3");
        const second: Rect = { x: 120, y: 120, width: 720, height: 480 };
        await cropTo(page, canvas, second);
        await saveSnapshot(canvas, "s4");

        // 範囲の指定中の ⌘Z / ⇧⌘Z は範囲を捨てるだけ(画像・取り消しは変わらない)。
        for (const key of ["Meta+Z", "Meta+Shift+Z"]) {
          await selectRange(page, canvas, { x: 100, y: 100, width: 300, height: 200 });
          await page.keyboard.press(key);
          await expect(cropOverlay(page)).toBeHidden();
          await expect(cropBar(page)).toContainText("ドラッグで残す範囲を囲んでください。");
          expect(await canvasSize(canvas)).toEqual({ width: second.width, height: second.height });
          expect(await diffFromSnapshot(canvas, "s4")).toBe(0);
        }

        // 画像全体と同じ範囲は確定できない(Enter でも何も変わらない)。
        const box = (await canvas.boundingBox())!;
        await page.mouse.move(box.x + 0.05, box.y + 0.05);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width + 30, box.y + box.height + 30, { steps: 8 });
        await page.mouse.up();
        await expect(cropBar(page).locator(".crop-bar__size")).toHaveText("残す範囲 720 × 480");
        await expect(cropBar(page)).toContainText("画像全体と同じ範囲です");
        await expect(cropBar(page).getByRole("button", { name: "確定" })).toBeDisabled();
        await page.keyboard.press("Enter");
        expect(await canvasSize(canvas)).toEqual({ width: second.width, height: second.height });
        expect(await diffFromSnapshot(canvas, "s4")).toBe(0);
        // 「やめる」で範囲を捨てる。
        await cropBar(page).getByRole("button", { name: "やめる" }).click();
        await expect(cropOverlay(page)).toBeHidden();

        // 取り消し: 2 回目のトリミング → 1 回目 → 矢印 → モザイクの順に戻る。
        const expectations: Array<[string, Size]> = [
          ["s3", { width: CROP.width, height: CROP.height }],
          ["s2", BIG],
          ["s1", BIG],
          ["s0", BIG],
        ];
        for (const [name, size] of expectations) {
          await page.keyboard.press("Meta+Z");
          await expect.poll(() => canvasSize(canvas)).toEqual(size);
          expect(await diffFromSnapshot(canvas, name)).toBe(0);
        }
        for (let i = 0; i < 4; i += 1) {
          await page.keyboard.press("Meta+Shift+Z");
        }
        await expect.poll(() => canvasSize(canvas)).toEqual({ width: second.width, height: second.height });
        expect(await diffFromSnapshot(canvas, "s4")).toBe(0);
        expect(pageErrors).toEqual([]);
      },
    );

    test(
      "切った後の画像は切る前の範囲の部分と画素まで同じ(注釈のずれ・大きさ・スポットライトの穴・モザイク・" +
        "範囲外の注釈の削除・はみ出した注釈)",
      async ({ page }) => {
        const canvas = await captureAndWaitReady(page);
        // 範囲の外の矩形(消える)と、範囲の境界をまたぐ矢印(残る)。既定の色(ピンク)。
        await page.keyboard.press("r");
        await drag(page, canvas, [100, 100], [400, 250]);
        await page.keyboard.press("Escape");
        await page.keyboard.press("a");
        await drag(page, canvas, [400, 300], [800, 650]);
        await page.keyboard.press("Escape");
        // 範囲の中: スポットライトの穴・赤の矢印・テキスト・モザイク。
        await page.keyboard.press("s");
        await drag(page, canvas, [660, 520], [1100, 800]);
        await page.keyboard.press("Escape");
        await page.keyboard.press("a");
        await page.getByRole("button", { name: "赤", exact: true }).click();
        await drag(page, canvas, [1250, 560], [1650, 860]);
        await page.keyboard.press("Escape");
        await page.keyboard.press("t");
        await click(page, canvas, [700, 950]);
        await expect(page.getByRole("textbox", { name: "テキスト入力" })).toBeFocused();
        await page.keyboard.type("AB");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("textbox", { name: "テキスト入力" })).toHaveCount(0);
        await page.keyboard.press("Escape");
        await page.keyboard.press("m");
        await drag(page, canvas, [1250, 950], [1650, 1150]);
        await saveRegion(canvas, "inside", CROP);

        await page.keyboard.press("c");
        await cropTo(page, canvas, CROP);
        const whole: Rect = { x: 0, y: 0, width: CROP.width, height: CROP.height };
        // 範囲の境界をまたぐ矢印の影だけは、範囲の外にあった部分のぼかしが Canvas の端で切れるため
        // 数階調(実測で最大 15)違う。位置・大きさがずれれば 40 を超えて違う画素が大量に出る。
        expect(await diffFromRegion(canvas, "inside", whole, 20)).toBe(0);
        const awayFromEdgeArrow: Rect = { x: 240, y: 0, width: CROP.width - 240, height: CROP.height };
        expect(
          await canvas.evaluate(
            (el: HTMLCanvasElement, r: Rect) => {
              const w = window as unknown as { __regions: Record<string, Uint8ClampedArray> };
              const before = w.__regions["inside"]!;
              const now = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
              let count = 0;
              for (let y = r.y; y < r.y + r.height; y += 1) {
                for (let x = r.x; x < r.x + r.width; x += 1) {
                  const i = (y * el.width + x) * 4;
                  if (now[i] !== before[i] || now[i + 1] !== before[i + 1] || now[i + 2] !== before[i + 2]) {
                    count += 1;
                  }
                }
              }
              return count;
            },
            awayFromEdgeArrow,
          ),
        ).toBe(0);
        // 穴は範囲の左上の分だけずれる: 穴の中は元の地、切る前の穴の位置(ずれなかった場合の穴)は暗い。
        const holeInsideAfter: Point = shift([900, 700], CROP);
        const pixel = await canvas.evaluate((el: HTMLCanvasElement, p: Point) => {
          const d = el.getContext("2d")!.getImageData(p[0], p[1], 1, 1).data;
          return d[0]! + d[1]! + d[2]!;
        }, holeInsideAfter);
        const unshifted = await canvas.evaluate((el: HTMLCanvasElement, p: Point) => {
          const d = el.getContext("2d")!.getImageData(p[0], p[1], 1, 1).data;
          return d[0]! + d[1]! + d[2]!;
        }, [900, 700] as Point);
        expect(unshifted).toBeLessThan(pixel);
        expect(pageErrors).toEqual([]);
      },
    );

  });

  test.describe("大きい画像(7px のタイル)", () => {
    // 6px のタイル(周期 12px)では 23px のブロックでも平均がほぼ同じ色になり、ブロックの境目が画素に
    // 出ないため、ブロックの大きさを読むこのテストだけ周期 14px の画像を使う。
    const fixturePng = createFixtureCapturePng(BIG.width, BIG.height, undefined, undefined, 7);
    let pageErrors: string[] = [];

    test.beforeEach(async ({ page }) => {
      pageErrors = trackPageErrors(page);
      await routeCrossOriginAssets(page, fixturePng);
      await installTauriMocks(page, {
        initialPermissionState: "granted",
        capture: { kind: "success", result: captureResult(1) },
        captureImageBase64: fixturePng.toString("base64"),
      });
      await page.goto("/");
    });

    test(
      "切る前の矢印・文字の大きさは変わらず、切った後に描く矢印・文字は今の大きさで決まる・" +
        "切った後のモザイクの粗さは撮った時点の大きさで決まる",
      async ({ page }) => {
        const canvas = await captureAndWaitReady(page);
        // 検出の確かめ: 切る前(範囲の外)のモザイクのブロックは 23px と読める。
        await saveSnapshot(canvas, "beforeFirstMosaic");
        await page.keyboard.press("m");
        await drag(page, canvas, [100, 100], [500, 400]);
        expect(await mosaicBlockOf(canvas, "beforeFirstMosaic")).toBe(BIG_BLOCK);
        // 切った後の座標で配置を決め、切る前は範囲の左上の分を足して描く。
        const toBefore = (p: Point): Point => [p[0] + CROP.x, p[1] + CROP.y];
        const arrow1: [Point, Point] = [[100, 40], [500, 280]];
        const arrow2: [Point, Point] = [[100, 420], [500, 660]];
        const arrow1Area: Rect = { x: 40, y: 0, width: 520, height: 340 };
        const arrow2Area: Rect = { x: 40, y: 370, width: 520, height: 350 };
        const text1: Point = [700, 60];
        const text2: Point = [700, 300];
        const text1Area: Rect = { x: 650, y: 0, width: 400, height: 240 };
        const text2Area: Rect = { x: 650, y: 250, width: 400, height: 190 };

        await page.keyboard.press("a");
        await page.getByRole("button", { name: "赤", exact: true }).click();
        await drag(page, canvas, toBefore(arrow1[0]), toBefore(arrow1[1]));
        await page.keyboard.press("Escape");
        await page.keyboard.press("t");
        await click(page, canvas, toBefore(text1));
        await page.keyboard.type("AB");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("textbox", { name: "テキスト入力" })).toHaveCount(0);
        await page.keyboard.press("Escape");
        // 矢印・文字とも赤(選んだ色はツールを持ち替えても保たれる)。
        const arrow1Before = await countColor(
          canvas,
          { ...arrow1Area, x: arrow1Area.x + CROP.x, y: arrow1Area.y + CROP.y },
          RED,
        );
        const text1Before = await countColor(
          canvas,
          { ...text1Area, x: text1Area.x + CROP.x, y: text1Area.y + CROP.y },
          RED,
        );
        expect(arrow1Before).toBeGreaterThan(1000);
        expect(text1Before).toBeGreaterThan(100);

        await page.keyboard.press("c");
        await cropTo(page, canvas, CROP);
        // 切る前に描いた矢印・文字は大きさが変わらない(色の画素の数が同じ)。
        expect(await countColor(canvas, arrow1Area, RED)).toBe(arrow1Before);
        expect(await countColor(canvas, text1Area, RED)).toBe(text1Before);

        // 切った後に描く矢印・文字は今の(小さい)画像の大きさで決まる。
        await page.keyboard.press("a");
        await drag(page, canvas, arrow2[0], arrow2[1]);
        await page.keyboard.press("Escape");
        await page.keyboard.press("t");
        await click(page, canvas, text2);
        await page.keyboard.type("AB");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("textbox", { name: "テキスト入力" })).toHaveCount(0);
        await page.keyboard.press("Escape");
        const arrow2After = await countColor(canvas, arrow2Area, RED);
        const text2After = await countColor(canvas, text2Area, RED);
        expect(arrow2After).toBeGreaterThan(0);
        expect(arrow2After).toBeLessThan(arrow1Before * 0.6);
        expect(text2After).toBeGreaterThan(0);
        expect(text2After).toBeLessThan(text1Before * 0.6);

        // 切った後のモザイクのブロックは撮った時点の大きさ(2400 × 1600)で決まる。
        await saveSnapshot(canvas, "beforeMosaic");
        await page.keyboard.press("m");
        await drag(page, canvas, [660, 460], [1140, 700]);
        expect(await mosaicBlockOf(canvas, "beforeMosaic")).toBe(BIG_BLOCK);
        expect(pageErrors).toEqual([]);
      },
    );
  });

  test("縮めてコピーがオンなら、確定前は元の大きさの半分・確定後は切り詰めた大きさの半分がコピーされる", async ({
    page,
  }) => {
    const pageErrors = trackPageErrors(page);
    const png = createFixtureCapturePng(600, 400);
    await routeCrossOriginAssets(page, png);
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: captureResult(1, 2) },
      captureImageBase64: png.toString("base64"),
      shrinkCopy: true,
    });
    await page.goto("/");
    const canvas = await captureAndWaitReady(page);
    expect(await getLastClipboardImageSize(page)).toEqual({ width: 300, height: 200 });

    await page.keyboard.press("c");
    const rect: Rect = { x: 120, y: 96, width: 361, height: 241 };
    await selectRange(page, canvas, rect);
    await copyWithShortcut(page);
    expect(await getLastClipboardImageSize(page)).toEqual({ width: 300, height: 200 });

    await page.keyboard.press("Enter");
    await expect.poll(() => canvasSize(canvas)).toEqual({ width: 361, height: 241 });
    await copyWithShortcut(page);
    // 361 / 2 = 180.5 → 181、241 / 2 = 120.5 → 121(四捨五入)。
    expect(await getLastClipboardImageSize(page)).toEqual({ width: 181, height: 121 });
    expect(pageErrors).toEqual([]);
  });

  test("履歴を切り替えて戻っても、切り詰めた画像のまま続きの操作・取り消しができ、サムネイルは切り詰め後", async ({
    page,
  }) => {
    const pageErrors = trackPageErrors(page);
    const png = createFixtureCapturePng(600, 400);
    const secondPng = createFixtureCapturePng(220, 160, [240, 240, 20, 255], [10, 10, 10, 255]);
    await routeCrossOriginAssets(page, png);
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: captureResult(1) },
      captureImageBase64: png.toString("base64"),
      secondCapture: { result: captureResult(2), captureImageBase64: secondPng.toString("base64") },
    });
    await page.goto("/");
    const canvas = await captureAndWaitReady(page);
    await saveSnapshot(canvas, "original");

    // 縦横比 2 に切り詰め(元は 1.5)、切った後に矢印を描く。
    await page.keyboard.press("c");
    const rect: Rect = { x: 120, y: 120, width: 360, height: 180 };
    await cropTo(page, canvas, rect);
    await saveSnapshot(canvas, "cropped");
    await page.keyboard.press("a");
    await drag(page, canvas, [40, 40], [300, 140]);
    await page.keyboard.press("Escape");
    await saveSnapshot(canvas, "edited");

    // 新規キャプチャ → 前の項目のサムネイルは切り詰め後の縦横比。
    await captureAndWaitReady(page, 2);
    const previous = page.locator(".history-sidebar__item").nth(1);
    expect(await thumbnailAspect(previous.locator(".history-sidebar__thumbnail"))).toBeCloseTo(2, 1);

    // 戻ると切り詰めた画像・注釈のまま。続けて矢印を取り消し、トリミングも取り消せる。
    await previous.locator(".history-sidebar__thumbnail-button").click();
    await expect(previous).toHaveClass(/history-sidebar__item--selected/);
    await expect.poll(() => canvasSize(canvas)).toEqual({ width: rect.width, height: rect.height });
    expect(await diffFromSnapshot(canvas, "edited")).toBe(0);
    await page.keyboard.press("Meta+Z");
    await expect.poll(() => diffFromSnapshot(canvas, "cropped")).toBe(0);
    await page.keyboard.press("Meta+Z");
    await expect.poll(() => canvasSize(canvas)).toEqual({ width: 600, height: 400 });
    expect(await diffFromSnapshot(canvas, "original")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("ツールの切替・自動マスキングの開始で範囲が捨てられ、自動マスキングの確認中はトリミングを始められない", async ({
    page,
  }) => {
    const pageErrors = trackPageErrors(page);
    const png = createFixtureCapturePng();
    const candidates: MockScanCandidate[] = [{ x: 20, y: 20, width: 80, height: 30, kind: "contact" }];
    await routeCrossOriginAssets(page, png);
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: captureResult(1) },
      captureImageBase64: png.toString("base64"),
      textScan: { candidates },
    });
    await page.goto("/");
    const canvas = await captureAndWaitReady(page);
    await saveSnapshot(canvas, "original");
    const rect: Rect = { x: 60, y: 48, width: 120, height: 96 };

    // ツールを持ち替えると範囲が捨てられる。
    await page.keyboard.press("c");
    await selectRange(page, canvas, rect);
    await page.keyboard.press("a");
    await expect(cropOverlay(page)).toBeHidden();
    await expect(cropBar(page)).toBeHidden();
    await page.keyboard.press("c");
    await expect(cropBar(page)).toContainText("ドラッグで残す範囲を囲んでください。");

    // 範囲があるときに自動マスキングを始めると範囲が捨てられる。
    await selectRange(page, canvas, rect);
    const autoMask = page.getByRole("button", { name: "機密らしい箇所を探す(⌘⇧M)" });
    await autoMask.click();
    await expect(page.locator(".mask-bar__count")).toHaveText("候補 1 件");
    await expect(cropOverlay(page)).toBeHidden();

    // 確認中はトリミングのボタンが押せず、C キー・ドラッグ・Enter でも始まらない。
    await expect(cropButton(page)).toBeDisabled();
    const pressed = await cropButton(page).getAttribute("aria-pressed");
    await page.keyboard.press("c");
    await expect(cropButton(page)).toHaveAttribute("aria-pressed", pressed ?? "false");
    // 候補(左上)の印に当たらない所をドラッグする。
    await drag(page, canvas, [150, 100], [250, 180]);
    await expect(cropOverlay(page)).toBeHidden();
    await page.keyboard.press("Enter");
    expect(await canvasSize(canvas)).toEqual({ width: 300, height: 200 });
    expect(await diffFromSnapshot(canvas, "original")).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});
