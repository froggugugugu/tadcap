//! E2Eテスト: キャプチャのショートカットを変える設定画面(KS-T8)。
//!
//! Tauri ランタイムは起動せず、`e2e/fixtures/tauriMock.ts` で設定のコマンドをモックする。トレイ・
//! アプリメニューの「設定…」は Rust が送る `settings://open` をテストから発火して代える
//! (メニュー自体・OS へのキー登録は手動確認)。

import { expect, test, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  emitTauriEvent,
  getShortcutCalls,
  installTauriMocks,
  routeCrossOriginAssets,
  type TauriMockConfig,
} from "./fixtures/tauriMock";

const fixturePng = createFixtureCapturePng();

async function start(page: Page, shortcut?: TauriMockConfig["shortcut"]): Promise<void> {
  await routeCrossOriginAssets(page, fixturePng);
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: {
      kind: "success",
      result: {
        id: "e2e-shortcut-1",
        sourcePath: "/tmp/tadcap-captures/e2e-shortcut-1.png",
        kind: "range",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    },
    captureImageBase64: fixturePng.toString("base64"),
    shortcut,
  });
  await page.goto("/");
}

async function openSettings(page: Page): Promise<void> {
  await emitTauriEvent(page, "settings://open");
  await expect(page.getByRole("dialog", { name: "設定" })).toBeVisible();
}

function recorder(page: Page) {
  return page.getByRole("dialog", { name: "設定" }).getByRole("button", { name: /キャプチャのショートカット/ });
}

test.describe("キャプチャのショートカット設定(KS-T8)", () => {
  let pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
  });

  test("設定…で画面が開き、現在のキーを表示する。二重に届いても1つだけ開き、閉じると記録中が解除される", async ({
    page,
  }) => {
    await start(page);
    await openSettings(page);
    await emitTauriEvent(page, "settings://open");

    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(recorder(page)).toHaveText("⌘⇧2");
    await expect(page.getByRole("button", { name: "既定に戻す" })).toBeDisabled();

    await recorder(page).click();
    await expect(recorder(page)).toHaveText("キーを押してください…");
    await page.getByRole("button", { name: "閉じる" }).click();
    await expect(page.getByRole("dialog", { name: "設定" })).toBeHidden();
    await expect.poll(() => getShortcutCalls(page)).toEqual(["recording:false", "recording:true", "recording:false"]);
    expect(pageErrors).toEqual([]);
  });

  test("新しいキーを押すとその場で変わり、設定画面・ツールチップ・空状態の表記がそろって変わる", async ({ page }) => {
    await start(page);
    await openSettings(page);

    await recorder(page).click();
    await page.keyboard.press("Meta+Alt+KeyK");

    await expect(recorder(page)).toHaveText("⌘⌥K");
    await expect(page.locator("#capture-shortcut-status")).toHaveText("変更しました。");
    await expect(page.locator("#capture-button")).toHaveAttribute("title", "キャプチャ(⌘⌥K)");
    await expect(page.locator("#capture-button")).toHaveAttribute("aria-label", "キャプチャ(⌘⌥K)");
    await expect(page.locator("#empty-state kbd")).toHaveText("⌘⌥K");
    await expect(page.getByRole("button", { name: "既定に戻す" })).toBeEnabled();
    expect(await getShortcutCalls(page)).toContain("set:alt+super+KeyK");
    expect(pageErrors).toEqual([]);
  });

  test("修飾キーだけでは待ち、修飾キーなし・⌘と1キー・⌘⇧3は理由を出して変えない", async ({ page }) => {
    await start(page);
    await openSettings(page);
    const status = page.locator("#capture-shortcut-status");

    await recorder(page).click();
    await page.keyboard.down("Meta");
    await expect(recorder(page)).toHaveText("キーを押してください…");
    await page.keyboard.up("Meta");
    await page.keyboard.press("KeyK");
    await expect(status).toHaveText("⌘・⌥・⌃ のどれかと一緒に押してください。");
    await expect(recorder(page)).toHaveText("⌘⇧2");

    await recorder(page).click();
    await page.keyboard.press("Meta+KeyJ");
    await expect(status).toHaveText("⌘ を使うときは ⇧・⌥・⌃ のどれかも一緒に押してください(⌘C などとぶつかるため)。");

    await recorder(page).click();
    await page.keyboard.press("Meta+Shift+Digit3");
    await expect(status).toHaveText("このキーは macOS のスクリーンショットが使っています。");

    expect((await getShortcutCalls(page)).filter((call) => call.startsWith("set:"))).toEqual([]);
    await expect(page.locator("#capture-button")).toHaveAttribute("title", "キャプチャ(⌘⇧2)");
  });

  test("登録に失敗したら理由を出し、表記は元のキーのまま。Escは記録の取り消しで、画面は閉じない", async ({ page }) => {
    await start(page, { failRegister: ["control+super+KeyP"] });
    await openSettings(page);

    await recorder(page).click();
    await page.keyboard.press("Control+Meta+KeyP");

    await expect(page.locator("#capture-shortcut-status")).toHaveText(
      "このキーは使えませんでした。ほかのアプリが使っている可能性があります。元のキーのままです。",
    );
    await expect(recorder(page)).toHaveText("⌘⇧2");
    await expect(page.locator("#capture-button")).toHaveAttribute("title", "キャプチャ(⌘⇧2)");

    await recorder(page).click();
    await page.keyboard.press("Escape");
    await expect(recorder(page)).toHaveText("⌘⇧2");
    await expect(page.getByRole("dialog", { name: "設定" })).toBeVisible();
  });

  test("保存してあったキーで表記が始まり、既定に戻すで⌘⇧2に戻る。登録できていないときは知らせる", async ({ page }) => {
    await start(page, { initial: "control+alt+KeyS", registered: false });
    await expect(page.locator("#capture-button")).toHaveAttribute("title", "キャプチャ(⌥⌃S)");
    await openSettings(page);

    await expect(recorder(page)).toHaveText("⌥⌃S");
    await expect(page.locator("#capture-shortcut-status")).toContainText("現在のキーは登録できていません");

    await page.getByRole("button", { name: "既定に戻す" }).click();

    await expect(recorder(page)).toHaveText("⌘⇧2");
    await expect(page.locator("#capture-shortcut-status")).toHaveText("既定のキーに戻しました。");
    await expect(page.locator("#empty-state kbd")).toHaveText("⌘⇧2");
    await expect(page.getByRole("button", { name: "既定に戻す" })).toBeDisabled();
    expect(await getShortcutCalls(page)).toContain("reset");
  });

  test("設定画面を開いている間に⌘Z・Delete・⌘Cを押しても、エディタの内容は変わらない", async ({ page }) => {
    await start(page);
    const canvas = await captureAndWaitReady(page);
    await page.getByRole("button", { name: "矩形" }).click();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 90, { steps: 6 });
    await page.mouse.up();
    const before = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL());
    const clipboardBefore = await page.evaluate(
      () => (window as unknown as { __tadcapE2E: { clipboardWriteCount: number } }).__tadcapE2E.clipboardWriteCount,
    );

    await openSettings(page);
    await page.keyboard.press("Meta+KeyZ");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Meta+KeyC");
    await page.getByRole("button", { name: "閉じる" }).click();

    expect(await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL())).toBe(before);
    expect(
      await page.evaluate(
        () => (window as unknown as { __tadcapE2E: { clipboardWriteCount: number } }).__tadcapE2E.clipboardWriteCount,
      ),
    ).toBe(clipboardBefore);
    await expect(page.getByRole("button", { name: "取り消し(⌘Z)" })).toBeEnabled();
  });
});
