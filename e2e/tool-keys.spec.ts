//! E2Eテスト: ツールの 1 キー切替とツールボタンの名前(QE-T02、ARCH_quick-edits §7.1 手順 K、
//! UI_quick-edits §1.3・§7、PRD_quick-edits FR-013)。
//!
//! 判定そのもの(修飾キー・IME・入力欄・確認中・描画中)は `src/ui/toolKeys.test.ts` で確かめ、
//! ここでは `window` への結線と、既存のショートカット(⌘C・⌘Z)・テキスト入力・自動マスキングの
//! 確認中・設定画面との共存を確かめる。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { diffFromSnapshot, saveSnapshot } from "./fixtures/canvasSnapshot";
import { captureAndWaitReady } from "./fixtures/captureReady";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  emitTauriEvent,
  getClipboardWriteCount,
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
  type MockScanCandidate,
} from "./fixtures/tauriMock";

const sampleCaptureResult: MockCaptureResult = {
  id: "e2e-tool-keys-1",
  sourcePath: "/tmp/tadcap-captures/e2e-tool-keys-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

const CANDIDATES: MockScanCandidate[] = [{ x: 12, y: 12, width: 96, height: 24, kind: "contact" }];

/** UI_quick-edits §1.3 の表(今あるツールだけ)。 */
const TOOL_KEYS = [
  { key: "a", name: "矢印(A)", shortcut: "A" },
  { key: "r", name: "矩形(R)", shortcut: "R" },
  { key: "o", name: "円(O)", shortcut: "O" },
  { key: "t", name: "テキスト(T)", shortcut: "T" },
  { key: "n", name: "スタンプ(N)", shortcut: "N" },
  { key: "m", name: "モザイク(M)", shortcut: "M" },
] as const;

function toolButton(page: Page, name: string): Locator {
  return page.getByRole("button", { name, exact: true });
}

async function drag(page: Page, canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 6 });
  await page.mouse.up();
}

test.describe("ツールの 1 キー切替(QE-T02)", () => {
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
      textScan: { candidates: CANDIDATES },
    });
    await page.goto("/");
  });

  test("ツールボタンの名前・ツールチップが「名前(キー)」の形で、aria-keyshortcuts が入っている", async ({ page }) => {
    for (const { name, shortcut } of TOOL_KEYS) {
      const button = toolButton(page, name);
      await expect(button).toHaveAttribute("title", name);
      await expect(button).toHaveAttribute("aria-keyshortcuts", shortcut);
    }
    expect(pageErrors).toEqual([]);
  });

  test("各キーで aria-pressed が切り替わり、同じキーをもう一度押すと外れる", async ({ page }) => {
    await captureAndWaitReady(page);
    for (const { key, name } of TOOL_KEYS) {
      await page.keyboard.press(key);
      await expect(toolButton(page, name)).toHaveAttribute("aria-pressed", "true");
      for (const other of TOOL_KEYS.filter((entry) => entry.name !== name)) {
        await expect(toolButton(page, other.name)).toHaveAttribute("aria-pressed", "false");
      }
    }
    // 最後に選んだモザイクの M をもう一度押すと選択が外れる。
    await page.keyboard.press("m");
    await expect(toolButton(page, "モザイク(M)")).toHaveAttribute("aria-pressed", "false");
    // 割り当てのないキー・まだ無いツールのキーは何もしない。
    for (const key of ["z", "1", "c"]) {
      await page.keyboard.press(key);
    }
    await expect(page.locator(".tool-toolbar__button[aria-pressed='true']")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("⌘C・⌘Z は奪わない(コピーと取り消しが起きる)", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await saveSnapshot(canvas, "original");
    await page.keyboard.press("r");
    await drag(page, canvas);
    await page.keyboard.press("Enter");
    expect(await diffFromSnapshot(canvas, "original")).toBeGreaterThan(0);

    const copiesBefore = await getClipboardWriteCount(page);
    await page.keyboard.press("Meta+C");
    await expect.poll(() => getClipboardWriteCount(page)).toBe(copiesBefore + 1);
    // ⌘C の C(トリミングの予定のキー)でツールは変わらない。
    await expect(toolButton(page, "矩形(R)")).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("Meta+Z");
    await expect.poll(() => diffFromSnapshot(canvas, "original")).toBe(0);
    await expect(toolButton(page, "矩形(R)")).toHaveAttribute("aria-pressed", "true");
    expect(pageErrors).toEqual([]);
  });

  test("テキストの入力中に a を押すと文字が入り、ツールは変わらない", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await page.keyboard.press("t");
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    const input = page.getByRole("textbox", { name: "テキスト入力" });
    await expect(input).toBeFocused();

    await page.keyboard.press("a");
    await expect(input).toHaveValue("a");
    await expect(toolButton(page, "テキスト(T)")).toHaveAttribute("aria-pressed", "true");
    await expect(toolButton(page, "矢印(A)")).toHaveAttribute("aria-pressed", "false");
    expect(pageErrors).toEqual([]);
  });

  test("自動マスキングの確認中は効かない", async ({ page }) => {
    await captureAndWaitReady(page);
    await page.keyboard.press("a");
    await expect(toolButton(page, "矢印(A)")).toHaveAttribute("aria-pressed", "true");

    await page.locator("#auto-mask-button").click();
    await expect(page.locator("#mask-bar")).toBeVisible();
    await page.keyboard.press("r");
    await page.keyboard.press("a");
    await expect(toolButton(page, "矢印(A)")).toHaveAttribute("aria-pressed", "true");
    await expect(toolButton(page, "矩形(R)")).toHaveAttribute("aria-pressed", "false");
    expect(pageErrors).toEqual([]);
  });

  test("設定画面を開いている間は効かない", async ({ page }) => {
    await captureAndWaitReady(page);
    await emitTauriEvent(page, "settings://open");
    const dialog = page.getByRole("dialog", { name: "設定" });
    await expect(dialog).toBeVisible();

    await page.keyboard.press("a");
    await page.keyboard.press("r");
    await expect(page.locator(".tool-toolbar__button[aria-pressed='true']")).toHaveCount(0);

    await dialog.getByRole("button", { name: "閉じる" }).click();
    await expect(dialog).toBeHidden();
    await page.keyboard.press("a");
    await expect(toolButton(page, "矢印(A)")).toHaveAttribute("aria-pressed", "true");
    expect(pageErrors).toEqual([]);
  });
});
