#!/usr/bin/env node
/**
 * 自動マスキングの評価用画像セットを生成する(AM-T05、ARCH_auto-masking §10.3)。
 *
 * - `eval/masking/pages/*.html`(架空データの画面)を、既存の `@playwright/test` の Chromium で開き、
 *   フル HD(DPR 1)と Retina 相当(DPR 2)× 明るい/暗いテーマで撮影して `eval/masking/images/` に置く
 * - 各ページの `<span data-mask="<種類>/<細分>">` の表示領域(行ごと)を画像の画素に換算し、
 *   `eval/masking/truth.json`(画像・矩形・種類・細分)を書く。**読み取った文字列は書かない**
 * - 最後に自己検査(全矩形が画像の内側 / 細分ごとの件数が規定以上 / truth.json に文字列が無い)を行い、
 *   満たさなければ exit 1
 *
 * ネットワークには出ない(file:// 以外の要求はすべて中断する)。
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_DIR = path.join(ROOT, "eval", "masking");
const PAGES_DIR = path.join(EVAL_DIR, "pages");
const IMAGES_DIR = path.join(EVAL_DIR, "images");
const TRUTH_PATH = path.join(EVAL_DIR, "truth.json");

/** 種類(IPC の `kind`)ごとの細分。ARCH §5.3 の表の順 */
export const DETAILS = {
  contact: ["email", "phone", "address"],
  credential: ["prefixed_token", "random_string", "cue_value", "url_query"],
  identifier: ["cued_number", "person_ja", "person_en", "company"],
  financial: ["card", "account", "amount"],
};

/** 日本語の固有名詞(PRD §8.3: 種類ごと 30 件以上)。それ以外は 40 件以上 */
const PROPER_NOUN_DETAILS = new Set(["person_ja", "company", "address"]);
export const MIN_PER_IMAGE_COUNT = (detail) => (PROPER_NOUN_DETAILS.has(detail) ? 30 : 40);
/** 決定 #3 A: 画像ごとに数えるが、細分ごとに異なる文字列(= 異なる span)を 10 件以上 */
export const MIN_DISTINCT_TARGETS = 10;
export const MIN_IMAGES = 20;

/** 撮影条件。Retina 相当は 13 インチ級の論理解像度 1440x900 を DPR 2 で撮る(【仮定】) */
export const VARIANTS = [
  { id: "fhd", viewport: { width: 1920, height: 1080 }, dpr: 1 },
  { id: "retina", viewport: { width: 1440, height: 900 }, dpr: 2 },
];
export const THEMES = ["light", "dark"];

/** truth.json に許すキー(文字列の値を持つキーを紛れ込ませないための許可リスト) */
const ALLOWED_KEYS = {
  root: ["version", "generator", "details", "images"],
  image: ["file", "page", "variant", "theme", "dpr", "width", "height", "regions"],
  region: ["target", "line", "kind", "detail", "x", "y", "width", "height"],
};

/**
 * CSS px の矩形(文書座標)を画像の画素の矩形へ換算する。
 * スクロール位置を引いてビューポート座標にし、DPR を掛け、正解の文字を確実に含むよう外側へ丸める。
 * @param {{left:number, top:number, right:number, bottom:number}} rect 文書座標(CSS px)
 * @param {{dpr:number, scrollX?:number, scrollY?:number}} opts
 * @returns {{x:number, y:number, width:number, height:number}}
 */
export function cssRectToImagePixels(rect, { dpr, scrollX = 0, scrollY = 0 }) {
  const left = Math.floor((rect.left - scrollX) * dpr);
  const top = Math.floor((rect.top - scrollY) * dpr);
  const right = Math.ceil((rect.right - scrollX) * dpr);
  const bottom = Math.ceil((rect.bottom - scrollY) * dpr);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** PNG の IHDR から幅・高さを読む(依存を足さない) */
export function readPngSize(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !sig.every((b, i) => buf[i] === b)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function checkKeys(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where}: 許可されていないキー "${key}"`);
  }
}

/**
 * 自己検査。①全矩形が画像の内側 ②細分ごとの件数が規定以上 ③truth.json に文字列(キー・正解の文字)が無い
 * @param {object} truth truth.json の内容
 * @param {{imageSizes: Map<string,{width:number,height:number}|null>, targetTexts: Map<string,string>}} ctx
 *   targetTexts は target → 正解の文字列(メモリ上だけ。異なる文字列の数と漏れの検査に使う)
 * @returns {{errors: string[], counts: Record<string,{perImage:number, distinct:number}>}}
 */
export function selfCheck(truth, { imageSizes, targetTexts }) {
  const errors = [];
  const counts = {};
  for (const [kind, details] of Object.entries(DETAILS)) {
    for (const d of details) counts[`${kind}/${d}`] = { perImage: 0, distinct: 0 };
  }
  const distinct = new Map(Object.keys(counts).map((k) => [k, new Set()]));

  if (!truth || typeof truth !== "object") return { errors: ["truth が空"], counts };
  checkKeys(truth, ALLOWED_KEYS.root, "root", errors);
  const images = Array.isArray(truth.images) ? truth.images : [];
  if (images.length < MIN_IMAGES) errors.push(`画像が ${images.length} 枚(${MIN_IMAGES} 枚以上が必要)`);

  for (const img of images) {
    checkKeys(img, ALLOWED_KEYS.image, img.file ?? "image", errors);
    const size = imageSizes.get(img.file);
    if (!size) {
      errors.push(`${img.file}: 画像が無いか PNG でない`);
      continue;
    }
    if (size.width !== img.width || size.height !== img.height) {
      errors.push(`${img.file}: truth の大きさ ${img.width}x${img.height} と画像 ${size.width}x${size.height} が違う`);
    }
    const targetsInImage = new Set();
    for (const r of img.regions ?? []) {
      checkKeys(r, ALLOWED_KEYS.region, `${img.file} ${r.target}`, errors);
      const key = `${r.kind}/${r.detail}`;
      if (!(key in counts)) {
        errors.push(`${img.file} ${r.target}: 未知の種類/細分 ${key}`);
        continue;
      }
      const ints = [r.x, r.y, r.width, r.height].every(Number.isInteger);
      const inside =
        ints && r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 &&
        r.x + r.width <= size.width && r.y + r.height <= size.height;
      if (!inside) errors.push(`${img.file} ${r.target} 行 ${r.line}: 矩形が画像の外側か不正`);
      if (!targetsInImage.has(r.target)) {
        targetsInImage.add(r.target);
        counts[key].perImage += 1;
        distinct.get(key).add(targetTexts.get(r.target) ?? r.target);
      }
    }
  }

  for (const [key, c] of Object.entries(counts)) {
    c.distinct = distinct.get(key).size;
    const detail = key.split("/")[1];
    if (c.perImage < MIN_PER_IMAGE_COUNT(detail)) {
      errors.push(`${key}: 画像ごとの件数 ${c.perImage}(${MIN_PER_IMAGE_COUNT(detail)} 件以上が必要)`);
    }
    if (c.distinct < MIN_DISTINCT_TARGETS) {
      errors.push(`${key}: 異なる正解 ${c.distinct} 件(${MIN_DISTINCT_TARGETS} 件以上が必要)`);
    }
  }

  // ③ 正解の文字が JSON に紛れていない(短すぎる語は数字などと偶然一致するので 4 文字以上で見る)
  const json = JSON.stringify(truth);
  const leaked = [...targetTexts.values()].filter((t) => t.trim().length >= 4 && json.includes(t.trim()));
  if (leaked.length > 0) errors.push(`truth.json に正解の文字列が ${leaked.length} 件含まれる`);

  return { errors, counts };
}

/**
 * 全ページを撮影し、truth と(自己検査用に)正解の文字列を返す。文字列はメモリ上だけで使う。
 * @returns {Promise<{truth: object, maskTexts: string[]}>}
 */
async function generate() {
  const { chromium } = await import("@playwright/test");
  const pageFiles = (await readdir(PAGES_DIR)).filter((f) => f.endsWith(".html")).sort();
  await rm(IMAGES_DIR, { recursive: true, force: true });
  await mkdir(IMAGES_DIR, { recursive: true });

  const images = [];
  /** target → 正解の文字列(自己検査だけに使い、ファイルには書かない) */
  const targetTexts = new Map();
  const genErrors = [];
  const browser = await chromium.launch();
  try {
    for (const pageFile of pageFiles) {
      const base = pageFile.replace(/\.html$/, "");
      for (const variant of VARIANTS) {
        for (const theme of THEMES) {
          const context = await browser.newContext({
            viewport: variant.viewport,
            deviceScaleFactor: variant.dpr,
            colorScheme: theme,
            locale: "ja-JP",
          });
          // file:// 以外へは出ない
          await context.route("**/*", (route) =>
            route.request().url().startsWith("file:") ? route.continue() : route.abort(),
          );
          const page = await context.newPage();
          await page.goto(pathToFileURL(path.join(PAGES_DIR, pageFile)).href);
          await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === "1");
          await page.evaluate(() => document.fonts.ready);
          const measured = await page.evaluate(measureSpans);
          const file = `${base}.${variant.id}.${theme}.png`;
          await page.screenshot({ path: path.join(IMAGES_DIR, file), animations: "disabled", caret: "hide" });
          await context.close();

          const regions = [];
          for (const span of measured.spans) {
            const target = `${base}#${String(span.index).padStart(2, "0")}`;
            const [kind, detail] = span.mask.split("/");
            const prev = targetTexts.get(target);
            if (prev !== undefined && prev !== span.text) genErrors.push(`${target}: 撮影条件で文字列が変わった`);
            targetTexts.set(target, span.text);
            if (span.rects.length === 0) genErrors.push(`${file} ${target}: 表示領域が無い`);
            if (span.clipped) genErrors.push(`${file} ${target}: 親要素ではみ出して隠れている`);
            span.rects.forEach((rect, line) => {
              const px = cssRectToImagePixels(rect, { dpr: variant.dpr, scrollX: measured.scrollX, scrollY: measured.scrollY });
              regions.push({ target, line, kind, detail, ...px });
            });
          }
          images.push({
            file,
            page: pageFile,
            variant: variant.id,
            theme,
            dpr: variant.dpr,
            width: variant.viewport.width * variant.dpr,
            height: variant.viewport.height * variant.dpr,
            regions,
          });
        }
      }
    }
  } finally {
    await browser.close();
  }

  const truth = {
    version: 1,
    generator: "scripts/mask-eval-fixtures.mjs",
    details: DETAILS,
    images,
  };
  await writeFile(TRUTH_PATH, `${JSON.stringify(truth, null, 1)}\n`);
  return { truth, targetTexts, genErrors };
}

/**
 * ページ内で実行: data-mask の span ごとに、行ごとの矩形(文書座標の CSS px)を返す。
 * 親要素の overflow で切られて見えない span は clipped にする。
 */
function measureSpans() {
  const sx = window.scrollX;
  const sy = window.scrollY;
  const spans = [...document.querySelectorAll("[data-mask]")].map((el, index) => {
    const rects = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    let clipped = false;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const st = getComputedStyle(a);
      if (st.overflowX === "visible" && st.overflowY === "visible") continue;
      const box = a.getBoundingClientRect();
      if (rects.some((r) => r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5)) {
        clipped = true;
      }
    }
    return {
      index,
      mask: el.dataset.mask,
      text: el.textContent,
      clipped,
      rects: rects.map((r) => ({ left: r.left + sx, top: r.top + sy, right: r.right + sx, bottom: r.bottom + sy })),
    };
  });
  return { scrollX: sx, scrollY: sy, spans };
}

async function loadImageSizes(truth) {
  const sizes = new Map();
  for (const img of truth.images ?? []) {
    try {
      sizes.set(img.file, readPngSize(await readFile(path.join(IMAGES_DIR, img.file))));
    } catch {
      sizes.set(img.file, null);
    }
  }
  return sizes;
}

async function main() {
  const { truth, targetTexts, genErrors } = await generate();
  const imageSizes = await loadImageSizes(truth);
  const { errors: checkErrors, counts } = selfCheck(truth, { imageSizes, targetTexts });
  const errors = [...genErrors, ...checkErrors];

  console.log(`画像: ${(truth.images ?? []).length} 枚`);
  console.log("細分ごとの件数(画像ごと / 異なる正解):");
  for (const [key, c] of Object.entries(counts)) {
    console.log(`  ${key.padEnd(28)} ${String(c.perImage).padStart(4)} / ${String(c.distinct).padStart(3)}`);
  }
  if (errors.length > 0) {
    console.error(`自己検査 NG(${errors.length} 件)`);
    for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("自己検査 OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
