//! E2Eテスト: 取り消し・やり直し(T29、PRD FR-014)。
//!
//! ボタン・`Cmd+Z`/`Cmd+Shift+Z`の結線と Canvas への書き戻し(`src/ui/undoButton.ts::initUndoButtons`)
//! はDOM/Canvas依存のためここで検証する。判定(キー・有効/無効・操作の選択)は`undoButton.test.ts`。
//! 色・ツールを横断する網羅的なUIフローはT30で追加する。

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
  id: "e2e-undo-redo-1",
  sourcePath: "/tmp/tadcap-captures/e2e-undo-redo-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

// T30: 待機・スナップショット比較のヘルパーは fixtures/ の共通実装(captureReady.ts /
// canvasSnapshot.ts)に集約した(`tool-settings.spec.ts`と同じ待機パターン、
// `annotation-tools.spec.ts`とも共有)。

async function drag(page: Page, canvas: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 6 });
  await page.mouse.up();
}

test.describe("取り消し・やり直し(T29)", () => {
  const fixturePng = createFixtureCapturePng();
  let pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    await routeCrossOriginAssets(page, fixturePng);
    pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: sampleCaptureResult },
      captureImageBase64: fixturePng.toString("base64"),
    });
    await page.goto("/");
  });

  test("矢印→矩形→モザイクをCmd+Z×3で元画像に戻し、Cmd+Shift+Z×3で描いた後に戻る", async ({ page }) => {
    const undoButton = page.getByRole("button", { name: "取り消し" });
    const redoButton = page.getByRole("button", { name: "やり直し" });
    const canvas = await captureAndWaitReady(page);
    await expect(undoButton).toBeDisabled();
    await expect(redoButton).toBeDisabled();
    await saveSnapshot(canvas, "original");

    await page.getByRole("button", { name: "矢印" }).click();
    await drag(page, canvas, [0.1, 0.8], [0.4, 0.3]);
    await page.getByRole("button", { name: "矩形" }).click();
    await drag(page, canvas, [0.5, 0.2], [0.8, 0.5]);
    await page.getByRole("button", { name: "モザイク" }).click();
    await drag(page, canvas, [0.55, 0.6], [0.9, 0.9]);
    await saveSnapshot(canvas, "edited");
    expect(await diffFromSnapshot(canvas, "original")).toBeGreaterThan(0);
    await expect(undoButton).toBeEnabled();

    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press("Meta+Z");
    }
    expect(await diffFromSnapshot(canvas, "original")).toBe(0);
    await expect(undoButton).toBeDisabled();
    await expect(redoButton).toBeEnabled();

    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press("Meta+Shift+Z");
    }
    expect(await diffFromSnapshot(canvas, "edited")).toBe(0);
    await expect(redoButton).toBeDisabled();

    // ボタンでも1操作ずつ戻る(モザイクだけ取り消すと矢印・矩形は残る)。
    await undoButton.click();
    expect(await diffFromSnapshot(canvas, "edited")).toBeGreaterThan(0);
    expect(await diffFromSnapshot(canvas, "original")).toBeGreaterThan(0);
    await redoButton.click();
    expect(await diffFromSnapshot(canvas, "edited")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  // 【改訂 2026-09-24 T32】T31では描いた直後の図形は「編集中」でCmd+Zは破棄・やり直し不可だったが、
  // オブジェクト化で追加は通常の1操作になった。取り消しで描く前に戻り、やり直しで戻せることを確かめる。
  test("描いた直後の図形もCmd+Z・取り消しボタンで描く前に戻り、やり直しで戻せる", async ({ page }) => {
    const undoButton = page.getByRole("button", { name: "取り消し" });
    const redoButton = page.getByRole("button", { name: "やり直し" });
    const canvas = await captureAndWaitReady(page);
    await saveSnapshot(canvas, "original");

    await page.getByRole("button", { name: "矩形" }).click();
    await drag(page, canvas, [0.2, 0.2], [0.6, 0.6]);
    await saveSnapshot(canvas, "drawn");
    await expect(undoButton).toBeEnabled();
    await page.keyboard.press("Meta+Z");
    expect(await diffFromSnapshot(canvas, "original")).toBe(0);
    await expect(undoButton).toBeDisabled();
    await expect(redoButton).toBeEnabled();
    await page.keyboard.press("Meta+Shift+Z");
    expect(await diffFromSnapshot(canvas, "drawn")).toBe(0);

    await drag(page, canvas, [0.7, 0.1], [0.9, 0.3]);
    await undoButton.click();
    await undoButton.click();
    expect(await diffFromSnapshot(canvas, "original")).toBe(0);
    await expect(undoButton).toBeDisabled();
    await redoButton.click();
    expect(await diffFromSnapshot(canvas, "drawn")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  // 【改訂 2026-09-24 T32】「新しい図形を描くとやり直しは無効になる」(PRD FR-014)として意図は同じ。
  test("編集中の図形がある間はやり直しが無効", async ({ page }) => {
    const redoButton = page.getByRole("button", { name: "やり直し" });
    const canvas = await captureAndWaitReady(page);

    await page.getByRole("button", { name: "矩形" }).click();
    await drag(page, canvas, [0.2, 0.2], [0.5, 0.5]);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Meta+Z");
    await expect(redoButton).toBeEnabled();

    await drag(page, canvas, [0.4, 0.4], [0.8, 0.8]);
    await expect(redoButton).toBeDisabled();
    await saveSnapshot(canvas, "pending");
    await page.keyboard.press("Meta+Shift+Z");
    expect(await diffFromSnapshot(canvas, "pending")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("テキスト入力中のCmd+Zは入力欄の操作になり、Canvasの取り消しは発火しない", async ({ page }) => {
    const undoButton = page.getByRole("button", { name: "取り消し" });
    const canvas = await captureAndWaitReady(page);
    await page.getByRole("button", { name: "矩形" }).click();
    await drag(page, canvas, [0.5, 0.1], [0.9, 0.4]);
    await page.keyboard.press("Enter");
    await saveSnapshot(canvas, "withRect");

    await page.getByRole("button", { name: "テキスト" }).click();
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.7);
    const input = page.getByRole("textbox", { name: "テキスト入力" });
    await expect(input).toBeFocused();
    await page.keyboard.type("abc");
    await page.keyboard.press("Meta+Z");

    await expect(input).toBeFocused();
    expect(await diffFromSnapshot(canvas, "withRect")).toBe(0);
    await expect(undoButton).toBeEnabled();
    expect(pageErrors).toEqual([]);
  });

  test("新しいキャプチャを読み込むと取り消し・やり直しは空になる", async ({ page }) => {
    const undoButton = page.getByRole("button", { name: "取り消し" });
    const canvas = await captureAndWaitReady(page);
    await page.getByRole("button", { name: "矩形" }).click();
    await drag(page, canvas, [0.2, 0.2], [0.5, 0.5]);
    await page.keyboard.press("Enter");
    await expect(undoButton).toBeEnabled();

    await page.getByRole("button", { name: "キャプチャ" }).click();
    await expect(undoButton).toBeDisabled();
    await expect(page.getByRole("button", { name: "やり直し" })).toBeDisabled();
    expect(pageErrors).toEqual([]);
  });
});
