import { describe, expect, it } from "vitest";

// `scripts/gen-third-party-licenses.mjs` は依存追加なしの Node 実行スクリプトで型定義を持たない
// (`latencySummary.test.ts` と同じ方針)。
// @ts-expect-error 型定義のないプレーンJSモジュール
import { collectShippedCrates, isLicenseFileName, mitFallbackText, renderLicenses } from "../../scripts/gen-third-party-licenses.mjs";

describe("isLicenseFileName", () => {
  it("ライセンス・著作権表示のファイル名を認める", () => {
    for (const name of ["LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "LICENSE.md", "LICENSE-MIT.txt", "license", "COPYING", "COPYRIGHT", "NOTICE", "UNLICENSE", "LICENCE"]) {
      expect(isLicenseFileName(name), name).toBe(true);
    }
  });
  it("ライセンスでないファイルは認めない", () => {
    for (const name of ["README.md", "Cargo.toml", "license.rs", "licenses.json", "CHANGELOG.md"]) {
      expect(isLicenseFileName(name), name).toBe(false);
    }
  });
});

// cargo metadata の最小形: root → a(normal)→ c(normal)、root → b(build のみ)、root → d(dev のみ)
const pkg = (name: string) => ({ id: `${name} 1.0.0`, name, version: "1.0.0", license: "MIT", authors: [], manifest_path: `/r/${name}/Cargo.toml` });
const dep = (name: string, kind: string | null) => ({ pkg: `${name} 1.0.0`, dep_kinds: [{ kind, target: null }] });
const metadata = {
  packages: ["root", "a", "b", "c", "d"].map(pkg),
  resolve: {
    root: "root 1.0.0",
    nodes: [
      { id: "root 1.0.0", deps: [dep("a", null), dep("b", "build"), dep("d", "dev")] },
      { id: "a 1.0.0", deps: [dep("c", null)] },
      { id: "b 1.0.0", deps: [] },
      { id: "c 1.0.0", deps: [] },
      { id: "d 1.0.0", deps: [] },
    ],
  },
};

describe("collectShippedCrates", () => {
  it("ルートから通常の依存だけを辿り、ルート自身・ビルド用・開発用の依存を含めない", () => {
    expect(collectShippedCrates(metadata).map((p: { name: string }) => p.name)).toEqual(["a", "c"]);
  });
  it("通常とビルドの両方で使われる依存は含める", () => {
    const both = structuredClone(metadata);
    both.resolve.nodes[0].deps[1].dep_kinds.push({ kind: null, target: null });
    expect(collectShippedCrates(both).map((p: { name: string }) => p.name)).toEqual(["a", "b", "c"]);
  });
});

describe("mitFallbackText", () => {
  it("作者を著作権者として MIT の全文を作る", () => {
    const text = mitFallbackText(["Jane Doe <jane@example.com>", "John Roe"]);
    expect(text).toContain("Copyright (c) Jane Doe, John Roe");
    expect(text).toContain("Permission is hereby granted, free of charge");
    expect(text).not.toContain("jane@example.com");
  });
  it("作者が無ければパッケージの作者として書く", () => {
    expect(mitFallbackText([])).toContain("Copyright (c) the package authors");
  });
});

describe("renderLicenses", () => {
  it("同じ全文はまとめ、並びは決定的で、改行を LF にそろえる", () => {
    const out = renderLicenses([
      { name: "zeta", version: "1.0.0", license: "MIT", texts: [{ file: "LICENSE", text: "same\r\n" }] },
      { name: "alpha", version: "2.0.0", license: "MIT", texts: [{ file: "LICENSE", text: "same\n" }] },
      { name: "beta", version: "1.0.0", license: "Apache-2.0", texts: [{ file: "LICENSE", text: "other\n" }] },
    ]);
    expect(out).not.toContain("\r");
    expect(out.match(/^same$/gm)).toHaveLength(1);
    expect(out.indexOf("alpha 2.0.0")).toBeLessThan(out.indexOf("zeta 1.0.0"));
    expect(renderLicenses([...[{ name: "beta", version: "1.0.0", license: "Apache-2.0", texts: [{ file: "LICENSE", text: "other\n" }] }]])).toBe(
      renderLicenses([{ name: "beta", version: "1.0.0", license: "Apache-2.0", texts: [{ file: "LICENSE", text: "other\n" }] }]),
    );
  });
});
