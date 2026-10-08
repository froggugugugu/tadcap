#!/usr/bin/env node
// 配布アプリに組み込まれる依存のライセンス全文を THIRD_PARTY_LICENSES.md にまとめる。
//
//   node scripts/gen-third-party-licenses.mjs          # 作り直して書き込む
//   node scripts/gen-third-party-licenses.mjs --check  # 作り直した結果がファイルと同じか確かめる(違えば exit 1)
//
// 対象: Rust はルート(tadcap)から通常の依存として辿れるクレート(Apple silicon の macOS 向けに解決したもの。
// ビルド用・開発用だけの依存はアプリに入らないので除く)、npm は package-lock.json の本番依存。
// 各パッケージに同梱されたライセンス・著作権表示のファイルを全文載せる。ファイルが無く MIT を選べるものは、
// 作者を著作権者とした MIT の全文を載せる。どちらもできないパッケージがあれば失敗する(表示漏れを出さない)。
// 依存パッケージを追加せず、Node 標準機能だけで実装する。
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUTPUT = "THIRD_PARTY_LICENSES.md";
const TARGET = "aarch64-apple-darwin";

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)([-._][a-z0-9.-]+)?$/i;
const NOT_LICENSE_EXT = /\.(rs|json|toml|js|ts|ya?ml)$/i;

export function isLicenseFileName(name) {
  return LICENSE_FILE.test(name) && !NOT_LICENSE_EXT.test(name);
}

// cargo metadata の resolve グラフをルートから辿り、通常の依存(kind が null)として届くパッケージを返す。
export function collectShippedCrates(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const root = metadata.resolve.root;
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const d of nodes.get(queue.shift())?.deps ?? []) {
      if (!d.dep_kinds.some((k) => k.kind === null) || seen.has(d.pkg)) continue;
      seen.add(d.pkg);
      queue.push(d.pkg);
    }
  }
  seen.delete(root);
  return metadata.packages.filter((p) => seen.has(p.id)).sort(byNameVersion);
}

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// 作者のメールアドレスは載せない(表示に要るのは著作権者の名前)。
export function mitFallbackText(authors) {
  const names = authors.map((a) => a.replace(/\s*<[^>]*>\s*/g, "").trim()).filter(Boolean);
  const holder = names.length > 0 ? names.join(", ") : "the package authors";
  return `MIT License\n\nCopyright (c) ${holder}\n\n${MIT_BODY}`;
}

const normalize = (text) => `${text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd()}\n`;
function byNameVersion(a, b) {
  return a.name === b.name ? (a.version < b.version ? -1 : a.version > b.version ? 1 : 0) : a.name < b.name ? -1 : 1;
}

// entries: [{ name, version, license, texts: [{ file, text }] }]。全文が同じパッケージはまとめて 1 回だけ載せる。
export function renderLicenses(entries) {
  const groups = new Map();
  for (const e of [...entries].sort(byNameVersion)) {
    const body = e.texts
      .map((t) => ({ file: t.file, text: normalize(t.text) }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      .map((t) => `${t.file}:\n\n\`\`\`text\n${t.text}\`\`\`\n`)
      .join("\n");
    if (!groups.has(body)) groups.set(body, []);
    groups.get(body).push(`${e.name} ${e.version}(${e.license || "license field なし"})`);
  }
  const sections = [...groups.entries()]
    .sort(([, a], [, b]) => (a[0] < b[0] ? -1 : 1))
    .map(([body, names]) => `## ${names.join(" / ")}\n\n${body}`);
  return `# サードパーティのライセンス全文

配布アプリ(Tadcap.app)に組み込まれている依存パッケージのライセンス・著作権表示の全文です。
\`scripts/gen-third-party-licenses.mjs\` が \`src-tauri/Cargo.lock\` と \`package-lock.json\` から生成します(手で編集しない)。
複数のライセンスから選べるパッケージは、パッケージに同梱されたライセンスファイルをすべて載せています。

${sections.join("\n")}`;
}

function licenseTextsIn(dir) {
  return readdirSync(dir)
    .filter((f) => isLicenseFileName(f) && statSync(join(dir, f)).isFile())
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));
}

// パッケージにライセンスファイルが入っていないもののうち、同じライセンスの全文を同じ依存ツリーの別パッケージから
// 取れるもの。追加するときは、上流のリポジトリと著作権者が同じか(BSD など著作権表示を含むもの)、
// 全文に著作権者を含まない定型文か(MPL-2.0)を確かめ、理由をここに書く。
//   alloc-stdlib: alloc-no-stdlib と同じリポジトリ(dropbox/rust-alloc-no-stdlib)の BSD-3-Clause
//   selectors: MPL-2.0 の定型文(著作権者を含まない)。cssparser の LICENSE が同じ全文
export const LICENSE_FROM = { "alloc-stdlib": "alloc-no-stdlib", selectors: "cssparser" };

const missing = [];
function withFallback(name, version, license, authors, texts) {
  if (texts.length > 0) return texts;
  if (/\bMIT\b/.test(license ?? "")) return [{ file: "(ライセンスファイル無し。MIT を選択)", text: mitFallbackText(authors) }];
  missing.push(`${name} ${version}(license = ${license})`);
  return [];
}

function rustEntries() {
  const json = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--filter-platform", TARGET],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const metadata = JSON.parse(json);
  return collectShippedCrates(metadata).map((p) => {
    const dir = dirname(p.manifest_path);
    const texts = licenseTextsIn(dir);
    const from = texts.length === 0 && metadata.packages.find((q) => q.name === LICENSE_FROM[p.name] && q.license === p.license);
    if (from) {
      for (const t of licenseTextsIn(dirname(from.manifest_path))) texts.push({ file: `${t.file}(${from.name} ${from.version} から。同じライセンス)`, text: t.text });
    }
    if (p.license_file) {
      const file = p.license_file.replace(/^\.\//, "");
      if (!texts.some((t) => t.file === file)) texts.push({ file, text: readFileSync(join(dir, file), "utf8") });
    }
    return { name: p.name, version: p.version, license: p.license, texts: withFallback(p.name, p.version, p.license, p.authors, texts) };
  });
}

function npmEntries() {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  return Object.entries(lock.packages)
    .filter(([path, p]) => path.startsWith("node_modules/") && !p.dev)
    .map(([path, p]) => {
      const name = path.slice("node_modules/".length);
      const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
      const authors = [manifest.author?.name ?? manifest.author].filter((a) => typeof a === "string");
      return { name, version: p.version, license: p.license, texts: withFallback(name, p.version, p.license, authors, licenseTextsIn(path)) };
    });
}

function main() {
  const entries = [...rustEntries(), ...npmEntries()];
  if (missing.length > 0) {
    console.error(`ライセンスファイルが無く、MIT も選べないパッケージがあります:\n${missing.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  const out = renderLicenses(entries);
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUTPUT, "utf8");
    } catch {}
    if (current !== out) {
      console.error(`${OUTPUT} が依存と合っていません。node scripts/gen-third-party-licenses.mjs を実行してコミットしてください。`);
      process.exitCode = 1;
    }
    return;
  }
  writeFileSync(OUTPUT, out);
  console.log(`${OUTPUT}: ${out.length} 文字`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
