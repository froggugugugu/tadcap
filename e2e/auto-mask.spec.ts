//! E2Eテスト: 機密情報の自動マスキング(AM-T17、ARCH_auto-masking §10.2、UI_auto-masking §1〜§6、
//! PRD_auto-masking FR-001・FR-008〜FR-012・FR-014・NFR-005)。
//!
//! OS の文字認識そのものは対象外(既存方針)。`scan_sensitive_text` は `tauriMock.ts` で
//! 固定の候補(矩形と種類だけ。文字列は含めない)・保留・失敗・0 件を返す。
//!
//! 画像は `sampleCapturePng.ts` の 300×200 のチェッカーボード(タイル 6px、モザイクのブロック 12px)。
//! 候補の矩形は 12 の倍数にそろえ、モザイク後はどの画素も元の 2 色のどちらとも違う混色になる
//! (= 候補の領域の全画素が変わる)ようにしてある。
//!
//! 印のレイヤーは `offsetLeft` の丸めで最大 0.5px ずれるため、印と画像上の領域の比較は 1px の許容差で行う。

import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureAndWaitReady } from "./fixtures/captureReady";
import { diffFromSnapshot, saveSnapshot } from "./fixtures/canvasSnapshot";
import { createFixtureCapturePng } from "./fixtures/sampleCapturePng";
import {
  getClipboardImageStats,
  getClipboardWriteCount,
  getTextScanCalls,
  installTauriMocks,
  releaseTextScans,
  routeCrossOriginAssets,
  setTextScanBehavior,
  type MockCaptureResult,
  type MockScanCandidate,
} from "./fixtures/tauriMock";

function captureResult(n: number): MockCaptureResult {
  return {
    id: `e2e-auto-mask-${n}`,
    sourcePath: `/tmp/tadcap-captures/e2e-auto-mask-${n}.png`,
    kind: "range",
    createdAt: `2024-01-01T00:00:0${n}.000Z`,
  };
}

const IMAGE_WIDTH = 300;
const IMAGE_HEIGHT = 200;

/** 4 種の候補(入力の順 = `data-candidate-id`)。印の Tab の順も同じ(上から下、同じ行は左から右)。 */
const CANDIDATES: MockScanCandidate[] = [
  { x: 12, y: 12, width: 96, height: 24, kind: "contact" },
  { x: 168, y: 12, width: 96, height: 24, kind: "credential" },
  { x: 12, y: 96, width: 72, height: 24, kind: "identifier" },
  { x: 168, y: 144, width: 96, height: 36, kind: "financial" },
];

const MARK_NAMES = ["連絡先の候補", "認証情報の候補", "識別子の候補", "金額・口座の候補"] as const;

/** NFR-005 の禁止語(UI_auto-masking §5.1)。 */
const FORBIDDEN_WORDS = ["安全", "すべて隠しました", "機密はありません", "自動で隠す"];

const MESSAGES = {
  scanning: "機密らしい箇所を探しています…",
  hint: "印をクリックすると外せます。見落としがないか目でも確かめてください。",
  empty: "候補は見つかりませんでした。",
  emptyHint: "貼る前に画像を目で確かめてください。",
  failed: "文字を読み取れませんでした。画像は変更していません。",
  applied: (k: number) => `候補 ${k} 件にモザイクをかけました。⌘Z で戻せます。`,
};

/** 印の位置の許容差(CSS px)。`offsetLeft` の整数丸めで最大 0.5px ずれるため。 */
const POSITION_TOLERANCE = 1;

function autoMaskButton(page: Page): Locator {
  return page.locator("#auto-mask-button");
}

function maskBar(page: Page): Locator {
  return page.locator("#mask-bar");
}

function marks(page: Page): Locator {
  return page.locator(".mask-overlay .mask-mark");
}

function mark(page: Page, index: number): Locator {
  return page.getByRole("button", { name: MARK_NAMES[index], exact: true });
}

/** 候補の矩形ごとの差分バイト数と、どの候補にも入らない領域の差分バイト数。 */
async function diffByRegion(
  canvas: Locator,
  snapshotName: string,
  rects: readonly MockScanCandidate[],
): Promise<{ inside: number[]; outside: number }> {
  return canvas.evaluate(
    (el: HTMLCanvasElement, { key, rects }) => {
      const now = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
      const w = window as unknown as { __snapshots: Record<string, Uint8ClampedArray> };
      const before = w.__snapshots[key]!;
      const inside = rects.map(() => 0);
      let outside = 0;
      for (let y = 0; y < el.height; y += 1) {
        for (let x = 0; x < el.width; x += 1) {
          const i = (y * el.width + x) * 4;
          let changed = 0;
          for (let c = 0; c < 4; c += 1) {
            if (now[i + c] !== before[i + c]) changed += 1;
          }
          if (changed === 0) continue;
          const hit = rects.findIndex(
            (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
          );
          if (hit === -1) outside += changed;
          else inside[hit] += changed;
        }
      }
      return { inside, outside };
    },
    { key: snapshotName, rects },
  );
}

/**
 * 各印の表示上の矩形と、候補の画像上の矩形を Canvas の表示倍率で変換した矩形の、最大のずれ(CSS px)。
 */
async function maxMarkOffset(
  page: Page,
  candidates: readonly MockScanCandidate[],
  imageSize: { width: number; height: number },
): Promise<number> {
  const canvasBox = await page.locator("#capture-canvas").boundingBox();
  if (!canvasBox) throw new Error("#capture-canvas is not visible");
  const scaleX = canvasBox.width / imageSize.width;
  const scaleY = canvasBox.height / imageSize.height;
  let max = 0;
  for (const [i, c] of candidates.entries()) {
    const box = await page.locator(`.mask-mark[data-candidate-id="${i}"]`).boundingBox();
    if (!box) return Number.POSITIVE_INFINITY;
    const expected = {
      x: canvasBox.x + c.x * scaleX,
      y: canvasBox.y + c.y * scaleY,
      width: c.width * scaleX,
      height: c.height * scaleY,
    };
    max = Math.max(
      max,
      Math.abs(box.x - expected.x),
      Math.abs(box.y - expected.y),
      Math.abs(box.x + box.width - (expected.x + expected.width)),
      Math.abs(box.y + box.height - (expected.y + expected.height)),
    );
  }
  return max;
}

/** `scan_sensitive_text` が `n` 回呼ばれるまで待つ(保留の解除は呼び出しが届いてから行う)。 */
async function waitForScanCalls(page: Page, n: number): Promise<void> {
  await expect.poll(async () => (await getTextScanCalls(page)).length).toBe(n);
}

/** 結果バーと印が出るまで待つ(確認中)。 */
async function expectReview(page: Page, count: number): Promise<void> {
  await expect(maskBar(page)).toBeVisible();
  await expect(page.locator(".mask-bar__count")).toHaveText(`候補 ${count} 件`);
  await expect(marks(page)).toHaveCount(count);
}

/** 候補が捨てられた(`idle`)状態であることを確かめる。 */
async function expectIdle(page: Page): Promise<void> {
  await expect(maskBar(page)).toBeHidden();
  await expect(marks(page)).toHaveCount(0);
  await expect(autoMaskButton(page)).toBeEnabled();
}

test.describe("自動マスキング(AM-T17)", () => {
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
      capture: { kind: "success", result: captureResult(1) },
      captureImageBase64: fixturePng.toString("base64"),
      captureResults: [captureResult(1), captureResult(2), captureResult(3)],
      textScan: { candidates: CANDIDATES },
    });
    await page.goto("/");
  });

  test("画像が無いときはボタンが押せず、⌘⇧M でも読み取りが始まらない", async ({ page }) => {
    const button = autoMaskButton(page);
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-label", "機密らしい箇所を探す(⌘⇧M)");
    await expect(button).toHaveAttribute("title", "機密らしい箇所を探す(⌘⇧M)");
    await expect(button).not.toHaveAttribute("aria-pressed", /.*/);
    // ボタンは取り消し/やり直しのグループとコピーの間(UI 仕様 §1.1)。区切り線を挟んでコピーが続く。
    const order = await page.evaluate(() => {
      const el = document.querySelector("#auto-mask-button");
      return {
        prev: el?.previousElementSibling?.className ?? "",
        next: el?.nextElementSibling?.className ?? "",
        afterNext: el?.nextElementSibling?.nextElementSibling?.id ?? "",
      };
    });
    expect(order).toEqual({
      prev: "toolbar__divider",
      next: "toolbar__divider",
      afterNext: "clipboard-copy-button",
    });

    await page.keyboard.press("Meta+Shift+M");
    await expect(maskBar(page)).toBeHidden();
    expect(await getTextScanCalls(page)).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test(
    "一連の流れ: 処理中の表示 → 印 → 1 件外す → まとめてモザイク → 外した領域は不変・残りは変化 → " +
      "⌘Z で全候補分が戻る → ⇧⌘Z で再びかかる",
    async ({ page }) => {
      const canvas = await captureAndWaitReady(page);
      await saveSnapshot(canvas, "original");
      await setTextScanBehavior(page, { candidates: CANDIDATES, hold: true });

      await autoMaskButton(page).click();

      // 処理中: バーにリングと文言、ボタンは出さない。実行ボタンは押せない(FR-008・UI 仕様 §2)。
      await expect(maskBar(page)).toBeVisible();
      await expect(page.locator(".mask-bar__count")).toHaveText(MESSAGES.scanning);
      await expect(page.locator(".mask-bar__status")).toHaveAttribute("role", "status");
      await expect(page.locator(".mask-bar__spinner")).toBeVisible();
      await expect(page.locator(".mask-bar__button:visible")).toHaveCount(0);
      await expect(autoMaskButton(page)).toBeDisabled();
      await expect(marks(page)).toHaveCount(0);

      await waitForScanCalls(page, 1);
      await releaseTextScans(page);

      // 結果: 件数・補足・やめる・まとめてモザイク、印 4 件(種類のラベル付き)。
      await expectReview(page, 4);
      await expect(page.locator(".mask-bar__spinner")).toBeHidden();
      await expect(page.locator(".mask-bar__hint")).toHaveText(MESSAGES.hint);
      await expect(maskBar(page).getByRole("button", { name: /やめる/ })).toBeVisible();
      await expect(maskBar(page).locator("kbd")).toHaveText("esc");
      const apply = maskBar(page).getByRole("button", { name: "まとめてモザイク" });
      await expect(apply).toBeEnabled();
      const labels = await marks(page).locator(".mask-mark__label").allTextContents();
      expect(labels).toEqual(["連絡先", "認証情報", "識別子", "金額・口座"]);
      for (let i = 0; i < 4; i += 1) {
        await expect(mark(page, i)).toHaveAttribute("aria-pressed", "true");
        await expect(mark(page, i)).toHaveAttribute("title", "クリックで外す");
      }
      // 読み取りに送ったのはベースの PNG 1 枚だけ。
      const calls = await getTextScanCalls(page);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.isPng).toBe(true);
      expect(calls[0]!.byteLength).toBeGreaterThan(0);
      // 印は Canvas に描かない。
      expect(await diffFromSnapshot(canvas, "original")).toBe(0);

      // 印のクリックで外す → 戻す → もう一度外す(aria-pressed・title・見た目のクラス・件数の文)。
      await mark(page, 1).click();
      await expect(mark(page, 1)).toHaveAttribute("aria-pressed", "false");
      await expect(mark(page, 1)).toHaveAttribute("title", "クリックで戻す");
      await expect(mark(page, 1)).toHaveClass(/mask-mark--excluded/);
      await expect(page.locator(".mask-bar__count")).toHaveText("候補 4 件(うち 1 件を外しています)");
      await mark(page, 1).click();
      await expect(mark(page, 1)).toHaveAttribute("aria-pressed", "true");
      await expect(mark(page, 1)).not.toHaveClass(/mask-mark--excluded/);
      await expect(page.locator(".mask-bar__count")).toHaveText("候補 4 件");
      // キーボード(Space)でも外せる。
      await mark(page, 1).focus();
      await page.keyboard.press("Space");
      await expect(mark(page, 1)).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator(".mask-bar__count")).toHaveText("候補 4 件(うち 1 件を外しています)");

      // まとめてモザイク: 残り 3 件だけが変わり、外した 1 件と候補の外は変わらない(FR-011)。
      await apply.click();
      await expectIdle(page);
      await expect(page.locator("#capture-status")).toHaveText(MESSAGES.applied(3));
      const afterApply = await diffByRegion(canvas, "original", CANDIDATES);
      expect(afterApply.outside).toBe(0);
      expect(afterApply.inside[1]).toBe(0);
      for (const i of [0, 2, 3]) {
        const c = CANDIDATES[i]!;
        // 全画素の RGB(3 チャンネル)が変わる(アルファは不変)。
        expect(afterApply.inside[i]).toBe(c.width * c.height * 3);
      }
      await saveSnapshot(canvas, "mosaic");

      // ⌘Z 1 回で全候補分が戻る。
      await page.keyboard.press("Meta+Z");
      await expect.poll(() => diffFromSnapshot(canvas, "original")).toBe(0);
      // ⇧⌘Z で再びかかる。
      await page.keyboard.press("Meta+Shift+Z");
      await expect.poll(() => diffFromSnapshot(canvas, "mosaic")).toBe(0);

      expect(pageErrors).toEqual([]);
    },
  );

  test("⌘⇧M で始められ、処理中のボタン・⌘⇧M の再押下で読み取りは 1 回しか呼ばれない", async ({ page }) => {
    await captureAndWaitReady(page);
    await setTextScanBehavior(page, { candidates: CANDIDATES, hold: true });

    await page.keyboard.press("Meta+Shift+M");
    await expect(page.locator(".mask-bar__count")).toHaveText(MESSAGES.scanning);
    await expect(autoMaskButton(page)).toBeDisabled();

    await page.keyboard.press("Meta+Shift+M");
    await autoMaskButton(page).click({ force: true }); // 無効なボタンの押下(イベントは発火しない)
    await page.keyboard.press("Meta+Shift+M");
    await waitForScanCalls(page, 1);
    await page.waitForTimeout(200); // 2 回目が送られる余地を残してから数え直す
    expect(await getTextScanCalls(page)).toHaveLength(1);

    await releaseTextScans(page);
    await expectReview(page, 4);
    // 確認中も実行ボタンは押せず、⌘⇧M も無視する(UI 仕様 §1.4)。
    await expect(autoMaskButton(page)).toBeDisabled();
    await page.keyboard.press("Meta+Shift+M");
    await expectReview(page, 4);
    expect(await getTextScanCalls(page)).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  });

  test("全件を外すとまとめてモザイクは押せない。やめるで印とバーが消え、画像は変わらない", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await saveSnapshot(canvas, "original");
    await autoMaskButton(page).click();
    await expectReview(page, 4);

    for (let i = 0; i < 4; i += 1) {
      await mark(page, i).click();
    }
    await expect(page.locator(".mask-bar__count")).toHaveText("候補 4 件(うち 4 件を外しています)");
    await expect(maskBar(page).getByRole("button", { name: "まとめてモザイク" })).toBeDisabled();

    await maskBar(page).getByRole("button", { name: /やめる/ }).click();
    await expectIdle(page);
    expect(await diffFromSnapshot(canvas, "original")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("Esc でやめる。印とバーが消え、画像は変わらず、もう一度始められる", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await saveSnapshot(canvas, "original");
    await autoMaskButton(page).click();
    await expectReview(page, 4);

    await page.keyboard.press("Escape");
    await expectIdle(page);
    expect(await diffFromSnapshot(canvas, "original")).toBe(0);

    await page.keyboard.press("Meta+Shift+M");
    await expectReview(page, 4);
    expect(await getTextScanCalls(page)).toHaveLength(2);
    expect(pageErrors).toEqual([]);
  });

  test("印を出したまま ⌘C でコピーした画像に印が写らない(画素で確認)", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    await saveSnapshot(canvas, "original");
    await autoMaskButton(page).click();
    await expectReview(page, 4);
    await mark(page, 2).click(); // 外した印(破線)も写らないこと

    const writesBefore = await getClipboardWriteCount(page);
    await page.keyboard.press("Meta+C");
    await expect(page.locator("#clipboard-status")).toHaveText("クリップボードにコピーしました。");
    expect(await getClipboardWriteCount(page)).toBe(writesBefore + 1);

    // コピーした画像 = 表示 Canvas = 読み取り前の画像(印の色・縁取りの画素を含まない)。
    expect(await diffFromSnapshot(canvas, "original")).toBe(0);
    const stats = await getClipboardImageStats(page, { r: 0, g: 0, b: 0 }, 0);
    expect(stats).not.toBeNull();
    expect(stats!.width).toBe(IMAGE_WIDTH);
    expect(stats!.height).toBe(IMAGE_HEIGHT);
    expect(stats!.equalsCanvas).toBe(true);
    expect(stats!.nearWhitePixels).toBe(0); // 白の縁取り・ラベルの白文字は写らない
    // コピーしても候補は残る(警告も出さない、FR-012)。
    await expect(marks(page)).toHaveCount(4);
    await expect(mark(page, 2)).toHaveAttribute("aria-pressed", "false");
    expect(pageErrors).toEqual([]);
  });

  test("確認中は取り消し・やり直し・ツールが効かず、やめると元に戻る", async ({ page }) => {
    const canvas = await captureAndWaitReady(page);
    // 取り消せる操作を 1 つ積んでおく(既存のモザイクツール)。
    await page.getByRole("button", { name: "モザイク" }).click();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 120, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 120, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator("#undo-button")).toBeEnabled();
    await saveSnapshot(canvas, "edited");

    await autoMaskButton(page).click();
    await expectReview(page, 4);

    await expect(page.locator("#undo-button")).toBeDisabled();
    await expect(page.locator("#redo-button")).toBeDisabled();
    const toolButtons = page.locator("#tool-toolbar button");
    const toolCount = await toolButtons.count();
    expect(toolCount).toBeGreaterThan(0);
    for (let i = 0; i < toolCount; i += 1) {
      await expect(toolButtons.nth(i)).toBeDisabled();
    }
    // コピー・キャプチャは押せる(UI 仕様 §6)。
    await expect(page.getByRole("button", { name: "クリップボードにコピー" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "キャプチャ" })).toBeEnabled();

    await page.keyboard.press("Meta+Z");
    await page.keyboard.press("Meta+Shift+Z");
    // 印以外(画像の右下の候補の無い所)をクリックしても Canvas は変わらない。
    await page.mouse.click(box.x + 120, box.y + 180);
    expect(await diffFromSnapshot(canvas, "edited")).toBe(0);
    await expectReview(page, 4);

    await page.keyboard.press("Escape");
    await expectIdle(page);
    await expect(page.locator("#undo-button")).toBeEnabled();
    await expect(toolButtons.first()).toBeEnabled();
    await page.keyboard.press("Meta+Z");
    await expect.poll(() => diffFromSnapshot(canvas, "edited")).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });

  test("0 件: 結果バーに 0 件の文言(禁止語なし)と「閉じる」だけを出し、閉じる・Esc で消える", async ({ page }) => {
    await captureAndWaitReady(page);
    await setTextScanBehavior(page, { candidates: [] });

    await autoMaskButton(page).click();
    await expect(maskBar(page)).toBeVisible();
    await expect(page.locator(".mask-bar__count")).toHaveText(MESSAGES.empty);
    await expect(page.locator(".mask-bar__hint")).toHaveText(MESSAGES.emptyHint);
    await expect(marks(page)).toHaveCount(0);
    const visibleButtons = maskBar(page).locator("button:visible");
    await expect(visibleButtons).toHaveCount(1);
    await expect(visibleButtons).toHaveText("閉じる", { useInnerText: true });
    await expect(maskBar(page).locator("kbd")).toBeHidden();
    const barText = (await maskBar(page).innerText()) + (await page.locator("#capture-status").innerText());
    for (const word of FORBIDDEN_WORDS) {
      expect(barText).not.toContain(word);
    }

    await visibleButtons.click();
    await expectIdle(page);

    // Esc でも閉じる。
    await autoMaskButton(page).click();
    await expect(page.locator(".mask-bar__count")).toHaveText(MESSAGES.empty);
    await page.keyboard.press("Escape");
    await expectIdle(page);
    expect(pageErrors).toEqual([]);
  });

  for (const [title, behavior] of [
    ["読み取りの失敗", { fail: "text_scan_failed" }],
    ["別の読み取りが実行中", { fail: "text_scan_busy" }],
    // 想定外のキー(数値のみ。文字列は入れない)を持つ応答は全体を失敗にする(ARCH §7.2)。
    ["応答の形の不正", { response: [{ ...CANDIDATES[0], score: 1 }] }],
  ] as const) {
    test(`失敗(${title}): エラーのトーストを出し、印は出さず、画像は変わらない`, async ({ page }) => {
      const canvas = await captureAndWaitReady(page);
      await saveSnapshot(canvas, "original");
      await setTextScanBehavior(page, behavior);

      await autoMaskButton(page).click();
      await expect(page.locator("#capture-status")).toHaveText(MESSAGES.failed);
      await expectIdle(page);
      expect(await diffFromSnapshot(canvas, "original")).toBe(0);
      expect(pageErrors).toEqual([]);
    });
  }

  test("処理中に新規キャプチャすると、古い結果の印は出ない", async ({ page }) => {
    await captureAndWaitReady(page);
    await setTextScanBehavior(page, { candidates: CANDIDATES, hold: true });
    await autoMaskButton(page).click();
    await expect(page.locator(".mask-bar__count")).toHaveText(MESSAGES.scanning);
    await waitForScanCalls(page, 1);

    const canvas = await captureAndWaitReady(page, 2);
    await expect(maskBar(page)).toBeHidden();
    await saveSnapshot(canvas, "second");

    await releaseTextScans(page);
    // 古い応答が届いても印・バーは出ない(結果は token と画像の照合で捨てる)。
    await page.waitForTimeout(300);
    await expectIdle(page);
    expect(await diffFromSnapshot(canvas, "second")).toBe(0);

    // 新しい画像ではもう一度始められる。
    await setTextScanBehavior(page, { candidates: CANDIDATES });
    await autoMaskButton(page).click();
    await expectReview(page, 4);
    expect(await getTextScanCalls(page)).toHaveLength(2);
    expect(pageErrors).toEqual([]);
  });

  test("処理中に履歴を切り替えると、古い結果の印は出ない", async ({ page }) => {
    await captureAndWaitReady(page);
    await captureAndWaitReady(page, 2);
    await setTextScanBehavior(page, { candidates: CANDIDATES, hold: true });
    await autoMaskButton(page).click();
    await expect(page.locator(".mask-bar__count")).toHaveText(MESSAGES.scanning);
    await waitForScanCalls(page, 1);

    // 古い方(一覧の 2 番目)へ切り替える。
    await page.locator(".history-sidebar__item").nth(1).locator(".history-sidebar__thumbnail-button").click();
    await expect(page.locator(".history-sidebar__item").nth(1)).toHaveClass(/history-sidebar__item--selected/);
    await expect(maskBar(page)).toBeHidden();

    await releaseTextScans(page);
    await page.waitForTimeout(300);
    await expectIdle(page);
    expect(pageErrors).toEqual([]);
  });

  test("確認中に画像を切り替えると候補が消える(新規キャプチャ・履歴の切替)", async ({ page }) => {
    await captureAndWaitReady(page);
    await autoMaskButton(page).click();
    await expectReview(page, 4);

    await captureAndWaitReady(page, 2);
    await expectIdle(page);

    await autoMaskButton(page).click();
    await expectReview(page, 4);
    await page.locator(".history-sidebar__item").nth(1).locator(".history-sidebar__thumbnail-button").click();
    await expect(page.locator(".history-sidebar__item").nth(1)).toHaveClass(/history-sidebar__item--selected/);
    await expectIdle(page);
    expect(pageErrors).toEqual([]);
  });
});

test.describe("自動マスキング: ウィンドウの大きさを変えても印がずれない(AM-T17)", () => {
  // 表示領域より大きい画像にして、Canvas が縮小表示される状態で確かめる。
  const BIG_WIDTH = 1200;
  const BIG_HEIGHT = 800;
  const bigPng = createFixtureCapturePng(BIG_WIDTH, BIG_HEIGHT);
  const bigCandidates: MockScanCandidate[] = [
    { x: 48, y: 36, width: 300, height: 60, kind: "contact" },
    { x: 700, y: 36, width: 360, height: 60, kind: "credential" },
    { x: 96, y: 420, width: 240, height: 48, kind: "identifier" },
    { x: 840, y: 700, width: 300, height: 72, kind: "financial" },
  ];

  test("縮小表示の印が候補の領域と 1px 以内で重なり、ウィンドウを縮めても追従する", async ({ page }) => {
    await routeCrossOriginAssets(page, bigPng);
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await installTauriMocks(page, {
      initialPermissionState: "granted",
      capture: { kind: "success", result: captureResult(1) },
      captureImageBase64: bigPng.toString("base64"),
      textScan: { candidates: bigCandidates },
    });
    await page.goto("/");
    const canvas = await captureAndWaitReady(page);
    await autoMaskButton(page).click();
    await expectReview(page, 4);

    const size = { width: BIG_WIDTH, height: BIG_HEIGHT };
    const before = (await canvas.boundingBox())!;
    expect(before.width).toBeLessThan(BIG_WIDTH); // 縮小表示になっている
    await expect.poll(() => maxMarkOffset(page, bigCandidates, size)).toBeLessThanOrEqual(POSITION_TOLERANCE);

    await page.setViewportSize({ width: 900, height: 560 });
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBeLessThan(before.width);
    await expect.poll(() => maxMarkOffset(page, bigCandidates, size)).toBeLessThanOrEqual(POSITION_TOLERANCE);

    await page.setViewportSize({ width: 1400, height: 900 });
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(before.width);
    await expect.poll(() => maxMarkOffset(page, bigCandidates, size)).toBeLessThanOrEqual(POSITION_TOLERANCE);
    expect(pageErrors).toEqual([]);
  });
});
