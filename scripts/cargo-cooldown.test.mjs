// node --test scripts/  (npm run test:scripts)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  indexPath,
  isYoung,
  parseIndexEntries,
  parseLockPackages,
  pickReplacement,
  sameCompatSeries,
} from "./cargo-cooldown.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-14T00:00:00Z");
const CUTOFF = NOW - 7 * DAY;
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

test("Cargo.lock から crates.io のパッケージだけを取り出す", () => {
  const lock = [
    "version = 4",
    "",
    "[[package]]",
    'name = "serde"',
    'version = "1.0.229"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    'checksum = "abc"',
    "",
    "[[package]]",
    'name = "tadcap"',
    'version = "1.2.0"',
    "dependencies = [",
    ' "serde",',
    "]",
    "",
    "[[package]]",
    'name = "forked"',
    'version = "0.1.0"',
    'source = "git+https://example.invalid/forked#abc"',
  ].join("\n");
  assert.deepEqual(parseLockPackages(lock), [{ name: "serde", version: "1.0.229" }]);
});

test("sparse index のパスは名前の長さで決まる", () => {
  assert.equal(indexPath("a"), "1/a");
  assert.equal(indexPath("cc"), "2/cc");
  assert.equal(indexPath("wry"), "3/w/wry");
  assert.equal(indexPath("Serde"), "se/rd/serde");
});

test("互換系列は Cargo のキャレット規則に従う", () => {
  assert.equal(sameCompatSeries("1.2.3", "1.9.0"), true);
  assert.equal(sameCompatSeries("1.2.3", "2.0.0"), false);
  assert.equal(sameCompatSeries("0.57.1", "0.57.2"), true);
  assert.equal(sameCompatSeries("0.28.0", "0.29.0"), false);
  assert.equal(sameCompatSeries("0.0.3", "0.0.4"), false);
});

test("pubtime の無い版は古い版として扱う", () => {
  const [old, young, boundary] = parseIndexEntries(
    [
      JSON.stringify({ vers: "1.0.0" }),
      JSON.stringify({ vers: "1.0.1", pubtime: at(1) }),
      JSON.stringify({ vers: "1.0.2", pubtime: at(7) }),
    ].join("\n"),
  );
  assert.equal(isYoung(old, CUTOFF), false);
  assert.equal(isYoung(young, CUTOFF), true);
  assert.equal(isYoung(boundary, CUTOFF), false); // ちょうど 7 日は通す
});

test("代わりの版は互換系列で 7 日以上前・未 yank の最新版", () => {
  const entries = parseIndexEntries(
    [
      { vers: "0.56.9", pubtime: at(90) }, // 系列違い
      { vers: "0.57.0", pubtime: at(60) },
      { vers: "0.57.1", pubtime: at(20), yanked: true },
      { vers: "0.57.2-rc.1", pubtime: at(10) }, // プレリリースは選ばない
      { vers: "0.57.2", pubtime: at(2) }, // 若い(戻す対象)
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  assert.equal(pickReplacement(entries, "0.57.2", CUTOFF), "0.57.0");
});

test("戻せる版が無ければ null(依存元を戻した後に再試行する)", () => {
  const entries = parseIndexEntries(JSON.stringify({ vers: "0.29.0", pubtime: at(1) }));
  assert.equal(pickReplacement(entries, "0.29.0", CUTOFF), null);
});
