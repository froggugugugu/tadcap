ステータス: ゲート 3 承認済み(2026-10-09)。AM-T01〜T23・T25・T26 完了 / AM-T24 は実機の手動確認待ち(2026-10-09 更新)

# タスク分解: 機密情報の自動マスキング

> 生成元: `output/prd/PRD_auto-masking.md`(Approved 2026-10-09)、`output/design/ARCH_auto-masking.md`(Approved 2026-10-09)
> 生成日: 2026-10-09
> タスク ID は既存の `TASK_tadcap_mvp.md`(T01〜T34)・`PLAN_capture_shortcut_settings.md`(KS-T*)と区別するため `AM-T01` から始める。
> FR / NFR の番号は PRD_auto-masking のもの。§ 番号は特記なき限り ARCH_auto-masking のもの。

## 進め方の共通ルール

- **1 タスク = 1 セッション = 1 コミット**(Conventional Commits。例: `feat(masking): 連絡先の検出を追加`)。実装モードは既存どおり**逐次**(1 タスクずつ)。下の Phase の「並行可能」は「順番を入れ替えても衝突しない」の意味
- **TDD**: 各実装タスクは「先に書くテスト(Red)」を最初に書いて失敗を確認 → 実装(Green)→ 整理(Refactor)。Red の失敗出力と Green の成功出力の両方を PROGRESS のセッションログに残す
- **着手前**: スモークテストが緑であることを確認する。**終了時**: スモークテスト緑 + コミット + `output/tasks/PROGRESS.md` の該当行の `passes` 更新
- **新しい npm パッケージは追加しない**(`package.json` の `dependencies` / `devDependencies` は変えない。`scripts` への 1 行追加のみ可)。Rust の新規クレートは `objc2-vision` 1 件だけ(AM-T03)
- **製品名を書かない**: 接頭辞付きトークンの規則・評価データ・テスト・コメントに、他社のサービス名・製品名を書かない(接頭辞の文字列だけを定数で持つ)
- **文字列を出力しない**(NFR-002): `src-tauri/src/masking/` に `println!` / `eprintln!` / `dbg!` / ログ用マクロを書かない。テストの失敗メッセージにも読み取った文字列を出さない(`assert!` の比較は矩形・件数・種類・範囲で行う)

### スモークテストコマンド(全タスク共通。以下 `SMOKE`)

```bash
. "$HOME/.cargo/env" && npm run build && npm run test:run \
  && cargo test --manifest-path src-tauri/Cargo.toml \
  && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings \
  && npm run e2e
```

### ログ非出力の確認コマンド(Rust の masking 系タスク共通。以下 `NOLOG`)

```bash
rg -n 'println!|eprintln!|dbg!|log::|tracing::' src-tauri/src/masking   # 期待: 0 件
```

## 要件サマリー

- [x] 画像表示中だけボタン・⌘⇧M で開始でき、キャプチャ直後・履歴切替・起動時には動かない(FR-001・FR-014)
- [x] 処理中の再押下で二重に走らず、処理中に画像を切り替えても古い結果が出ない(FR-001)
- [x] 文字の読み取りは端末内(Vision)で行い、ベースだけを読む。外部と通信せず、読み取った文字列を IPC・ファイル・ログに出さない(FR-002・NFR-002)
- [x] 失敗時はトーストで知らせ、画像を変えない(FR-002)
- [x] 4 種の候補(連絡先・認証情報・識別子・金額・口座)を §5.3 の規則で検出する(FR-003〜FR-007)
- [x] 評価用画像セットで、形が決まっているものは細分ごとに 95% 以上、日本語の固有名詞・手がかり語付きの番号・英字の人名は 70% 以上(NFR-003)
- [x] 処理中の表示が出て、成功・失敗とも消える。処理中も画面が応答する(FR-008)
- [x] 候補の印は DOM で重ね、種類・件数・0 件(保証の表現なし)を示し、拡大縮小でずれない。コピー・履歴に写らない(FR-009・NFR-005)
- [x] 印のクリックで外す/戻すができ、外した候補は見た目で区別できる(FR-010)
- [x] まとめてモザイクは既存のモザイクと同じ粗さで、1 回の ⌘Z で全候補分が戻り、⇧⌘Z で再びかかる。残り 0 件では押せない(FR-011)
- [x] 候補を出したまま ⌘C で印を含まない画像がコピーされ、やめる / Esc / 画像の切替で候補を破棄する(FR-012)
- [ ] フル HD で 3 秒以内(実測を記録)。macOS 14 で日本語を読める(NFR-001・NFR-004)  ← 未確認(AM-T24 の実機の手動確認が未実施。評価画像 1 枚 約 0.35 秒は AM-T18 の参考値)
- [x] 依存の追加は `objc2-vision` 1 件のみで、供給経路の確認の証拠が残っている(ARCH §15 の条件)
- [x] 同梱する辞書は `/legal-check` と `/security-scan` を通過し、人間が承認したものだけ(ARCH §15 #3 の条件)

## 影響調査

| カテゴリ | ファイル | 変更内容 |
| -------- | -------- | -------- |
| 設定 | `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` | 追加: `objc2-vision`(`default-features = false`)。変更: `objc2-foundation`・`objc2-core-foundation`・`regex` を直接依存に昇格、`objc2` に `exception` 機能 |
| 設定 | `package.json` | 追加: `scripts.mask:fixtures` の 1 行のみ(依存は変えない) |
| 設定 | `src-tauri/tauri.conf.json` / `src-tauri/capabilities/default.json` | 変更しない(差分 0 を AM-T25 で確認) |
| ユーティリティ | `src-tauri/src/masking/{mod,png,text,geometry,layout,ocr}.rs` | 追加: 読み取り・座標・正規化の基盤 |
| ユーティリティ | `src-tauri/src/masking/detect/{mod,lexicon,contact,credential,identifier,financial}.rs` | 追加: 4 種の検出規則 |
| ユーティリティ | `src-tauri/src/masking/lexicon/*.txt` | 追加: 姓・ローマ字の姓名・都道府県の辞書(承認後のみ) |
| テスト | `src-tauri/src/masking/eval.rs` | 追加: `#[ignore]` の評価ハーネス |
| ユーティリティ | `src-tauri/src/commands.rs` / `error.rs` / `lib.rs` | 追加: `scan_sensitive_text`・`TEXT_SCAN_IN_PROGRESS`・`TextScanBusy`/`TextScanFailed`・`invoke_handler` 登録・`mod masking` |
| ストア | `src/canvas/maskSession.ts` | 追加: 処理の状態・token・候補(メモリのみ) |
| ストア | `src/canvas/documentState.ts` | 追加: `applyBaseEdits(rects, draw)` |
| ユーティリティ | `src/canvas/tools/mosaicTool.ts` | 変更: 既存 `applyMosaic()` を `pixelateRect()` として公開(処理は変えない) |
| ユーティリティ | `src/ipc/textScan.ts` | 追加: invoke と応答の形の検証 |
| コンポーネント | `src/ui/autoMask.ts` / `src/ui/maskOverlay.ts` | 追加: ボタン・⌘⇧M・処理中表示・結果パネル / 候補の印 |
| コンポーネント | `src/ui/toolbar.ts` / `undoButton.ts` / `selectionKeys.ts` / `arrangeButtons.ts` | 変更: 確認中(`review`)はツール・取り消し・重ね順・削除を止める(§15 #4) |
| ページ | `src/main.ts` / `src/styles.css` | 変更: `initAutoMask()`・`initMaskOverlay()`、画像差し替え 3 経路の前で `discardMaskSession()` / 追加: `.mask-overlay`・`.mask-mark`・結果パネル |
| テスト | `e2e/auto-mask.spec.ts` / `e2e/fixtures/tauriMock.ts` / `e2e/screenshots/autoMask.visual.ts` | 追加 / 変更: `scan_sensitive_text` のモック(固定候補・遅延・失敗) / 追加 |
| テスト | `eval/masking/pages/*.html` / `eval/masking/images/` / `eval/masking/truth.json` / `scripts/mask-eval-fixtures.mjs` | 追加: 架空データの評価用画像セットと生成スクリプト |
| ユーティリティ | `scripts/latency-summary.mjs` | 変更: `origin=mask scan_ms=` の行も集計 |
| ドキュメント | `docs/docs/{project,architecture,data-model,development-patterns}.md` / `project-config.md` §2・§3・§11 | 変更: 各実装タスクで最小差分(下の「ドキュメント更新計画」) |
| ドキュメント | `THIRD_PARTY_NOTICES.md` / `README.md` / `.github/pages/index.html` / `output/design/ADR_*` | 変更: 辞書・依存の表示、NFR-005 の文言、ADR(§15 #1) |
| テスト | `testreport/manual/CHECKLIST_T18.md` | 追加: 実機確認の項目(nettop・macOS 14・実クリップボード) |

## タスク分解

各タスクの書式: 1 行目は `/plan` の規定形式。続けて **TDD(先に書くテスト)**・**受け入れ基準**・**検証コマンド**を置く。

### Phase 1(並行可能)

- [x] AM-T01 — 辞書の出典・ライセンス確認(`/legal-check`)。ソース変更なし(変更ファイル: `output/reports/legal/LEGAL_auto-masking-lexicon_<日時>.md` | 依存: なし)
  - 対象: ①日本の姓(上位数百〜千件)②ローマ字の姓・名 ③都道府県 47 件。あわせて `objc2-vision`(Zlib OR Apache-2.0 OR MIT)の表示義務を確認する
  - 各候補の出典について、ライセンス・再配布の可否・改変(抜粋・並べ替え)の可否・表示義務・商用可否・取得日・取得元の URL を表にする。出典候補を 2 つ以上比べ、推奨を 1 つ示す
  - 受け入れ基準:
    - [x] 3 種の辞書それぞれに、採用候補の出典・ライセンス・再配布可否・表示義務が記載されている
    - [x] `THIRD_PARTY_NOTICES.md` に追記が要るかどうかと、その文面案が記載されている
    - [x] 報告書の末尾に人間の承認欄があり、承認されるまで AM-T20 に進まない(🚏)
  - 検証コマンド: `test -f output/reports/legal/LEGAL_auto-masking-lexicon_*.md && rg -c '出典|ライセンス|再配布|表示義務' output/reports/legal/LEGAL_auto-masking-lexicon_*.md`(各語 1 件以上)
- [x] AM-T02 — UI 仕様の確定(`/ui-ux-design`)。ボタンのアイコンと位置、結果パネル、印の色(4 色 + 2 重の縁取り)、外した印の見た目、文言(ツールチップ・`aria-label`・0 件・失敗)。ソース変更なし(変更ファイル: `output/design/UI_auto-masking.md` | 依存: なし)
  - 受け入れ基準:
    - [x] §9.1〜§9.5 の【仮定】がすべて決定値に置き換わっている(色は CSS カスタムプロパティ名と値)
    - [x] 0 件・失敗・ツールチップの文言に「安全」「すべて隠しました」「機密はありません」「自動で隠す」を含まない(NFR-005)
    - [x] 明るいキャプチャ・暗いキャプチャ両方の上で印が見分けられることを、モック画像で示している
  - 検証コマンド: `rg -n '安全|すべて隠|機密はありません|自動で隠' output/design/UI_auto-masking.md`(文言案の中で 0 件。禁止語の一覧として書く行は除く)
- [x] AM-T03 — 依存の追加と供給経路の確認(変更ファイル: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `output/reports/security/DEPS_auto-masking_<日付>.md` | 依存: なし)
  - `[target.'cfg(target_os = "macos")'.dependencies]` に追加・変更する:
    - `objc2-vision = { version = "=0.3.2", default-features = false, features = ["std", "VNRequest", "VNRecognizeTextRequest", "VNRequestHandler", "VNObservation", "VNTypes", "objc2-core-foundation"] }`(版の固定方法は【要確認】#2)
    - `objc2-foundation = { version = "0.3", default-features = false, features = ["std", "NSData", "NSArray", "NSString", "NSRange", "NSError", "NSDictionary"] }`
    - `objc2-core-foundation = { version = "0.3", default-features = false, features = ["std", "CFCGTypes"] }`
    - `objc2 = { version = "0.6", features = ["exception"] }`(`objc2-exception-helper` は既に `Cargo.lock` にある)
  - `[dependencies]` に `regex = "1"`(既に `Cargo.lock` に 1.13.1)
  - 機能の過不足はこのタスクで `cargo check` が通る最小に詰める。足りない機能を足したら、そのたびに下の Lock 差分の確認をやり直す
  - **供給経路の条件(ARCH §15。すべて満たさなければコミットしない)**:
    1. `default-features = false` で、上記の機能だけを有効にしている
    2. `Cargo.lock` の差分で**新しく増えるパッケージは `objc2-vision` 1 件だけ**。削除されるパッケージ・版が変わるパッケージは 0 件
    3. 脆弱性の確認(cargo audit 相当。手段は【要確認】#1)で、`Cargo.lock` 全体に該当なし
    4. `objc2-vision` に `build.rs` が無い、ライセンスが `Zlib OR Apache-2.0 OR MIT`、`Cargo.lock` の `source` が crates.io・`checksum` がある
    5. 1〜4 のコマンドと出力を `output/reports/security/DEPS_auto-masking_<日付>.md` に貼る(証拠)
  - TDD: 依存追加のみのため新しいテストは無い。`cargo check` と `SMOKE` が通ることで確認する(未使用のクレートは clippy の既定では警告にならない)
  - 受け入れ基準:
    - [x] 条件 1〜5 をすべて満たし、証拠が報告書にある
    - [x] `cargo tree -e features -i objc2-vision` に、指定した以外の機能が出ない
    - [x] `SMOKE` が緑
  - 検証コマンド:

    ```bash
    git diff -U0 src-tauri/Cargo.lock | rg '^\+name = '        # 期待: +name = "objc2-vision" の 1 行だけ
    git diff -U0 src-tauri/Cargo.lock | rg '^-name = |^-version = '   # 期待: 0 行
    . "$HOME/.cargo/env" && cargo tree --manifest-path src-tauri/Cargo.toml -e features -i objc2-vision
    ls ~/.cargo/registry/src/*/objc2-vision-0.3.2/build.rs      # 期待: No such file
    cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 | jq -r '.packages[] | select(.name=="objc2-vision") | .license'
    # 脆弱性の確認は【要確認】#1 の決定に従う(B 案なら Cargo.lock 全件を OSV の querybatch に問い合わせ、vulns が 0 件)
    ```

- [x] AM-T04 — Rust の masking 基盤: 型・トレイト・全サブモジュールの宣言、PNG の検証、文字列の包みと正規化(変更ファイル: `src-tauri/src/lib.rs`, `src-tauri/src/masking/mod.rs`, `png.rs`, `text.rs`, 空の `geometry.rs`・`layout.rs`・`ocr.rs`・`eval.rs`・`detect/{mod,lexicon,contact,credential,identifier,financial}.rs` | 依存: なし)
  - `mod.rs` に `MaskCandidate { x, y, width, height, kind }`(`serde::Serialize`、`kind` は小文字の 4 種)・`MaskKind`・`ScanError`・`RecognizedPage` トレイト・`Match` を置き、**全サブモジュールの `mod` 宣言をこのタスクで済ませる**(以降のタスクが `mod.rs` を取り合わないため)。`ocr.rs` は `#[cfg(target_os = "macos")]`
  - `lib.rs` に `mod masking;` を足す。呼び出し口(AM-T18)ができるまでの未使用警告は `#[cfg_attr(not(test), allow(dead_code))]` を `mod masking` に付けて抑え、**AM-T18 で必ず外す**(clippy `-D warnings` 対策)
  - TDD(先に書くテスト):
    - `png::validate`: 正しい PNG(1×1・16384×1)/ 署名違い / IHDR の幅 0 / 16385px / 本文サイズ上限超え / 途中で切れたバイト列 → `ImageSize` または `ScanError`
    - `text::normalize`: 全角英数・全角記号・全角空白・各種ハイフン(`－` `ー` `‐` `−` `–` `—`)が 1 文字 → 1 文字で置き換わり、文字数が変わらない
    - `Utf16Map`: ASCII のみ / 日本語 / 絵文字(サロゲートペア)/ 結合文字を含む行で、バイト位置 → UTF-16 位置が正しい
    - `SensitiveText` の `format!("{:?}")` が `SensitiveText(<redacted>)` で、元の文字列を含まない。`Display` を実装していない(コンパイルで確認するテストは `static_assertions` を使わず、ドキュメントテストの `compile_fail` で書く)
  - 受け入れ基準:
    - [x] 上記テストがすべて緑、`SMOKE` 緑
    - [x] `masking` は `pub(crate)`。外から見えるのは `scan`(AM-T18 で実体)・`MaskCandidate`・`MaskKind`・`ScanError` だけ
    - [x] `NOLOG` が 0 件
  - 検証コマンド: `. "$HOME/.cargo/env" && cargo test --manifest-path src-tauri/Cargo.toml masking::` → 新規テストの件数と pass を記録 / `SMOKE` / `NOLOG`
- [x] AM-T05 — 評価用画像セットと生成スクリプト(変更ファイル: `eval/masking/pages/*.html`, `scripts/mask-eval-fixtures.mjs`, `package.json`(`scripts` 1 行), `eval/masking/images/`, `eval/masking/truth.json` | 依存: なし)
  - 架空画面の HTML(社内システム・メール・設定・請求・ターミナル風など)を書き、正解の文字を `<span data-mask="<種類>/<細分>">` で囲む。細分は §5.3 の 12 種(メール・電話・住所・接頭辞付きトークン・長いランダム列・手がかり語の値・URL のクエリ・手がかり語付きの番号・人名(日本語)・人名(英字)・会社名・カード・口座・金額)
  - `scripts/mask-eval-fixtures.mjs` は既存の `@playwright/test` の Chromium だけを使い、各ページを フル HD(`deviceScaleFactor: 1`)・Retina 相当(`2`)× 明るい/暗いで撮影し、`span` の `getClientRects()` を画素に換算して `truth.json`(画像・矩形・種類・細分。**文字列は書かない**)を出す。複数行にまたがる `span` は行ごとの矩形にする
  - 架空データの作り方: メールは予約済みのドメイン(`example.com` 等)、カード番号は Luhn を満たす乱数(固定シード)、トークンは**ページ読み込み時に接頭辞と乱数を連結して埋め込む**(ソースに完全な形を書かない。【要確認】#5)、人名・会社名・住所は辞書(AM-T20)と**別に**用意した架空の組み合わせ(辞書に無い姓も一定割合入れる)
  - TDD: 新しいテスト基盤は足さず、**自己検査を先に書いて**(Red: 空の出力で exit 1)から生成処理を書く。矩形の換算(CSS px → 画素、DPR、スクロール位置)は関数に分ける。スクリプトの最後に、①全矩形が画像の内側 ②細分ごとの件数が規定以上 ③`truth.json` に文字列のキーが無い、を検査し、満たさなければ exit 1
  - 受け入れ基準:
    - [x] 画像 20 枚以上、件数は PRD §8.3 の規模以上(数え方は【要確認】#3)
    - [x] 自己検査が exit 0、`truth.json` の各矩形を画像に重ねた確認画像 3 枚を目視し、文字を覆っている
    - [x] `package.json` の差分が `scripts` の 1 行だけ(`git diff package.json`)。`package-lock.json` の差分 0
  - 検証コマンド: `npm run mask:fixtures && git diff --stat package.json package-lock.json && node -e "const t=require('./eval/masking/truth.json');console.log(t.images.length)"`
- [x] AM-T06 — 候補の状態ストア `maskSession`(変更ファイル: `src/canvas/maskSession.ts`, `src/canvas/maskSession.test.ts` | 依存: なし)
  - TDD(先に書くテスト): `idle → scanning → review → idle` の遷移 / `scanning` 中の `beginScan()` は何もしない / 古い token・別の `CanvasImage` の `acceptScanResult()` は捨てて状態を変えない / `failScan()` で `idle` / `toggleCandidate()` で外す→戻す / `activeRects()` は外した候補を含まない / `discardMaskSession()` はどの状態からも `idle` / 購読者へ通知 / 候補に文字列のフィールドが無い(型で保証)
  - 受け入れ基準:
    - [x] 上記テストが緑、`SMOKE` 緑
    - [x] `maskSession.ts` が `src/ipc/`・`src/ui/` を import していない
  - 検証コマンド: `npx vitest run src/canvas/maskSession.test.ts` / `rg -n "from \"\.\./(ipc|ui)/" src/canvas/maskSession.ts`(0 件)/ `SMOKE`
- [x] AM-T07 — 一括モザイクの土台 `applyBaseEdits()` と `pixelateRect()`(変更ファイル: `src/canvas/documentState.ts`, `src/canvas/documentState.test.ts`, `src/canvas/tools/mosaicTool.ts`, `src/canvas/tools/mosaicTool.test.ts` | 依存: なし)
  - TDD(先に書くテスト。既存の `PixelStore` の偽物を使う): 矩形 3 件で `group` が 1 手だけ積まれる / 1 回の undo で 3 件とも元のピクセルに戻る / redo で再びかかる / **重なる 2 矩形**で undo 後に元の画素と完全一致 / 0 件なら何も積まない / 幅 0 の矩形は飛ばす / `commandPixelBytes()` が `group` 内の合計を返す
  - `pixelateRect()` は既存 `applyMosaic()` の公開名の変更だけで、ブロックサイズの式(`mosaicBlockSize()`)と処理は変えない(既存テストがそのまま緑であること)
  - 受け入れ基準:
    - [x] 上記テストと既存の `documentState`・`mosaicTool`・`undoStack` のテストが緑、`SMOKE` 緑
  - 検証コマンド: `npx vitest run src/canvas/documentState.test.ts src/canvas/tools/mosaicTool.test.ts src/canvas/undoStack.test.ts` / `SMOKE`
- [x] AM-T08 — IPC ラッパー `textScan.ts`(変更ファイル: `src/ipc/textScan.ts`, `src/ipc/textScan.test.ts` | 依存: なし)
  - TDD(先に書くテスト。既存 `src/ipc/*.test.ts` の invoke の偽物の作法): PNG の `Blob` を生のバイト列で `scan_sensitive_text` に渡す / 正しい応答を `ScannedCandidate[]` で返す / 配列でない・小数・負数・`NaN`・未知の `kind`・余分な文字列フィールドを含む応答は 1 件でも全体を例外 / `text_scan_busy`・`text_scan_failed` を区別できる例外にする
  - 受け入れ基準:
    - [x] 上記テストが緑、`SMOKE` 緑
    - [x] `textScan.ts` が `src/canvas/`・`src/ui/` を import していない
  - 検証コマンド: `npx vitest run src/ipc/textScan.test.ts` / `rg -n "from \"\.\./(canvas|ui)/" src/ipc/textScan.ts`(0 件)/ `SMOKE`

### Phase 2(Phase 1 完了後)

- [x] AM-T09 — 座標と行の幾何(変更ファイル: `src-tauri/src/masking/geometry.rs`, `src-tauri/src/masking/layout.rs` | 依存: AM-T04)
  - TDD(先に書くテスト): 正規化座標(左下原点)→ 画素(左上原点)の変換と外側への丸め / 余白 `max(2px, 行の高さ × 0.2)` / 画像の端での収め(x<0・右端超え)/ 幅・高さ 0 は捨てる / 包含される矩形の除去 / 重なり 90% 以上の統合と種類の優先順(認証情報 > 金額・口座 > 連絡先 > 識別子)/ それ以外の重なりは両方残す / `right_neighbor()`: 同じ行の右側で最も近い観測、縦の中心がずれた観測は対象外 / `next_line_below()`: 左端が近い直下の行
  - 受け入れ基準:
    - [x] 上記テストが緑、`SMOKE` 緑、`NOLOG` 0 件
    - [x] `geometry.rs`・`layout.rs` が `ocr`・`objc2` 系を参照していない
  - 検証コマンド: `cargo test --manifest-path src-tauri/Cargo.toml masking::geometry masking::layout` / `rg -n 'objc2|ocr::' src-tauri/src/masking/{geometry,layout}.rs`(0 件)/ `SMOKE` / `NOLOG`
- [x] AM-T10 — Vision の呼び出し `ocr.rs`(変更ファイル: `src-tauri/src/masking/ocr.rs` | 依存: AM-T03, AM-T04, AM-T05)
  - 精度優先・`ja-JP` → `en-US`・言語補正は定数(既定オフ)。行ごとに文字列(`SensitiveText`)・領域・`VNRecognizedText` を保持し、`RecognizedPage::range_box(line, utf16_range)` で部分範囲の領域を返す。全体を `autoreleasepool` の中で完結させ、呼び出しを `objc2::exception::catch` で包んで `ScanError` へ変換する
  - `unsafe` ブロックごとに前提(スレッド・寿命)をコメントで書く
  - TDD(先に書くテスト): `#[ignore]` の実機テストで、評価画像 1 枚(AM-T05 の明るいフル HD)を読ませて行が 1 件以上・各領域が画像の内側 / `range_box` が行の領域の内側 / PNG でないバイト列で `ScanError`(パニックしない)。いずれも文字列は比較・出力しない(件数と矩形だけ)
  - 受け入れ基準:
    - [x] `cargo test -- --ignored masking::ocr` が実機で緑、`SMOKE` 緑(通常の `cargo test` では `#[ignore]` は走らない)
    - [x] `NOLOG` 0 件。`expect(`/`panic!(` のメッセージに文字列を入れていない
  - 検証コマンド: `cargo test --manifest-path src-tauri/Cargo.toml masking::ocr -- --ignored` / `rg -n 'expect\(|panic!\(' src-tauri/src/masking/ocr.rs`(目視で文字列を含まない)/ `SMOKE` / `NOLOG`
- [x] AM-T11 — 検出の基盤と①連絡先(メール・電話番号・〒と郵便番号)(変更ファイル: `src-tauri/src/masking/detect/mod.rs`, `detect/lexicon.rs`, `detect/contact.rs` | 依存: AM-T03, AM-T04)
  - `detect::run(&dyn RecognizedPage) -> Vec<Match>` と、テスト用の偽物の `RecognizedPage`(文字幅を等分)を `detect/mod.rs` の `#[cfg(test)]` に置く。4 検出器の登録口はこのタスクで作り、未実装の検出器は空を返す
  - 都道府県名で始まる住所は辞書が要るため AM-T22 で扱う
  - TDD(先に書くテスト): メール(`@`・`.` の前後の空白を許す、末尾の句読点を含めない、全角 `＠`)/ 電話(固定・携帯・IP 電話・フリーダイヤル、ハイフン有無、括弧、`+81`、全角数字・各種ハイフン、桁不足・桁過多は対象外、前後が数字に続く場合は対象外)/ 〒+郵便番号・郵便番号単独 `NNN-NNNN` / UTF-16 範囲が日本語の行で正しい
  - 受け入れ基準:
    - [x] 上記テストが緑、`SMOKE` 緑、`NOLOG` 0 件
    - [x] `detect/` が `ocr`・`objc2` 系を参照していない
  - 検証コマンド: `cargo test --manifest-path src-tauri/Cargo.toml masking::detect` / `rg -n 'objc2|ocr::' src-tauri/src/masking/detect`(0 件)/ `SMOKE` / `NOLOG`
- [x] AM-T12 — 候補の印 `maskOverlay.ts`(変更ファイル: `src/ui/maskOverlay.ts`, `src/ui/maskOverlay.test.ts`, `src/styles.css` | 依存: AM-T02, AM-T06)
  - `renderMaskMarks(container, candidates, size)`(DOM 生成)と `initMaskOverlay(canvas)`(購読・クリック)を分ける。位置は % 指定、配置は既存 `.shape-overlay` と同じ合わせ方(`offsetLeft`/`clientWidth` + `ResizeObserver`)。ラベルは固定の種類名を `textContent` で入れる
  - TDD(先に書くテスト。DOM なしで書ける純粋関数を分ける): 画素の矩形 → % の `left/top/width/height` / 画像の端の候補が 100% を超えない / 種類 → ラベル文言・CSS クラス・`aria-label` / 外した候補の `aria-pressed` の値。DOM 自体は AM-T17 の E2E で確認する(jsdom は入れない。既存方針)
  - 受け入れ基準:
    - [x] 上記テストが緑、`SMOKE` 緑
    - [x] 色・線は AM-T02 の CSS カスタムプロパティを使う
  - 検証コマンド: `npx vitest run src/ui/maskOverlay.test.ts` / `SMOKE`
- [x] AM-T13 — 確認中(`review`)の操作制限(§15 #4 A 案)(変更ファイル: `src/ui/toolbar.ts`, `src/ui/undoButton.ts`, `src/ui/selectionKeys.ts`, `src/ui/arrangeButtons.ts` と各 `*.test.ts` | 依存: AM-T06)
  - `maskSession` を購読し、`review` の間はツールボタン・取り消し/やり直しボタンを無効にし、⌘Z・⇧⌘Z・⌘⇧F・⌘⇧B・Delete を無視する。⌘C は止めない
  - TDD(先に書くテスト): 各キー判定関数が `review` 中は「処理しない」を返す / `idle` に戻ると元どおり / ⌘C の判定は影響を受けない
  - 受け入れ基準:
    - [x] 上記テストと既存テストが緑、`SMOKE` 緑(既存 E2E の `undo-redo.spec.ts`・`object-ops.spec.ts` を含む)
  - 検証コマンド: `npx vitest run src/ui/` / `SMOKE`
- [x] AM-T20 — 辞書データの準備と**同梱前の**セキュリティ確認(`/security-scan`)。ソース変更なし(変更ファイル: `testreport/masking/lexicon-staging/*`(git 管理外), `output/reports/security/SECURITY_auto-masking-lexicon_<日時>.md` | 依存: AM-T01 の人間承認)
  - AM-T01 で承認された出典から、姓・ローマ字の姓名・都道府県を 1 行 1 語の UTF-8 テキストに整形する。取得したファイルは新しい空のディレクトリに置き、整形のスクリプトは別のディレクトリに置いて引数でパスを渡す(取得物を実行・import しない)
  - `/security-scan` で確認すること: ①取得元・取得日・取得物の SHA-256 の記録 ②制御文字・双方向制御文字・ゼロ幅文字・BOM・改行コードの混在が無い ③1 語の長さと件数が想定範囲(上限を数値で記す)④語以外のデータ(URL・記号列・個人の連絡先など)が無い ⑤実行時に何も取得しない設計(`include_str!` のみ)であること ⑥ライセンス表記を同梱用に用意した
  - 受け入れ基準:
    - [x] 報告書に①〜⑥の結果と確認コマンドの出力がある。Critical / High が 0 件
    - [x] 人間が報告書と staging の内容を承認するまで AM-T21 に進まない(🚏)
  - 検証コマンド: `rg -nP '[\x00-\x08\x0B-\x1F\x7F\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}\x{FEFF}]' testreport/masking/lexicon-staging`(0 件)/ `wc -l testreport/masking/lexicon-staging/*.txt` / `shasum -a 256 testreport/masking/lexicon-staging/*`

### Phase 3(Phase 2 完了後)

- [x] AM-T14 — ②認証情報(接頭辞付きトークン・長いランダム列・手がかり語の値・URL のクエリ)(変更ファイル: `src-tauri/src/masking/detect/credential.rs`, `detect/lexicon.rs` | 依存: AM-T09, AM-T11)
  - 接頭辞の一覧は `lexicon.rs` に文字列の定数だけで持つ(サービス名をコメントに書かない)
  - TDD(先に書くテスト。トークンはテスト内で接頭辞と本体を連結して組み立てる。【要確認】#5): 接頭辞付き / 20 文字以上で英字と数字が混在(`-`・`_` を含む)、英字だけ・数字だけは対象外、誤読(`0`→`Q`)・途中の空白 1 つを許す / 手がかり語(「パスワード」「暗証番号」「password」「pass」「pwd」「secret」「token」「api key」)の後の `:` `=` `：` 空白以降 / 手がかり語だけの観測の**右隣の観測**(`layout.rs`)/ `KEY=VALUE` でキーに手がかり語を含む / URL は `?` 以降だけ(パス部分を含まない)、`?` が無い URL は対象外
  - 受け入れ基準: [x] 上記テストが緑、`SMOKE` 緑、`NOLOG` 0 件
  - 検証コマンド: `cargo test --manifest-path src-tauri/Cargo.toml masking::detect::credential` / `SMOKE` / `NOLOG`
- [x] AM-T15 — 実行の組み立て `autoMask.ts` と `main.ts` の結線(変更ファイル: `src/ui/autoMask.ts`, `src/ui/autoMask.test.ts`, `src/main.ts`, `src/styles.css` | 依存: AM-T02, AM-T06, AM-T07, AM-T08, AM-T12, AM-T13)
  - §7.1 の手順 1〜12 を実装する: ボタン(区切り線の後、トグル表示なし)・⌘⇧M(`isEditableTarget()` で入力欄では奪わない)・`commitPendingText()` → `beginScan()` → `exportDocumentBase()` → `scanSensitiveText()` → `acceptScanResult()`、実行中の Promise を 1 つ保持、処理中の表示(`role="status"`)、結果パネル(件数・まとめてモザイク・やめる)、0 件の文言、失敗のトースト、Esc でやめる、まとめてモザイク → `applyBaseEdits(activeRects(), pixelateRect)` → `discardMaskSession()`。受け取った矩形は `clipRectToCanvas()` で再度収める
  - `main.ts`: `handleCaptureCompleted`・`reloadHistoryItemIntoCanvas`・`clearEditor` の**画像を差し替える前**に `discardMaskSession()`
  - TDD(先に書くテスト。DOM に依存しない部分を関数に分ける): 開始できる条件(画像あり・`idle`)/ ⌘⇧M の判定(⌘⇧M のみ、入力欄では無視、既存キーと重ならない)/ 前の実行が終わるまで次の invoke を送らない / 結果の矩形の再クランプ / 0 件・失敗の文言に禁止語を含まない / まとめてモザイクは残り 0 件で押せない
  - 受け入れ基準:
    - [x] 上記テストが緑、`SMOKE` 緑(既存 E2E を含む)
    - [x] `rg -n 'console\.' src/ui/autoMask.ts src/ui/maskOverlay.ts src/canvas/maskSession.ts src/ipc/textScan.ts` の出力が候補の中身を含まない
  - 検証コマンド: `npx vitest run src/ui/autoMask.test.ts` / 上記 `rg` / `SMOKE`

### Phase 4(Phase 3 完了後)

- [x] AM-T16 — ④金額・口座と③手がかり語付きの番号(変更ファイル: `src-tauri/src/masking/detect/financial.rs`, `detect/identifier.rs`, `detect/lexicon.rs` | 依存: AM-T14)
  - TDD(先に書くテスト): カード 13〜19 桁で Luhn が正しいもの(空白・ハイフン区切り有無)/ Luhn 不正でも **4 桁 × 4 組の区切りがある 16 桁は候補**(§15 #6 B)、区切りなしの Luhn 不正は対象外 / 口座「口座番号」「口座」「普通」「当座」の後の 6〜8 桁(同じ行・右隣の観測)/ 金額は通貨記号・単位付きだけ(`¥` `￥` `$` `円` `USD` `JPY`、桁区切り・小数)、単位なしの数値は対象外 / 番号「社員番号」「社員ID」「顧客番号」「顧客ID」「会員番号」「お客様番号」「ID」「User ID」の値(同じ行・右隣・直下)
  - 受け入れ基準: [x] 上記テストが緑、`SMOKE` 緑、`NOLOG` 0 件
  - 検証コマンド: `cargo test --manifest-path src-tauri/Cargo.toml masking::detect` / `SMOKE` / `NOLOG`
- [x] AM-T17 — E2E と見た目の確認(変更ファイル: `e2e/auto-mask.spec.ts`, `e2e/fixtures/tauriMock.ts`, `e2e/screenshots/autoMask.visual.ts` | 依存: AM-T15)
  - `tauriMock.ts` に `scan_sensitive_text`(固定の候補・遅延・失敗・0 件)を追加し、§10.2 の全シナリオを書く: 一連の流れ(外す → まとめてモザイク → 外した領域は不変・残りは変化 → ⌘Z で全候補分が戻る → ⇧⌘Z で再びかかる)/ 印を出したまま ⌘C で印が写らない(画素で確認)/ 処理中の新規キャプチャ・履歴切替で古い印が出ない / 処理中の再押下・⌘⇧M で invoke が 1 回 / 0 件の文言に禁止語なし / 失敗でトースト・画像不変 / 画像なしでボタン無効 / ウィンドウの大きさを変えても印がずれない / 確認中に ⌘Z・ツールが効かない / Esc でやめる
  - TDD: シナリオを先に書き Red を確認してから、足りない結線を AM-T15 の範囲で直す(直したファイルはコミットに含め、PROGRESS に記す)
  - 受け入れ基準:
    - [x] `npm run e2e` で新規シナリオを含め全件緑。印が写らない確認は、印の描画を Canvas に変えると落ちることを一度確かめる
    - [x] `npm run e2e:screenshots:after` で明るい/暗い画像・外した印・結果パネル・0 件のスクリーンショットを `output/reports/ui/` に保存
  - 検証コマンド: `npx playwright test e2e/auto-mask.spec.ts` / `npm run e2e:screenshots:after` / `SMOKE`

### Phase 5(Phase 4 完了後)

- [x] AM-T18 — `scan()` の統合と IPC コマンド(変更ファイル: `src-tauri/src/masking/mod.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/error.rs`, `src-tauri/src/lib.rs` | 依存: AM-T09, AM-T10, AM-T16)
  - `scan(png)` = `png::validate` → `ocr::recognize` → `detect::run` → `range_box` → `geometry` → 重複除去、を 1 つの `autoreleasepool` で。検出から矩形の確定までを `scan_page(&dyn RecognizedPage, ImageSize)` に分け、偽物のページでテストできるようにする
  - `commands.rs`: `scan_sensitive_text`(`InvokeBody::Raw` 以外は `text_scan_failed`、`TEXT_SCAN_IN_PROGRESS` で二重実行を `text_scan_busy`、`spawn_blocking`、エラーは固定文字列)。経過時間は `[tadcap:latency] origin=mask scan_ms=<ms> size=<w>x<h>` だけを出す(件数・種類も出さない)
  - `lib.rs`: `invoke_handler` に追加。AM-T04 で付けた `allow(dead_code)` を**外す**
  - TDD(先に書くテスト): `scan_page` が偽物のページで期待の矩形・種類を返す(余白込み・画像内・重複除去後)/ 戻り値の JSON に `kind` と数値以外のキーが無い / 二重実行で `text_scan_busy`、終わった後は再実行できる(フラグが失敗時も下りる)/ Raw 以外の本文で `text_scan_failed` / エラー文字列が固定値
  - 受け入れ基準:
    - [x] 上記テストが緑、`SMOKE` 緑、`NOLOG` 0 件、`rg -n 'allow\(dead_code\)' src-tauri/src/lib.rs` が 0 件
    - [x] 実機の `#[ignore]` テストで評価画像 1 枚の `scan()` が候補を 1 件以上返す
    - [x] `git diff src-tauri/tauri.conf.json src-tauri/capabilities/` が空
  - 検証コマンド: `cargo test --manifest-path src-tauri/Cargo.toml masking:: commands::` / `cargo test --manifest-path src-tauri/Cargo.toml masking::tests -- --ignored` / `SMOKE` / `NOLOG`

### Phase 6(Phase 5 完了後。AM-T19 と AM-T21 は並行可能)

- [x] AM-T19 — 評価ハーネスと「形が決まっているもの」の計測・調整(変更ファイル: `src-tauri/src/masking/eval.rs`, 必要に応じ `detect/*.rs`・`geometry.rs`・`ocr.rs` の定数, `testreport/masking/eval-<日付>.json`, `output/reports/masking/eval-<日付>.md` | 依存: AM-T05, AM-T18)
  - `#[ignore] fn masking_eval()`: `truth.json` の全画像を `scan()` と同じ処理に通し、正解の矩形が候補の矩形に **100% 覆われたら検出**。細分ごとの検出率・誤検出数(参考)・環境を出力する。出力に文字列を含めない
  - 言語補正のオン/オフ・余白の係数を両方測り、検出率の高い方を採用(`ocr.rs`・`geometry.rs` の定数)。採否の根拠を報告書に記す
  - TDD(先に書くテスト): 覆い判定の純粋関数(完全に覆う / 1px はみ出す / 2 候補の和で覆う場合は**検出にする**。#4 で決定)/ 細分ごとの集計
  - 受け入れ基準:
    - [x] メール・電話・接頭辞付きトークン・長いランダム列・手がかり語の値・URL のクエリ・カード・口座・金額の検出率がそれぞれ 95% 以上(未達時の扱いは【要確認】#6)
    - [x] 手がかり語付きの番号は 70% 以上
    - [x] 生データとまとめが所定の場所にあり、`rg` で文字列が含まれないことを確認(`truth.json` に無い語が出ないこと)
    - [x] 🚏 人間がまとめを確認する
  - 検証コマンド: `cargo test --manifest-path src-tauri/Cargo.toml masking::eval -- --ignored --nocapture` / `SMOKE` / `NOLOG`
- [x] AM-T21 — 辞書の同梱と③人名(変更ファイル: `src-tauri/src/masking/lexicon/*.txt`, `detect/lexicon.rs`, `detect/identifier.rs`, `THIRD_PARTY_NOTICES.md` | 依存: AM-T16, AM-T20 の人間承認)
  - staging の承認済みファイルを**バイト一致で**コピーし(SHA-256 を AM-T20 の報告と照合)、`include_str!` で読み込む。読み込みは 1 行 1 語、空行・前後の空白を無視
  - TDD(先に書くテスト): 辞書の件数が報告書の値と一致 / 敬称「様」「さん」「氏」「殿」の直前のかな漢字列 / ラベル「氏名」「名前」「担当」「宛名」「差出人」「Name」の値(同じ行・右隣)/ 手がかり語なし: 姓 + かな漢字 1〜3 字(空白の有無に依存しない)/ 英字: ローマ字の姓・名の辞書を含む大文字始まりの 2〜3 語、「Mr.」「Ms.」「Dear」の後 / 辞書の語が文中の一部に現れる誤検出の代表例を 1 件以上(見逃し回避の方針のため除外はしないが、件数を把握)
  - 受け入れ基準:
    - [x] 上記テストが緑、`SMOKE` 緑、`NOLOG` 0 件
    - [x] `shasum -a 256` が AM-T20 の報告と一致。`THIRD_PARTY_NOTICES.md` に AM-T01 の文面で追記
  - 検証コマンド: `shasum -a 256 src-tauri/src/masking/lexicon/*.txt` / `cargo test --manifest-path src-tauri/Cargo.toml masking::detect::identifier` / `SMOKE` / `NOLOG`

### Phase 7(Phase 6 完了後)

- [x] AM-T22 — ③会社名と①住所(都道府県で始まる行)(変更ファイル: `src-tauri/src/masking/detect/identifier.rs`, `detect/contact.rs`, `detect/lexicon.rs` | 依存: AM-T21)
  - TDD(先に書くテスト): 「株式会社」「(株)」「㈱」「有限会社」「合同会社」「Inc.」「Co., Ltd.」の前後に続く名前の列(前置・後置の両方)/ 都道府県名で始まる行の残り / 〒・郵便番号の行の後に続く住所の行 / 2 行目の建物名(手がかりなし)は対象外であることを明示するテスト
  - 受け入れ基準: [x] 上記テストが緑、`SMOKE` 緑、`NOLOG` 0 件
  - 検証コマンド: `cargo test --manifest-path src-tauri/Cargo.toml masking::detect` / `SMOKE` / `NOLOG`
- [x] AM-T23 — 日本語の固有名詞の計測・調整(変更ファイル: 必要に応じ `detect/identifier.rs`・`detect/contact.rs`・`detect/lexicon.rs`, `testreport/masking/eval-<日付>.json`, `output/reports/masking/eval-<日付>.md` | 依存: AM-T19, AM-T22)
  - AM-T19 のハーネスで全細分を再計測し、人名(日本語)・人名(英字)・会社名・住所が 70% 以上になるまで規則・辞書の件数を調整する。**形が決まっているものの検出率が下がっていないこと**も確認する
  - 英字の人名が 70% に届かない場合は §15 #3 C 案(NLTagger の併用)を人間に提案する(このタスクでは依存を足さない)
  - 受け入れ基準:
    - [x] 人名(日本語)・人名(英字)・会社名・住所がそれぞれ 70% 以上(未達時の扱いは【要確認】#6)
    - [x] 形が決まっているものが引き続き 95% 以上
    - [x] 🚏 人間がまとめを確認する
  - 検証コマンド: `cargo test --manifest-path src-tauri/Cargo.toml masking::eval -- --ignored --nocapture` / `SMOKE` / `NOLOG`
- [ ] AM-T24 — 実機計測と手動確認(NFR-001・NFR-002・NFR-004)(変更ファイル: `scripts/latency-summary.mjs`, `testreport/masking/latency-<日付>.md`, `testreport/manual/CHECKLIST_T18.md` | 依存: AM-T17, AM-T18)
  - `latency-summary.mjs` を `origin=mask scan_ms=` の行にも対応させる(既存の `spawn_ms` の集計は変えない)
  - TDD(先に書くテスト): 集計関数に `scan_ms` 行と既存の `spawn_ms` 行の混在を与え、両方が別々に集計される(既存スクリプトのテストの作法に合わせる。無ければスクリプト末尾の自己検査)
  - 手動確認(`CHECKLIST_T18.md` に項目を追加し、結果を記録): フル HD の評価画像で押下 → 印の表示を 10 回(中央値・最大値。Rust の `scan_ms` と体感の両方)/ Retina 全画面の実測(目標なし)/ 処理中に `nettop -p <PID>` で通信 0 / macOS 14 での日本語の読み取り(環境は【要確認】#7)/ 印を出したまま ⌘C → 他アプリへ貼って印が写らない
  - 受け入れ基準:
    - [ ] フル HD の中央値・最大値が 3 秒以内(計測機種を明記)
    - [ ] 通信 0、macOS 14 の結果、実クリップボードの結果が記録されている
  - 検証コマンド: `npm run latency:summary -- <ログファイル>` / `SMOKE`
  - **状態(2026-10-09)**: 未完了。`scripts/latency-summary.mjs` の `scan_ms` 対応と `CHECKLIST_T18.md` §13 の項目追加は済み(`c5719e3`)。実機での計測・`nettop`・macOS 14・実クリップボードの手動確認は**未実施**(人間の作業。`testreport/masking/latency-<日付>.md` は未作成)。受け入れ基準は確認できるまでチェックしない

### Phase 8(Phase 7 完了後)

- [x] AM-T25 — 機能全体のセキュリティ確認とレビュー(`/security-scan`・`/review-sweep`)。指摘の修正は別タスク(AM-T25-F1 …)として PROGRESS に追加する(変更ファイル: `output/reports/security/SECURITY_auto-masking_<日時>.md`, `output/reports/review/REVIEW_auto-masking_<日時>.md` | 依存: AM-T23, AM-T24)
  - 確認項目: §12 の全項目(文字列が IPC・ログ・パニック文言に出ない、`unsafe` の前提コメント、Objective-C 例外の捕捉、入力検証、二重実行防止、XSS)/ `git diff main -- src-tauri/tauri.conf.json src-tauri/capabilities/` が空 / 依存の再確認(AM-T03 と同じ手段で `Cargo.lock` 全件)/ 評価データ・テストに実在のトークンや個人情報が無い / 製品名が書かれていない
  - 受け入れ基準:
    - [x] Critical / High が 0 件(または修正タスクが PROGRESS にある)
    - [x] レビューの MUST が 0 件(または修正タスクが PROGRESS にある)
  - 検証コマンド: `NOLOG` / `rg -n 'console\.' src/ui/autoMask.ts src/ui/maskOverlay.ts src/canvas/maskSession.ts src/ipc/textScan.ts` / `git diff main -- src-tauri/tauri.conf.json src-tauri/capabilities/` / `SMOKE`
- [x] AM-T26 — 文言・README・紹介ページ・ADR・docs の仕上げ(NFR-005)(変更ファイル: `README.md`, `.github/pages/index.html`, `output/design/ADR_<NNN>_text-recognition.md`, `output/design/ADR_INDEX.md`, `docs/docs/*.md`, `project-config.md` §2・§3・§11 | 依存: AM-T25)
  - README・紹介ページに機能を追加する。「自動で守る」「すべて隠す」と書かず、利用者が最終確認する補助機能であることを示す。製品名を書かない
  - ADR: §15 #1(Rust から Vision を直接呼ぶ)の判断・試作の結果・却下した案
  - 各タスクで更新してきた `docs/docs/*.md` の整合を確認し、不足を埋める
  - 受け入れ基準:
    - [x] `rg -n '自動で守|すべて隠|安全です|機密はありません' README.md .github/pages/index.html src/ui` が 0 件(2026-10-09: 該当は `src/ui/*.test.ts` の禁止語の一覧 2 行だけ)
    - [x] `npm run e2e:screenshots:after` の紹介ページのスクリーンショットで表示崩れなし(2026-10-09: `landing.visual.ts` は `docs/media/` の画像を撮り直すため実行せず、紹介ページを Playwright で幅 1280px・390px に描画して確認。横はみ出し 0・ページのエラー 0)
    - [x] `SMOKE` 緑(2026-10-09: build OK / vitest 621 / cargo 453・ignored 8 / clippy 0 / e2e 77)
  - 検証コマンド: 上記 `rg` / `npx playwright test --config=e2e/screenshots/playwright.config.ts e2e/screenshots/landing.visual.ts` / `SMOKE`

## 依存関係グラフ

```text
[Rust・検出]
T04 ──┬──→ T09 ──┐
      │          ├──→ T14 ──→ T16 ──┬──→ T18 ──→ T19 ─🚏─┐
T03 ──┼──→ T11 ──┘                  │     ▲                 │
      │                             │     │                 ├──→ T23 ─🚏─┐
T03,T04,T05 ──→ T10 ────────────────┼─────┘                 │            │
T05 ───────────────────────────────────────→ (T19)          │            │
                                    │                       │            │
[辞書]                               └──→ T21 ──→ T22 ───────┘            │
T01 ─🚏─→ T20 ─🚏─────────────────────────→ (T21)                         │
                                                                         ├──→ T25 ──→ T26
[フロント]                                                                │
T06 ──┬──→ T13 ──┐                                                       │
T02 ──┴──→ T12 ──┼──→ T15 ──→ T17 ──┐                                    │
T07 ─────────────┤                  ├──→ T24 ────────────────────────────┘
T08 ─────────────┘        T18 ──────┘
```

(🚏 = 人間の承認で止まる箇所。ID の `AM-` は省略)

依存の一覧(グラフの読み取り補助):

| タスク | 依存 |
| ------ | ---- |
| AM-T09 | T04 |
| AM-T10 | T03, T04, T05 |
| AM-T11 | T03, T04 |
| AM-T12 | T02, T06 |
| AM-T13 | T06 |
| AM-T14 | T09, T11 |
| AM-T15 | T02, T06, T07, T08, T12, T13 |
| AM-T16 | T14 |
| AM-T17 | T15 |
| AM-T18 | T09, T10, T16 |
| AM-T19 | T05, T18 |
| AM-T20 | T01(人間承認) |
| AM-T21 | T16, T20(人間承認) |
| AM-T22 | T21 |
| AM-T23 | T19, T22 |
| AM-T24 | T17, T18 |
| AM-T25 | T23, T24 |
| AM-T26 | T25 |

推奨の実行順(逐次): T01 → T03 → T04 → T05 → T02 → T06 → T07 → T08 → T09 → T11 → T10 → T20(T01 承認後)→ T12 → T13 → T14 → T15 → T16 → T17 → T18 → T19 → T21(T20 承認後)→ T22 → T23 → T24 → T25 → T26

- 「形が決まっているもの」の版は T19 の時点で成り立つ(PRD §9 の山場は T21〜T23)
- フロント(T06〜T08・T12・T13・T15・T17)は IPC モックで Rust と独立に進められる

## テスト戦略

### ユニットテスト

- **Rust(`cargo test`)**: 検出規則の境界値(区切りの有無・全角/半角・桁の上下限・Luhn・隣接文字・誤読の許容)、右隣・直下の観測の対応付け、正規化と UTF-16 位置(日本語・絵文字)、座標変換・余白・収め・重複除去、PNG の検証、`SensitiveText` の伏せ字、`scan_page` の通し、コマンドの二重実行・本文の種類・固定エラー。**Vision は使わず偽物の `RecognizedPage` で行う**
- **Rust 実機(`cargo test -- --ignored`)**: `ocr.rs` の通し(T10)、`scan()` の通し(T18)、評価ハーネス(T19・T23)。CI の `cargo test` では走らない
- **TS(Vitest)**: `maskSession` の状態遷移と古い結果の破棄、`applyBaseEdits` の 1 手化と重なる矩形の undo/redo、`textScan` の応答検証、印の % 配置とラベル、確認中のキー判定、`autoMask` の開始条件・⌘⇧M・再クランプ・文言
- テストの方針: 文字列を `assert` のメッセージや出力に出さない。トークン形のテストデータは実行時に連結して作る

### E2Eテスト

- `e2e/auto-mask.spec.ts`(IPC モック): 一連の流れと undo/redo、⌘C に印が写らない、処理中の画像切替、二重実行、0 件、失敗、画像なし、ウィンドウの大きさ変更、確認中の操作制限、Esc
- `e2e/screenshots/autoMask.visual.ts`: 明るい/暗い画像の上の印、外した印、結果パネル、0 件
- OS の文字認識そのものは E2E の対象外(既存方針)。実機の手動確認は T24

### 検出率の評価(NFR-003)

- T05 の評価用画像セット + T19/T23 のハーネス。基準は正解の矩形が候補に 100% 覆われること

## ドキュメント更新計画

一次更新は各実装タスク(`/implementing-features`)が最小差分で行う。

### project-config.md

- §2(技術スタック): T03 で `objc2-vision`(新規)と、`objc2-foundation`・`objc2-core-foundation`・`regex` の直接依存化
- §3(コマンド): T05 で `npm run mask:fixtures`、T19 で評価の `cargo test ... masking::eval -- --ignored --nocapture`
- §11(既知の落とし穴): T04 で「Rust の `String` はバイト位置、Vision の `NSRange` は UTF-16 位置。`Utf16Map` で変換する」、T11 / T14 で「表のラベルと値は別の観測として返る(右隣の観測を探す)」、T05 / T14 で「トークン形のテストデータはソースに完全な形で書かない」(追記前に重複確認)

### docs/

- `docs/docs/project.md`: T18 で IPC コマンド表に `scan_sensitive_text`、T06 でストア表に `maskSession`、T05 / T19 でコマンド
- `docs/docs/architecture.md`: T04 で `src-tauri/src/masking/`、T05 で `eval/masking/`、各タスクでテスト一覧
- `docs/docs/data-model.md`: T06 で `maskSession`(永続化なし)、T18 で `MaskCandidate` の形
- `docs/docs/development-patterns.md`: T04 で文字列を出力しない規約(`SensitiveText`・ログ禁止)、T07 で `applyBaseEdits()` の順序の約束、T13 で確認中の操作制限
- `THIRD_PARTY_NOTICES.md`: T21(辞書)。`objc2-vision` の表示が要るかは T01 の結果に従う
- `README.md`・`.github/pages/index.html`・ADR: T26

## リスク・懸念事項

| リスク | 影響 | 対策(タスク) |
| ------ | ---- | -------------- |
| 評価セットに合わせて規則を調整しすぎ、実画面で検出率が落ちる | 中 | 人名・会社名は辞書と別に用意した架空の組み合わせで作る(T05)。調整に使わない保留分を残すかは T19 で人間と決める |
| トークン形のテストデータがシークレット検出(push 保護・スキャナ)に引っかかる | 中 | ソースに完全な形を書かず、実行時に連結する(T05・T14、【要確認】#5) |
| `mod masking` が呼び出し口より先に入り、clippy `-D warnings` の未使用警告で SMOKE が落ちる | 中 | T04 で `cfg_attr(not(test), allow(dead_code))` を付け、T18 で外す(受け入れ基準に含めた) |
| Vision の部分範囲の領域が不正確で、正解を 100% 覆えない | 中 | 余白の係数を T19 で調整。足りなければ行全体の領域へ広げる案を人間に提示 |
| `objc2-vision` の機能指定が足りず、機能を足すたびに依存が増える | 中 | T03 で機能を足すたびに Lock 差分の確認をやり直す。新しいパッケージが増えるならコミットせず人間に相談 |
| 日本語の固有名詞が 70% に届かない | 高 | T23 で規則・辞書件数を調整。英字の人名は §15 #3 C 案を提案(依存追加は別途承認) |
| 実機計測が速い機種(M5)だけになる | 中 | 計測機種を明記し、より遅い機種の扱いは【要確認】#7 |
| 一括モザイクの undo 用ピクセルが 8MB を超え、履歴へ切り替えた後に取り消せない | 低 | 既存の焼き込みと同じ扱い(§6.2)。T17 の E2E では対象外、docs に明記 |

## 【要確認】(ゲート 3 で人間が決める)

**決定(2026-10-09、人間)**: #1 B(OSV の一括照会、ツールは入れない)/ #2 B(`0.3`、`Cargo.lock` で 0.3.2 に固定)/ #3 A(画像ごとに数える)/ #4 B(複数の候補の和で覆えていれば検出)/ #5 A(トークン形は実行時に組み立てる)/ #6 C(95% の細分は届くまで止める、70% の細分は記録して人間が判断)/ #7 C(手元で計測し、遅い機種・macOS 14 の実機確認はゲート 4 で人間が行う)。本文中の「【要確認】#n」はこの決定に読み替える

| # | 項目 | 選択肢 | 推奨 | 影響タスク |
| - | ---- | ------ | ---- | ---------- |
| 1 | 「cargo audit 相当」の確認手段(手元に `cargo-audit` は未導入) | **A**: `cargo install cargo-audit --locked` で導入し `cargo audit` を実行(ツール自体の依存を手元に入れる)/ **B**: ツールを入れず、`Cargo.lock` の全パッケージ・版を OSV の一括照会 API に問い合わせる(RustSec の勧告も OSV に収録されている)/ **C**: A と B の両方 | **B**。新しいツールの供給経路を増やさずに `Cargo.lock` 全件を確認でき、ARCH §15 の事前確認と同じ手段で比べられる。取り下げ(yanked)は `cargo update --dry-run` と crates.io の版情報で別途確認する | T03・T25 |
| 2 | `objc2-vision` の版の指定 | **A**: `=0.3.2`(完全固定)/ **B**: `0.3`(`Cargo.lock` で 0.3.2 に固定。既存の `objc2-app-kit` と同じ書き方) | **B**。`Cargo.lock` がコミットされていて実際の版は固定される。既存の書き方と揃い、`cargo update` 時に Lock の差分で検知できる。更新時は T03 と同じ確認を行う | T03 |
| 3 | 評価用画像セットの「件数」の数え方 | **A**: 画像ごとに数える(同じ文字列でも解像度・テーマ違いの 4 枚は 4 件)。ただし細分ごとに異なる文字列を 10 件以上 / **B**: 異なる文字列で数える(形が決まっているもの 40 件・固有名詞 30 件以上の異なる文字列) | **A**。読み取りの条件(解像度・明暗)が違えば別の試行になる。異なる文字列の下限で規則の偏りを防ぐ。B は HTML の作成量が約 4 倍 | T05・T19 |
| 4 | 1 つの正解を 2 つ以上の候補の和で覆った場合 | **A**: 検出としない(1 つの候補で 100% 覆うことが条件)/ **B**: 候補の和で 100% 覆えば検出 | **B**。モザイクは全候補にかかるため、和で覆えれば隠れる。PRD §10 #10 の「候補の領域に 100% 覆われる」とも矛盾しない | T19 |
| 5 | トークン形・カード番号形のテストデータの書き方 | **A**: ソース・HTML に完全な形を書かず、実行時に接頭辞と乱数を連結して作る / **B**: そのまま書き、シークレット検出の誤検知は個別に許可する | **A**。公開リポジトリの push 保護や外部のスキャナに止められず、誤って本物と見分けられない状態も避けられる | T05・T14・T16 |
| 6 | 検出率が目標に届かないときの進め方 | **A**: 目標に届くまで次のタスクへ進まない / **B**: 結果を記録して先へ進め、T23 の後に人間が「出荷する / 改善を続ける / 目標を見直す」を決める / **C**: 形が決まっているもの(95%)は A、固有名詞(70%)は B | **C**。形が決まっているものは規則で直せる見込みが高く、ここで止めないと後の調整で崩れる。固有名詞は PRD が高リスクとして認めており、全体を見て判断する方がよい | T19・T23 |
| 7 | NFR-001(最も遅い想定の機種)と NFR-004(macOS 14)の確認環境 | **A**: 手元の機種で計測し、macOS 14 は仮想環境で確認(遅い機種は「未計測」と明記)/ **B**: 人間が別の機種・macOS 14 の実機で、手動確認の項目どおりに実施 / **C**: A を先に行い、B を ゲート 4 で人間が実施 | **C**。開発を止めずに数値を残し、対応 OS の下限の確認は実機で人間が行う。既存の `CHECKLIST_T18.md` の運用と同じ | T24 |

- 上記以外の ARCH の【仮定】(余白の係数・PNG の上限サイズ 16384px / 128MB・Objective-C 例外の捕捉方法)は、実装タスクの中でテストと評価で確定し、PROGRESS に記録する
