//! 紹介ページ(`.github/pages/index.html`)と README 用のスクリーンショット撮影。
//!
//! 通常の `npm run e2e` の対象外(`*.visual.ts`、`playwright.config.ts` の説明どおり)。
//! 実行: `npx playwright test --config=e2e/screenshots/playwright.config.ts landing`
//!
//! 一部の画像だけを撮り直すときは `LANDING_MEDIA` に書き出すファイル名をカンマ区切りで渡す
//! (指定の無いファイルは書き換えない)。例: ツールバーと注釈入りの画像だけ
//! `LANDING_MEDIA=toolbar.png,annotated.png npx playwright test --config=e2e/screenshots/playwright.config.ts landing -g 使用例`
//!
//! キャプチャ画像はチェッカーボードではなく、架空のアプリの「設定画面」を HTML で描いて
//! PNG にしたものを使う(実在の製品名・ロゴ・個人情報は含めない)。その画像を
//! `capture-flow.spec.ts` と同じ IPC モックで読み込ませ、実際のツールで矢印・矩形・円・
//! テキスト・モザイクを描いて撮る。出力先は `docs/media/`。
//!
//! 「手順を 1 枚で伝える」例(`editor.png`・`crop.png`・`steps.png`・`shrink-copy.png`)は、同じ架空の
//! 設定画面を架空のデスクトップ(メニューバーと、となりの架空のメモの窓)に置いた画像を撮り、
//! 番号スタンプ 3 つ・矢印・スポットライトを置いて、トリミングで設定の窓だけを残す。
//!
//! Vite dev server の監視対象に書き込むと画面が再読み込みされうるため、ファイルの書き出しは
//! 各テストの最後(ページ操作がすべて終わった後)にまとめて行う。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "../fixtures/captureReady";
import {
  emitTauriEvent,
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
} from "../fixtures/tauriMock";

const MEDIA_DIR = path.join(process.cwd(), "docs/media");

/** `LANDING_MEDIA`(カンマ区切りのファイル名)。未指定ならすべて書き出す。 */
const ONLY_MEDIA = process.env.LANDING_MEDIA?.split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

/** `docs/media/<name>` へ書き出す(`LANDING_MEDIA` の対象外なら何もしない)。 */
function writeMedia(name: string, data: Buffer): void {
  if (ONLY_MEDIA && ONLY_MEDIA.length > 0 && !ONLY_MEDIA.includes(name)) {
    return;
  }
  writeFileSync(path.join(MEDIA_DIR, name), data);
}

const sampleCaptureResult: MockCaptureResult = {
  id: "landing-1",
  sourcePath: "/tmp/tadcap-captures/landing-1.png",
  kind: "range",
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** 架空の設定画面(CSS 640×400、2倍で 1280×800 の PNG にする)。 */
const FAKE_SCREEN_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 640px; height: 400px; font-family: -apple-system, "Hiragino Sans", sans-serif;
         font-size: 12px; color: #1f2937; background: #e5e7eb; }
  .win { position: absolute; inset: 0; background: #fff; display: flex; flex-direction: column; }
  .bar { height: 34px; display: flex; align-items: center; gap: 6px; padding: 0 12px;
         background: #f3f4f6; border-bottom: 1px solid #e5e7eb; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #d1d5db; }
  .bar .title { flex: 1; text-align: center; font-weight: 600; color: #4b5563; margin-right: 42px; }
  .body { flex: 1; display: flex; min-height: 0; }
  .side { width: 150px; padding: 12px 8px; background: #f9fafb; border-right: 1px solid #e5e7eb; }
  .side div { padding: 6px 10px; border-radius: 6px; color: #4b5563; margin-bottom: 2px; }
  .side .on { background: #e0e7ff; color: #3730a3; font-weight: 600; }
  .main { flex: 1; padding: 16px 24px; }
  h1 { margin: 0 0 10px; font-size: 17px; }
  .warn { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-radius: 6px;
          background: #fef3c7; color: #92400e; margin-bottom: 12px; }
  .row { display: flex; align-items: center; justify-content: space-between; padding: 9px 0;
         border-bottom: 1px solid #f3f4f6; }
  .row .label b { display: block; font-size: 12px; }
  .row .label span { color: #6b7280; font-size: 11px; }
  .field { width: 230px; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; }
  .toggle { width: 34px; height: 20px; border-radius: 10px; background: #d1d5db; position: relative; }
  .toggle::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
                   border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 25%); }
  .toggle.on { background: #4f46e5; }
  .toggle.on::after { left: 16px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .btn { padding: 6px 14px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; }
  .btn.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; font-weight: 600; }
</style></head><body><div class="win">
  <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
    <span class="title">サンプルアプリ — 設定</span></div>
  <div class="body">
    <div class="side"><div>一般</div><div>通知</div><div class="on" id="side-account">アカウント</div><div>同期</div><div>詳細</div></div>
    <div class="main">
      <h1>アカウント</h1>
      <div class="warn">⚠ 二段階認証が無効になっています</div>
      <div class="row"><div class="label"><b>表示名</b><span>ほかのメンバーに表示されます</span></div>
        <div class="field">サンプル ユーザー</div></div>
      <div class="row"><div class="label"><b>メールアドレス</b><span>ログインと通知に使います</span></div>
        <div class="field" id="email">sample.user@example.com</div></div>
      <div class="row" id="mfa-row"><div class="label"><b>二段階認証</b><span>ログイン時に確認コードを求めます</span></div>
        <div class="toggle" id="mfa"></div></div>
      <div class="row"><div class="label"><b>自動ログアウト</b><span>操作がないときにログアウトします</span></div>
        <div class="field" style="width:120px">30 分 ▾</div></div>
      <div class="actions"><span class="btn">キャンセル</span><span class="btn primary" id="save">保存</span></div>
    </div>
  </div>
</div></body></html>`;

/** 画像内の位置(0〜1 の比率)。 */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FakeScreen {
  png: Buffer;
  email: Rect;
  toggle: Rect;
  save: Rect;
}

async function renderFakeScreen(browser: Browser): Promise<FakeScreen> {
  const page = await browser.newPage({
    viewport: { width: 640, height: 400 },
    deviceScaleFactor: 2,
  });
  await page.setContent(FAKE_SCREEN_HTML);
  const rectOf = (selector: string): Promise<Rect> =>
    page.locator(selector).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x / 640, y: r.y / 400, w: r.width / 640, h: r.height / 400 };
    });
  const [email, toggle, save] = await Promise.all([rectOf("#email"), rectOf("#mfa"), rectOf("#save")]);
  const png = await page.screenshot();
  await page.close();
  return { png, email, toggle, save };
}

/** 画像内の比率座標を、表示中の Canvas のビューポート座標へ変換する。 */
async function toViewport(canvas: Locator, fx: number, fy: number): Promise<[number, number]> {
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  return [box.x + box.width * fx, box.y + box.height * fy];
}

async function drag(
  page: Page,
  canvas: Locator,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  const a = await toViewport(canvas, from[0], from[1]);
  const b = await toViewport(canvas, to[0], to[1]);
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  await page.mouse.move(b[0], b[1], { steps: 10 });
  await page.mouse.up();
}

/** ツールボタンの名前(QE-T02 で `矢印(A)` の形になった。UI_quick-edits §1.3)。 */
const TOOL_BUTTON_NAMES: Record<string, string> = {
  矢印: "矢印(A)",
  矩形: "矩形(R)",
  円: "円(O)",
  テキスト: "テキスト(T)",
  モザイク: "モザイク(M)",
};

async function tool(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: TOOL_BUTTON_NAMES[name], exact: true }).click();
}

test.beforeAll(() => {
  mkdirSync(MEDIA_DIR, { recursive: true });
});

test("紹介ページ用: 使用例(注釈入りの画像)とツールバー", async ({ browser }) => {
  const screen = await renderFakeScreen(browser);
  const context = await browser.newContext({
    viewport: { width: 1080, height: 700 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await routeCrossOriginAssets(page, screen.png);
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: { kind: "success", result: sampleCaptureResult },
    captureImageBase64: screen.png.toString("base64"),
  });
  await page.goto("/");
  const canvas = await captureAndWaitReady(page);

  // モザイク: メールアドレス欄を隠す。
  const pad = 0.006;
  await tool(page, "モザイク");
  await drag(
    page,
    canvas,
    [screen.email.x - pad, screen.email.y - pad],
    [screen.email.x + screen.email.w + pad, screen.email.y + screen.email.h + pad],
  );

  // 矩形: 二段階認証のトグルを囲む(既定色ピンク)。
  const t = screen.toggle;
  await tool(page, "矩形");
  await drag(page, canvas, [t.x - 0.02, t.y - 0.025], [t.x + t.w + 0.02, t.y + t.h + 0.025]);
  await page.keyboard.press("Enter");

  // 矢印: 下の空き地(キャンセルボタンの左)からトグルの枠へ。
  await tool(page, "矢印");
  await drag(page, canvas, [0.64, 0.905], [t.x - 0.03, t.y + t.h / 2 + 0.01]);
  await page.keyboard.press("Enter");

  // テキスト(大): 矢印の根元(下の空き地)に説明を書く。
  await tool(page, "テキスト");
  await page.getByRole("button", { name: "文字サイズ 大" }).click();
  const [tx, ty] = await toViewport(canvas, 0.29, 0.895);
  await page.mouse.click(tx, ty);
  const input = page.getByRole("textbox", { name: "テキスト入力" });
  await expect(input).toBeFocused();
  await page.keyboard.insertText("ここをオンにする");
  await page.keyboard.press("Enter");
  await expect(input).toHaveCount(0);

  // 円(青): 保存ボタンを囲む。
  const s = screen.save;
  await tool(page, "円");
  await page.getByRole("button", { name: "青", exact: true }).click();
  await drag(page, canvas, [s.x - 0.025, s.y - 0.03], [s.x + s.w + 0.025, s.y + s.h + 0.03]);
  await page.keyboard.press("Enter");

  // 撮影時は矢印ツール・ピンクを選んだ状態にしておく(ツールバーの選択表示が分かるように)。
  await tool(page, "矢印");
  await page.getByRole("button", { name: "ピンク", exact: true }).click();
  await page.mouse.move(5, 690);
  // キャプチャ直後の自動コピーのトーストが消えてから撮る(`autoMask.visual.ts` と同じ)。
  await expect(page.locator("#clipboard-status")).toBeHidden({ timeout: 10_000 });

  const toolbar = await page.locator(".toolbar").screenshot();
  const annotated = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL("image/png"));
  await context.close();

  writeMedia("toolbar.png", toolbar);
  writeMedia(
    "annotated.png",
    Buffer.from(annotated.replace(/^data:image\/png;base64,/, ""), "base64"),
  );
});

test("紹介ページ用: 画面収録の許可の案内", async ({ browser }) => {
  const screen = await renderFakeScreen(browser);
  const context = await browser.newContext({
    viewport: { width: 800, height: 420 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await routeCrossOriginAssets(page, screen.png);
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: { kind: "permissionDenied" },
    captureImageBase64: screen.png.toString("base64"),
  });
  await page.goto("/");
  await page.getByRole("button", { name: "キャプチャ" }).click();
  await page.locator(".permission-banner").waitFor({ state: "visible" });
  await page.mouse.move(400, 415);
  const shot = await page.screenshot();
  await context.close();
  writeMedia("permission.png", shot);
});

test("紹介ページ用: ロゴ(icon.svg → icon.png)", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">` +
      `<img src="data:image/svg+xml;base64,${readFileSync(path.join(MEDIA_DIR, "icon.svg")).toString(
        "base64",
      )}" width="256" height="256" style="display:block"></body></html>`,
  );
  await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
  const png = await page.screenshot({ omitBackground: true });
  await page.close();
  writeMedia("icon.png", png);
});

/**
 * 架空のデスクトップ(CSS 800×480、2倍で 1600×960 の PNG): 上に架空のメニューバー、左に
 * `FAKE_SCREEN_HTML` の設定の窓(640×400)、右端にとなりの架空のメモの窓が少しだけ写り込む。
 * トリミングで設定の窓だけを残す例に使う(写っている文字はすべて架空)。
 */
const DESKTOP = { width: 800, height: 480, win: { x: 24, y: 48, width: 640, height: 400 } };

const DESKTOP_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: ${DESKTOP.width}px; height: ${DESKTOP.height}px; overflow: hidden; position: relative;
         font-family: -apple-system, "Hiragino Sans", sans-serif; font-size: 12px; color: #1f2937;
         background: linear-gradient(135deg, #c7d2fe 0%, #e0e7ff 45%, #fbcfe8 100%); }
  .menubar { position: absolute; inset: 0 0 auto 0; height: 24px; display: flex; align-items: center; gap: 16px;
             padding: 0 14px; background: rgb(255 255 255 / 70%); font-size: 12px; color: #374151; }
  .menubar b { font-weight: 700; }
  .menubar .clock { margin-left: auto; }
  iframe { position: absolute; left: ${DESKTOP.win.x}px; top: ${DESKTOP.win.y}px; width: ${DESKTOP.win.width}px;
           height: ${DESKTOP.win.height}px; border: 0; border-radius: 10px; background: #fff;
           box-shadow: 0 12px 32px rgb(15 23 42 / 25%), 0 0 0 1px rgb(15 23 42 / 8%); }
  .memo { position: absolute; left: 688px; top: 72px; width: 220px; height: 300px; border-radius: 10px; background: #fffbea;
          box-shadow: 0 12px 32px rgb(15 23 42 / 20%), 0 0 0 1px rgb(15 23 42 / 8%); padding: 34px 14px 0; color: #78350f; }
  .memo p { margin: 0 0 10px; white-space: nowrap; }
</style></head><body>
  <div class="menubar"><b>サンプルアプリ</b><span>ファイル</span><span>編集</span><span>表示</span><span>ウインドウ</span>
    <span class="clock">10:00</span></div>
  <iframe title="設定" srcdoc="${FAKE_SCREEN_HTML.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>
  <div class="memo"><p>個人メモ</p><p>来週の予定を確認</p><p>サンプル案件の資料</p><p>買い物リスト</p></div>
</body></html>`;

interface DesktopScreen {
  png: Buffer;
  win: Rect;
  account: Rect;
  mfaRow: Rect;
  toggle: Rect;
  save: Rect;
}

async function renderDesktop(browser: Browser): Promise<DesktopScreen> {
  const page = await browser.newPage({
    viewport: { width: DESKTOP.width, height: DESKTOP.height },
    deviceScaleFactor: 2,
  });
  await page.setContent(DESKTOP_HTML);
  const frame = page.frameLocator("iframe");
  await frame.locator("#save").waitFor();
  const rectOf = async (locator: Locator): Promise<Rect> => {
    const r = await locator.boundingBox();
    if (!r) {
      throw new Error("element is not visible");
    }
    return { x: r.x / DESKTOP.width, y: r.y / DESKTOP.height, w: r.width / DESKTOP.width, h: r.height / DESKTOP.height };
  };
  const [win, account, mfaRow, toggle, save] = await Promise.all([
    rectOf(page.locator("iframe")),
    rectOf(frame.locator("#side-account")),
    rectOf(frame.locator("#mfa-row")),
    rectOf(frame.locator("#mfa")),
    rectOf(frame.locator("#save")),
  ]);
  const png = await page.screenshot();
  await page.close();
  return { png, win, account, mfaRow, toggle, save };
}

/** 画像の比率座標で 1 回クリックする。 */
async function clickRatio(page: Page, canvas: Locator, at: [number, number]): Promise<void> {
  const [x, y] = await toViewport(canvas, at[0], at[1]);
  await page.mouse.click(x, y);
}

test("紹介ページ用: 手順を 1 枚で伝える(番号スタンプ・矢印・スポットライト → トリミング → コピー)と縮めてコピーの設定", async ({
  browser,
}) => {
  const desk = await renderDesktop(browser);
  const context = await browser.newContext({
    viewport: { width: 1080, height: 720 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await routeCrossOriginAssets(page, desk.png);
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: { kind: "success", result: { ...sampleCaptureResult, id: "landing-steps-1" } },
    captureImageBase64: desk.png.toString("base64"),
  });
  await page.goto("/");
  const canvas = await captureAndWaitReady(page);
  await expect(page.locator("#clipboard-status")).toBeHidden({ timeout: 10_000 });

  const { account: a, mfaRow: r, toggle: t, save: s } = desk;
  // 1 px(CSS)を画像の比率にしたもの。
  const px = 1 / DESKTOP.width;
  const py = 1 / DESKTOP.height;

  // 矢印: ② の番号(行のまん中の空き)からトグルへ。
  const stamp2: [number, number] = [t.x - 92 * px, t.y + t.h / 2];
  await tool(page, "矢印");
  await drag(page, canvas, [stamp2[0] + 18 * px, stamp2[1]], [t.x - 6 * px, t.y + t.h / 2]);
  await page.keyboard.press("Escape");

  // 番号スタンプ ①②③(クリックごとに連番)。
  await page.getByRole("button", { name: "スタンプ(N)", exact: true }).click();
  await page.getByRole("button", { name: "スタンプ 番号", exact: true }).click();
  await clickRatio(page, canvas, [a.x + a.w - 16 * px, a.y + a.h / 2]);
  await page.keyboard.press("Escape");
  await clickRatio(page, canvas, stamp2);
  await page.keyboard.press("Escape");
  await clickRatio(page, canvas, [s.x + s.w + 12 * px, s.y + s.h / 2]);
  await page.keyboard.press("Escape");

  // スポットライト: 手順の 3 か所だけを明るく残す(穴の外は暗くなる)。
  await page.getByRole("button", { name: "スポットライト(S)", exact: true }).click();
  const holes: Array<[[number, number], [number, number]]> = [
    [[a.x - 4 * px, a.y - 4 * py], [a.x + a.w + 4 * px, a.y + a.h + 4 * py]],
    [[r.x - 6 * px, r.y - 2 * py], [r.x + r.w + 6 * px, r.y + r.h + 2 * py]],
    [[s.x - 6 * px, s.y - 6 * py], [s.x + s.w + 24 * px, s.y + s.h + 6 * py]],
  ];
  for (const [from, to] of holes) {
    await drag(page, canvas, from, to);
    await page.keyboard.press("Escape");
  }

  // トリミング: 設定の窓だけを残す(メニューバーやとなりのメモの窓を写さない)。
  await page.getByRole("button", { name: "トリミング(C)", exact: true }).click();
  await expect(page.locator("#crop-bar")).toBeVisible();
  const w = desk.win;
  await drag(page, canvas, [w.x, w.y], [w.x + w.w, w.y + w.h]);
  await expect(page.locator("#crop-bar").getByRole("button", { name: "確定" })).toBeEnabled();
  await page.mouse.move(1070, 710);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  const cropShot = await page.screenshot({ animations: "disabled" });

  await page.keyboard.press("Enter");
  await expect(page.locator("#crop-bar").getByRole("button", { name: "確定" })).toHaveCount(0);
  // 撮影時はスタンプツールを選び、種類(番号・✓・×・!・?)が出た状態にする。
  await page.getByRole("button", { name: "スタンプ(N)", exact: true }).click();
  await expect(page.getByRole("group", { name: "スタンプの種類" })).toBeVisible();
  // 確定のトースト(`切り抜きました。⌘Z で戻せます。`)が消えてから撮る。
  await expect(page.locator(".toast-region .toast:visible")).toHaveCount(0, { timeout: 10_000 });
  await page.mouse.move(1070, 710);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  const editorShot = await page.screenshot({ animations: "disabled" });
  const steps = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL("image/png"));

  // 縮めてコピー: 設定画面の項目(オンにした状態)。
  await emitTauriEvent(page, "settings://open");
  const dialog = page.getByRole("dialog", { name: "設定" });
  const shrink = dialog.getByRole("checkbox", { name: "コピーを等倍に縮める" });
  await expect(shrink).toBeEnabled();
  await shrink.check();
  await expect(shrink).toBeChecked();
  await page.mouse.move(1070, 710);
  const shrinkShot = await dialog.screenshot({ animations: "disabled" });
  await context.close();
  expect(pageErrors).toEqual([]);

  writeMedia("crop.png", cropShot);
  writeMedia("editor.png", editorShot);
  writeMedia("steps.png", Buffer.from(steps.replace(/^data:image\/png;base64,/, ""), "base64"));
  writeMedia("shrink-copy.png", shrinkShot);
});
