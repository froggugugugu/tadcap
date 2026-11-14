#!/usr/bin/env node
// Cargo.lock に「公開から N 日たっていない版」が入っていたら、互換範囲で N 日以上たった最新の版へ戻す。
//
//   node scripts/cargo-cooldown.mjs            # 7 日(既定)で確かめ、若い版を戻す
//   node scripts/cargo-cooldown.mjs --days=7   # 日数を指定する
//   node scripts/cargo-cooldown.mjs --check    # 若い版が残っていれば exit 1(書き換えない)
//
// 目的: 乗っ取られた版や壊れた版は公開後数日で取り下げ(yank)・告知されることが多いため、
// 公開直後の版をすぐには取り込まない(npm 側は `npm update --min-release-age=7` で同じことをする)。
// Cargo には安定版のクールダウン機能が無いので、crates.io の sparse index(index.crates.io)が各版に持つ
// 公開日時 `pubtime` を見て、若い版を `cargo update -p <名前>@<版> --precise <版>` で戻す。
// `pubtime` を持たない版は、index が公開日時を記録し始める前の古い版なので若い版として扱わない。
// 戻せない版(依存元がその版を要求している)は、依存元も若いはずなので依存元を戻した後に再試行する。
// 何回か繰り返しても若い版が残ったら exit 1 で止める(若い版を黙って通さない)。
// 依存パッケージを追加せず、Node 標準機能だけで実装する。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Cargo.lock の `[[package]]` から crates.io のパッケージ(名前・版)だけを取り出す。 */
export function parseLockPackages(text) {
  const out = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    const source = block.match(/^source = "([^"]+)"$/m)?.[1];
    if (name && version && source === CRATES_IO) out.push({ name, version });
  }
  return out;
}

/** sparse index 上のパス(https://index.crates.io/<path>)。 */
export function indexPath(name) {
  const n = name.toLowerCase();
  if (n.length <= 2) return `${n.length}/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

function parseSemver(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

/** Cargo の既定(キャレット)要求で互換とみなされる系列か(1.x.y は major、0.x.y は minor、0.0.x は patch が同じ)。 */
export function sameCompatSeries(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return false;
  if (x.major !== y.major) return false;
  if (x.major > 0) return true;
  if (x.minor !== y.minor) return false;
  if (x.minor > 0) return true;
  return x.patch === y.patch;
}

export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** index の 1 行 1 版の JSON 列を読む。 */
export function parseIndexEntries(text) {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .map((e) => ({ vers: e.vers, yanked: !!e.yanked, pubtime: e.pubtime ? Date.parse(e.pubtime) : null }));
}

/** 公開から cutoff を過ぎていない版か(pubtime が無い版は古い版として扱う)。 */
export function isYoung(entry, cutoffMs) {
  return entry.pubtime !== null && entry.pubtime > cutoffMs;
}

/**
 * 若い版 `version` の代わりに使う版。互換系列で、取り下げられておらず、cutoff より前に公開された版のうち最新のもの。
 * プレリリースは元の版がプレリリースのときだけ候補にする。無ければ null。
 */
export function pickReplacement(entries, version, cutoffMs) {
  const wantPre = parseSemver(version)?.pre !== null;
  const candidates = entries.filter(
    (e) =>
      e.vers !== version &&
      !e.yanked &&
      !isYoung(e, cutoffMs) &&
      parseSemver(e.vers) &&
      (wantPre || parseSemver(e.vers).pre === null) &&
      sameCompatSeries(e.vers, version) &&
      compareSemver(e.vers, version) < 0,
  );
  candidates.sort((a, b) => compareSemver(b.vers, a.vers));
  return candidates[0]?.vers ?? null;
}

async function fetchIndex(name) {
  const res = await fetch(`https://index.crates.io/${indexPath(name)}`, {
    headers: { "user-agent": "tadcap-cargo-cooldown (https://github.com/froggugugugu/tadcap)" },
  });
  if (!res.ok) throw new Error(`index.crates.io: ${name}: HTTP ${res.status}`);
  return parseIndexEntries(await res.text());
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

async function findYoung(lockPath, cutoffMs, cache) {
  const pkgs = parseLockPackages(readFileSync(lockPath, "utf8"));
  const names = [...new Set(pkgs.map((p) => p.name))].filter((n) => !cache.has(n));
  await mapLimit(names, 16, async (n) => cache.set(n, await fetchIndex(n)));
  return pkgs.filter((p) => {
    const e = cache.get(p.name).find((x) => x.vers === p.version);
    return e && isYoung(e, cutoffMs);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const days = Number(args.find((a) => a.startsWith("--days="))?.slice(7) ?? 7);
  if (!Number.isFinite(days) || days < 0) throw new Error("--days must be a non-negative number");
  const check = args.includes("--check");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = join(root, "src-tauri", "Cargo.toml");
  const lockPath = join(root, "src-tauri", "Cargo.lock");
  const cutoffMs = Date.now() - days * DAY_MS;
  const cache = new Map();

  for (let round = 1; round <= 8; round++) {
    const young = await findYoung(lockPath, cutoffMs, cache);
    if (young.length === 0) {
      console.log(`cargo-cooldown: every crate in Cargo.lock was published at least ${days} days ago`);
      return;
    }
    if (check) {
      for (const p of young) console.log(`young: ${p.name}@${p.version}`);
      process.exit(1);
    }
    let changed = 0;
    for (const p of young) {
      const to = pickReplacement(cache.get(p.name), p.version, cutoffMs);
      if (!to) {
        console.log(`round ${round}: ${p.name}@${p.version}: no older compatible version, retry after its dependents`);
        continue;
      }
      try {
        execFileSync(
          "cargo",
          ["update", "--manifest-path", manifest, "-p", `${p.name}@${p.version}`, "--precise", to],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        console.log(`round ${round}: ${p.name} ${p.version} -> ${to}`);
        changed++;
      } catch {
        // その版を要求する依存元が先に戻れば、次の回で戻せる
        console.log(`round ${round}: ${p.name}@${p.version} -> ${to} rejected by the resolver, retry later`);
      }
    }
    if (changed === 0) break;
  }
  const left = await findYoung(lockPath, cutoffMs, cache);
  if (left.length) {
    for (const p of left) console.log(`still young: ${p.name}@${p.version}`);
    console.error(`cargo-cooldown: could not hold back ${left.length} crate(s) younger than ${days} days`);
    process.exit(1);
  }
  console.log(`cargo-cooldown: every crate in Cargo.lock was published at least ${days} days ago`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
