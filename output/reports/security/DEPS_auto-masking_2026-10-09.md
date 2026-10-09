# 依存追加の供給経路確認: 自動マスキング(AM-T03)

- 日付: 2026-10-09
- 対象: `src-tauri/Cargo.toml` への `objc2-vision` 追加、`objc2` の `exception` 機能、`objc2-foundation` / `objc2-core-foundation` / `regex` の直接参照
- 条件: `output/design/ARCH_auto-masking.md` §15(供給経路の条件)、`output/tasks/TASK_auto-masking.md` AM-T03

## 結果の要約

| # | 条件 | 結果 |
| - | ---- | ---- |
| 1 | `default-features = false` で必要な機能だけ | ✅ 有効な機能は `std` `alloc`(`std` が含む)`VNObservation` `VNRecognizeTextRequest` `VNRequest` `VNRequestHandler` `VNTypes` `objc2-core-foundation` のみ |
| 2 | `Cargo.lock` で増えるのは `objc2-vision` 1 件、削除・版変更 0 件 | ✅ 追加 1 件(`objc2-vision` 0.3.2)、削除 0、版変更 0。ほかに Windows 専用の依存の辺が 1 つ解決し直された(`iana-time-zone`・`tao` の `windows-core` 0.61.2 → 0.62.2。両版とも既に lock にあり、macOS の木には `iana-time-zone` が無い) |
| 3 | 脆弱性(OSV 一括照会、`Cargo.lock` 全パッケージ) | ✅(人間の判断で前提を解消してから確認)初回照会の 7 件のうち、配布物に入る unic-* 5 件(保守終了)は、人間の指示で先に Tauri を 2.12.1 に上げて解消した(コミット `f857a43`)。再照会(508 件 + `objc2-vision`)の残り 2 件 `glib`・`proc-macro-error` は macOS の配布物に入らない。`objc2-vision` とその依存は 0 件 |
| 4 | `build.rs` なし・ライセンス・取得元・チェックサム | ✅ `build.rs` なし / `Zlib OR Apache-2.0 OR MIT` / `source = registry+https://github.com/rust-lang/crates.io-index` / `checksum = bfc194758a2d5d7540b1ad283bfb9ca318ec608991892326e95b428230b2689b`(crates.io API の値と一致) |
| 5 | 証拠を本書に貼る | ✅ 下記 |

## 証拠

### 2. Cargo.lock の差分

```text
$ git diff -U0 src-tauri/Cargo.lock | grep -E '^[+-]name = '
+name = "objc2-vision"

$ git diff --stat src-tauri/Cargo.lock      (Tauri 2.12.1 更新後の lock に対して)
 src-tauri/Cargo.lock | 17 ++++++++++++++++-     (objc2-vision の追加 + windows-core の辺 1 行)
```

パッケージ名・版の一覧(追加前後)の比較でも、差は `objc2-vision 0.3.2` の 1 行だけ。

### 1. 有効な機能と依存

```text
$ cargo tree -e features -i objc2-vision --target aarch64-apple-darwin   (機能名のみ抽出)
objc2-vision feature "VNObservation" / "VNRecognizeTextRequest" / "VNRequest" / "VNRequestHandler"
objc2-vision feature "VNTypes" / "alloc" / "objc2-core-foundation" / "std"

$ cargo tree -p objc2-vision --target aarch64-apple-darwin --depth 1
objc2-vision v0.3.2
├── objc2 v0.6.4
├── objc2-core-foundation v0.3.2
└── objc2-foundation v0.3.2
```

### 3. 脆弱性(OSV querybatch。初回: 512 件照会・512 件応答)

| パッケージ | 版 | 勧告 | 内容 | macOS の配布物に入るか | 判断 |
| ---------- | -- | ---- | ---- | ---------------------- | ---- |
| `glib` | 0.18.5 | RUSTSEC-2024-0429 | `VariantStrIter` の unsound | **入らない**(`cargo tree --target aarch64-apple-darwin -e all -i glib` が空。Linux の GTK 系) | 影響なし |
| `proc-macro-error` | 1.0.4 | RUSTSEC-2024-0370 | 保守終了 | **入らない**(macOS 向けの木に無い) | 影響なし |
| `unic-char-property` `unic-char-range` `unic-common` `unic-ucd-ident` `unic-ucd-version` | 0.9.0 | RUSTSEC-2025-0081 / 0075 / 0080 / 0100 / 0098 | 保守終了(既知の脆弱性ではない) | 入る(`tauri` → `tauri-utils` → `urlpattern` 経由) | 既存の Tauri 本体の依存。置き換えは上流次第。継続監視 |

いずれも今回の追加とは無関係(追加前の `Cargo.lock` にも同じ版がある)。

**対応(2026-10-09、人間の決定「先に unic-* を解消する」)**: Tauri を 2.11.6 → 2.12.1 に上げ(`tauri-utils` 2.10.1 → `urlpattern` 0.6.0 が unic-* に依存しない)、unic-* 5 件が `Cargo.lock` から消えた。公開当日の 2.12.2 は避けた。更新 32 件(macOS の配布物に入るもの)の公開元・取り下げ・`build.rs` の差分を確認し、問題なし。再照会は 508 件中 `glib`・`proc-macro-error` の 2 件のみ(いずれも macOS の配布物に入らない)。npm も `source-map-js` 1.2.2 に上げ、`npm audit` 0 件、`npm audit signatures` で 47 件の署名を検証。

### 4. objc2-vision のソース確認(既存の確認 ARCH §15 と同じ版)

- 公開元: crates.io の所有者 `madsmtm`・`simlay`(既存の `objc2` と同じ)。ソース `github.com/madsmtm/objc2` `framework-crates/objc2-vision` コミット `7b1abfd`
- `build.rs` なし。ソースにプロセス起動・ネットワーク・ファイル操作の呼び出しなし。リンクは Vision フレームワークのみ

### その他

- `cargo check` / `cargo test`(137 pass)/ `cargo clippy -D warnings`(exit 0)
- `THIRD_PARTY_LICENSES.md` を作り直し、`objc2-vision` 0.3.2 が objc2 系の MIT 表示の項目に加わった(`npm run licenses`)
