//! README と紹介ページ用: 自動マスキングの印と結果バー(`docs/media/auto-mask.png`)。
//!
//! 評価用の架空の画面(`eval/masking/images/billing.fhd.light.png`、架空データのみ)をエディタに
//! 読み込み、`scan_sensitive_text` のモック(`../fixtures/tauriMock.ts`)が**実機での実際の検出結果**を
//! 返す状態で印を出し、1 件を外して撮る。検出結果は `fixtures/auto-mask-candidates.json`
//! (矩形と種類だけ。文字列は含まない)で、Rust 側の `#[ignore]` テストが実機の Vision で `scan()` に
//! 通して書き出したもの:
//! `cd src-tauri && cargo test masking::eval::media_candidates -- --ignored`
//!
//! 画像は内容のある左上(カードの並ぶ範囲)だけを切り出して使う。左上を原点に切るため、
//! 候補の座標はそのまま使える(切り出し範囲の外の候補は除く)。
//!
//! 実行: `npx playwright test --config=e2e/screenshots/playwright.config.ts autoMaskMedia`
//! Vite dev server の監視対象に書き込むと再読み込みされうるため、書き出しは最後に行う
//! (`landing.visual.ts` と同じ)。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Browser } from "@playwright/test";

import { captureAndWaitReady } from "../fixtures/captureReady";
import {
  installTauriMocks,
  routeCrossOriginAssets,
  type MockCaptureResult,
  type MockScanCandidate,
} from "../fixtures/tauriMock";

const MEDIA_DIR = path.join(process.cwd(), "docs/media");
const EVAL_DIR = path.join(process.cwd(), "eval/masking");
const CANDIDATES_JSON = path.join(process.cwd(), "e2e/screenshots/fixtures/auto-mask-candidates.json");
const IMAGE_FILE = "billing.fhd.light.png";

/** 切り出す範囲(画像の左上から。カードの並ぶ範囲と、右端の印のラベルが収まる余白を含める)。 */
const CROP = { width: 1540, height: 672 };

/**
 * 外した状態にする 1 件: 請求元の会社名(自社名なので隠さなくてよい、として外した想定)。
 * 正解(`truth.json`)のこの矩形の中心を含む候補を外す。
 */
const EXCLUDED_TARGET = "billing#05";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 実際の検出結果(切り出し範囲の内側だけ)。 */
function loadDetectedCandidates(): MockScanCandidate[] {
  const detected = JSON.parse(readFileSync(CANDIDATES_JSON, "utf8")) as {
    image: string;
    candidates: MockScanCandidate[];
  };
  if (detected.image !== IMAGE_FILE) {
    throw new Error(`${CANDIDATES_JSON} is for ${detected.image}, not ${IMAGE_FILE}`);
  }
  return detected.candidates
    .filter((c) => c.x + c.width <= CROP.width && c.y + c.height <= CROP.height)
    .map(({ x, y, width, height, kind }) => ({ x, y, width, height, kind }));
}

/** 正解の矩形 1 つ(外す候補の位置を決めるのに使う)。 */
function truthRect(target: string): Rect {
  const truth = JSON.parse(readFileSync(path.join(EVAL_DIR, "truth.json"), "utf8")) as {
    images: { file: string; regions: (Rect & { target: string })[] }[];
  };
  const region = truth.images
    .find((im) => im.file === IMAGE_FILE)
    ?.regions.find((r) => r.target === target);
  if (!region) {
    throw new Error(`${target} is not in truth.json`);
  }
  return region;
}

/** 評価画像の左上 `CROP` を切り出した PNG を作る(依存を増やさないためブラウザの Canvas で切る)。 */
async function cropEvalImage(browser: Browser): Promise<Buffer> {
  const source = readFileSync(path.join(EVAL_DIR, "images", IMAGE_FILE)).toString("base64");
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(
    async ({ source, width, height }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${source}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      return canvas.toDataURL("image/png");
    },
    { source, ...CROP },
  );
  await page.close();
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
}

const captureResult: MockCaptureResult = {
  id: "landing-auto-mask-1",
  sourcePath: "/tmp/tadcap-captures/landing-auto-mask-1.png",
  kind: "range",
  createdAt: "2026-01-01T00:00:00.000Z",
};

test.beforeAll(() => {
  mkdirSync(MEDIA_DIR, { recursive: true });
});

test("紹介ページ用: 自動マスキングの印(1 件を外した状態)と結果バー", async ({ browser }) => {
  const candidates = loadDetectedCandidates();
  expect(new Set(candidates.map((c) => c.kind)).size).toBe(4);
  const target = truthRect(EXCLUDED_TARGET);
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  const excluded = candidates.find(
    (c) => c.x <= cx && cx <= c.x + c.width && c.y <= cy && cy <= c.y + c.height,
  );
  if (!excluded) {
    throw new Error(`no detected candidate covers ${EXCLUDED_TARGET}`);
  }

  const png = await cropEvalImage(browser);
  const context = await browser.newContext({
    viewport: { width: 1100, height: 640 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await routeCrossOriginAssets(page, png);
  await installTauriMocks(page, {
    initialPermissionState: "granted",
    capture: { kind: "success", result: captureResult },
    captureImageBase64: png.toString("base64"),
    textScan: { candidates },
  });
  await page.goto("/");
  const canvas = await captureAndWaitReady(page);
  // キャプチャ直後の自動コピーのトーストが消えてから撮る(`autoMask.visual.ts` と同じ)。
  await expect(page.locator("#clipboard-status")).toBeHidden({ timeout: 10_000 });

  await page.locator("#auto-mask-button").click();
  await expect(page.locator(".mask-overlay .mask-mark")).toHaveCount(candidates.length);

  // 外す 1 件: 画像上の矩形の中心をクリックする。
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("#capture-canvas is not visible");
  }
  const scale = box.width / CROP.width;
  await page.mouse.click(
    box.x + (excluded.x + excluded.width / 2) * scale,
    box.y + (excluded.y + excluded.height / 2) * scale,
  );
  await expect(page.locator(".mask-overlay .mask-mark--excluded")).toHaveCount(1);
  await expect(page.locator(".mask-bar__count")).toHaveText(
    `候補 ${candidates.length} 件(うち 1 件を外しています)`,
  );

  // ポインタを印から離し、ホバーの濃い塗りを写さない。印の配置の計算が済むまで 1 フレーム待つ。
  await page.mouse.move(2, 630);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  const shot = await page.screenshot();
  await context.close();

  writeFileSync(path.join(MEDIA_DIR, "auto-mask.png"), shot);
});
