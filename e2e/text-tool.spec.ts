//! E2Eテスト: テキストツール(T27、PRD FR-012)。
//!
//! 入力欄の重ね合わせ・キー結線・焼き込み(`src/canvas/tools/textTool.ts::bindTextTool`)は
//! DOM/Canvas依存のためVitest対象外で、ここで検証する。寸法・状態遷移の判定は`textTool.test.ts`。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  getActivateAppCount,
  getClipboardImageStats,
  getClipboardWriteCount,
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "./fixtures/tauriMock";

const sampleCaptureResult: MockCaptureResult = {
  id: "e2e-text-tool-1",
  sourcePath: "/tmp/tadcap-captures/e2e-text-tool-1.png",
  kind: "range",
  createdAt: "2024-01-01T00:00:00.000Z",
};

/** 注釈の既定色(#FF5C8A)。 */
const ANNOTATION_COLOR = { r: 255, g: 92, b: 138 };
const COLOR_TOLERANCE = 40;

async function countAnnotationPixelsAll(canvas: Locator): Promise<number> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, args: { target: typeof ANNOTATION_COLOR; tol: number }) => {
      const ctx = el.getContext("2d");
      if (!ctx) {
        return 0;
      }
      const { data } = ctx.getImageData(0, 0, el.width, el.height);
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
    { target: ANNOTATION_COLOR, tol: COLOR_TOLERANCE },
  );
}

// T30: 「canvas.width > 0」待ちはCanvas既定サイズ(300x150)でも成立してしまう競合があるため
// (T29申し送り)、コピーボタン有効化+履歴反映を待つ共通ヘルパー(fixtures/captureReady.ts)に
// 置き換えた。
async function captureAndSelectText(page: Page): Promise<Locator> {
  const canvas = await captureAndWaitReady(page);
  await page.getByRole("button", { name: "テキスト" }).click();
  return canvas;
}

/** Canvasの左寄り中央をクリックして入力欄を開く。 */
async function openInput(page: Page, canvas: Locator): Promise<Locator> {
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  const input = page.getByRole("textbox", { name: "テキスト入力" });
  await expect(input).toBeFocused();
  return input;
}

test.describe("テキストツール(T27)", () => {
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

  test("入力してEnterで焼き込まれ、入力欄は消える", async ({ page }) => {
    const canvas = await captureAndSelectText(page);
    expect(await countAnnotationPixelsAll(canvas)).toBe(0);
    const input = await openInput(page, canvas);

    await page.keyboard.type("Hello");
    await page.keyboard.press("Enter");

    await expect(input).toHaveCount(0);
    expect(await countAnnotationPixelsAll(canvas)).toBeGreaterThan(20);
    expect(pageErrors).toEqual([]);
  });

  test("Escで取り消すと何も残らない", async ({ page }) => {
    const canvas = await captureAndSelectText(page);
    const input = await openInput(page, canvas);

    await page.keyboard.type("Hello");
    await page.keyboard.press("Escape");

    await expect(input).toHaveCount(0);
    expect(await countAnnotationPixelsAll(canvas)).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("IME変換中のEnterでは確定しない", async ({ page }) => {
    const canvas = await captureAndSelectText(page);
    const input = await openInput(page, canvas);

    await page.keyboard.insertText("てすと");
    await input.evaluate((el: HTMLInputElement) => {
      el.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }),
      );
    });
    await expect(input).toBeFocused();
    expect(await countAnnotationPixelsAll(canvas)).toBe(0);

    // 変換確定後の(変換中でない)Enterで確定する。
    await input.evaluate((el: HTMLInputElement) => {
      el.dispatchEvent(new CompositionEvent("compositionend", { data: "テスト" }));
    });
    await page.keyboard.press("Enter");
    await expect(input).toHaveCount(0);
    expect(await countAnnotationPixelsAll(canvas)).toBeGreaterThan(20);
    expect(pageErrors).toEqual([]);
  });

  test("日本語IME(実際の変換パイプライン)で「てすと」→「テスト」と変換・確定でき、Enterで描かれる", async ({
    page,
  }) => {
    const canvas = await captureAndSelectText(page);
    const input = await openInput(page, canvas);

    // CDPのIME入力(Chromiumの実際の変換経路。compositionstart/update・beforeinput・inputが
    // ブラウザ自身から順に発火する)。擬似イベントを手で並べるのではなく、入力欄のハンドラが
    // 変換中の文字を消したり入力欄を閉じたりしないことを確かめる。
    const cdp = await page.context().newCDPSession(page);
    for (const text of ["t", "て", "てs", "てす", "てすt", "てすと", "テスト"]) {
      await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      await expect(input).toHaveValue(text);
      await expect(input).toBeFocused();
    }
    await cdp.send("Input.insertText", { text: "テスト" });
    await expect(input).toHaveValue("テスト");
    await expect(input).toBeFocused();
    expect(await countAnnotationPixelsAll(canvas)).toBe(0);

    await page.keyboard.press("Enter");
    await expect(input).toHaveCount(0);
    expect(await countAnnotationPixelsAll(canvas)).toBeGreaterThan(20);
    expect(pageErrors).toEqual([]);
  });

  test("WebKitのIMEイベント順(keydown 229→composition→確定Enterのkeydown 229)で変換中の文字が残り、確定Enterでは閉じない", async ({
    page,
  }) => {
    const canvas = await captureAndSelectText(page);
    const input = await openInput(page, canvas);

    // WKWebView(macOS)で観測される順序を再現する: 変換開始のkeydownは isComposing=false・
    // keyCode 229、変換中は isComposing=true、確定のEnterは compositionend の後に
    // isComposing=false・keyCode 229 で届く。各keydownは既定動作を止められてはならない
    // (止めるとWebKitは変換を取り消す)ため、defaultPrevented も確かめる。
    const prevented = await input.evaluate((el: HTMLInputElement) => {
      const results: boolean[] = [];
      const key = (init: KeyboardEventInit & { keyCode: number }): void => {
        const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
        Object.defineProperty(event, "keyCode", { get: () => init.keyCode });
        el.dispatchEvent(event);
        results.push(event.defaultPrevented);
      };
      const compose = (data: string, inputType: string, composing: boolean): void => {
        el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data, inputType, isComposing: composing }));
        el.value = data;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data, inputType, isComposing: composing }));
      };
      key({ key: "t", keyCode: 229, isComposing: false });
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      for (const [k, text] of [["t", "t"], ["e", "て"], ["s", "てs"], ["u", "てす"], ["t", "てすt"], ["o", "てすと"], [" ", "テスト"]]) {
        if (text !== "t") {
          key({ key: k, keyCode: 229, isComposing: true });
        }
        el.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
        compose(text, "insertCompositionText", true);
      }
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "テスト" }));
      key({ key: "Enter", keyCode: 229, isComposing: false });
      // Escで変換を取り消すときも(変換中のEsc)入力欄は閉じない。
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      key({ key: "Escape", keyCode: 229, isComposing: true });
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      return results;
    });
    expect(prevented.every((p) => !p)).toBe(true);
    await expect(input).toHaveValue("テスト");
    await expect(input).toBeFocused();
    expect(await countAnnotationPixelsAll(canvas)).toBe(0);

    await page.keyboard.press("Enter");
    await expect(input).toHaveCount(0);
    expect(await countAnnotationPixelsAll(canvas)).toBeGreaterThan(20);
    expect(pageErrors).toEqual([]);
  });

  test("入力欄が開いてフォーカスを得ると、IMEが効くようにアプリのアクティブ化(activate_app)を要求する", async ({
    page,
  }) => {
    const canvas = await captureAndSelectText(page);
    expect(await getActivateAppCount(page)).toBe(0);
    await openInput(page, canvas);

    // すぐに1回 + 短い遅延(`ipc/app.ts::ACTIVATION_RETRY_DELAY_MS`)で1回。
    await expect.poll(() => getActivateAppCount(page)).toBe(2);
    expect(pageErrors).toEqual([]);
  });

  test("入力中のCmd+Cはアプリのコピーに奪われず、コピーボタンで確定後の画像がコピーされ入力欄の枠は写らない", async ({
    page,
  }) => {
    const canvas = await captureAndSelectText(page);
    const input = await openInput(page, canvas);
    await page.keyboard.type("Copy");

    await page.keyboard.press("Meta+C");
    expect(await getClipboardWriteCount(page)).toBe(0);
    await expect(input).toBeFocused();

    await page.getByRole("button", { name: "クリップボードにコピー" }).click();
    await expect(page.locator("#clipboard-status")).toHaveText("クリップボードにコピーしました。");
    await expect(input).toHaveCount(0);
    expect(await getClipboardWriteCount(page)).toBe(1);

    const stats = await getClipboardImageStats(page, ANNOTATION_COLOR, COLOR_TOLERANCE);
    expect(stats).not.toBeNull();
    // 文字は焼き込まれて写る・入力欄の枠(白の点線)は写らない・Canvasの内容そのもの。
    expect(stats!.targetColorPixels).toBeGreaterThan(20);
    expect(stats!.nearWhitePixels).toBe(0);
    expect(stats!.equalsCanvas).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test("空のまま他ツールへ切り替えると何も焼き込まれない", async ({ page }) => {
    const canvas = await captureAndSelectText(page);
    const input = await openInput(page, canvas);

    await page.getByRole("button", { name: "矩形" }).click();

    await expect(input).toHaveCount(0);
    expect(await countAnnotationPixelsAll(canvas)).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});
