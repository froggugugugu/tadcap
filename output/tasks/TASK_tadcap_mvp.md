ステータス: 承認済み(ゲート3 通過 2026-09-23)

# タスク分解: Tadcap MVP

> 生成元: output/prd/PRD_tadcap_mvp.md, output/design/ARCH_tadcap_mvp.md
> 生成日: 2026-09-23
> ゲート3 決定(2026-09-23、人間決定): §要確認事項 参照。要確認#1(Lint)は A案(ESLint 不採用)+ `cargo clippy -D warnings` をスモークテストコマンドへ追加、
> 要確認#2(CI)は A案(CI ワークフロー未作成)で決定。加えて実行順を T07 直後に T15・T16 を前倒し(下記タスク分解冒頭の【実行順】参照、タスクID は変更なし)

## 要件サマリー

MVP スコープ(FR-001, FR-002, FR-004, FR-005, FR-006, FR-008, FR-009, FR-010 / NFR-001〜003)を、
ARCH のディレクトリ構成(§4)・レイヤー構成(§3)・エントリーポイント構成(§11)どおりに実装する。

- [ ] `screencapture -i` による範囲指定/ウィンドウキャプチャが `src-tauri/src/capture/` の trait 抽象化の背後で動作する(FR-001, FR-002)
- [ ] 画面収録権限が未許可の場合、キャプチャを実行せず案内 UI + 「システム設定を開く」導線を表示する(NFR-002)
- [ ] グローバルショートカット押下で他アプリアクティブ中でもキャプチャが起動し、完了後エディタウィンドウが前面表示される(FR-004)
- [ ] Canvas 上で矢印描画・モザイク焼き込みができ、ツール切替 UI で切り替えられる(FR-006, FR-008)
- [ ] 「クリップボードにコピー」(ボタン/Cmd+C)で `@tauri-apps/plugin-clipboard-manager` が最終 PNG を書き込み、失敗時は Rust(`arboard`)フォールバックへ切り替わる(FR-005)
- [ ] メニューバーに常駐し「キャプチャ/エディタを開く/終了」の 3 項目メニューを持ち、ウィンドウを閉じてもプロセスが継続する。Dock アイコンは非表示(FR-009)
- [ ] セッション内履歴がサイドバーに表示され、項目クリックで編集後画像が Canvas に再読込される。アプリ終了で破棄される(FR-010)
- [ ] ショートカット押下から OS 標準選択 UI 表示まで 200ms 未満であること、未達なら ScreenCaptureKit 移行の判断ポイントを提示すること(NFR-001)
- [ ] 依存を最小限に保ち、React/Vue 等の重量フレームワークを導入しない(NFR-003)
- [ ] 各タスクの受け入れ条件は、本ドキュメントが確定するスモークテストコマンド(下記【スモークテストコマンド】参照)で pass/fail を判定できる形にする

### スモークテストコマンド(全タスク共通・T01 で導入。ゲート3 決定で clippy を追加)

```bash
npm run build && npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

- `npm run build`: `tsc && vite build`(既存) — フロントエンドの型検査とビルド確認
- `npm run test:run`: Vitest のワンショット実行(T01 で `package.json` に追加) — TS ユニットテスト
- `cargo test --manifest-path src-tauri/Cargo.toml`: Rust ユニットテスト(標準 `cargo test`)
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`: Rust 静的解析(警告をエラー扱い)。ゲート3 決定(要確認#1、A案)により、専用リンター(ESLint 等)は導入せず `cargo clippy` のみをスモークテストに組み込む。T01 で導入し、既存スキャフォールドの clippy 警告があれば T01 内で解消する
- 各タスクの受け入れ条件は「スモークテストコマンドが exit 0」を最低ラインとし、そのタスク固有の検証(新規テストの pass/fail、手動確認項目)を追加する

## 影響調査

| カテゴリ | ファイル | 変更内容 |
| --- | --- | --- |
| 設定 | `package.json` | 追加(Vitest, Playwright, `@tauri-apps/plugin-global-shortcut`, `@tauri-apps/plugin-clipboard-manager`, `test`/`test:run`/`e2e` スクリプト) |
| 設定 | `src-tauri/Cargo.toml` | 追加(`thiserror`, `arboard`, `tauri-plugin-global-shortcut`, `tauri-plugin-clipboard-manager`, `tauri` の `tray-icon` feature) |
| 設定 | `src-tauri/tauri.conf.json` | 変更(`app.security.assetProtocol.scope` を一時キャプチャディレクトリに限定、`trayIcon` 設定追加) |
| 設定 | `src-tauri/capabilities/default.json` | 変更(使用プラグインの permission を最小権限で追加) |
| 設定 | `vitest.config.ts` または `vite.config.ts` | 追加(Vitest の `test` 設定) |
| 設定 | `playwright.config.ts` | 追加(E2E 実行設定、対象 `e2e/`) |
| ユーティリティ | `src-tauri/src/error.rs` | 追加(コマンド共通エラー型、`thiserror` 使用) |
| ユーティリティ | `src-tauri/src/capture/tempfile.rs` | 追加(一時ディレクトリ配下の一意なファイル名生成) |
| ユーティリティ | `src/canvas/render.ts` | 追加(画像描画・`toBlob()` による PNG エクスポート) |
| スキーマ | `src-tauri/src/capture/mod.rs` | 追加(`CaptureProvider` trait, `CaptureResult { id, sourcePath, kind, createdAt }`) |
| スキーマ | `src/history/historyStore.ts` | 追加(`HistoryItem { id, thumbnail, image, createdAt }` 型) |
| ストア | `src/canvas/canvasState.ts` | 追加(現在画像・選択中ツール・描画中フラグ) |
| ストア | `src/history/historyStore.ts` | 追加(`HistoryItem[]` の追加/選択/破棄) |
| ストア | `src/ipc/permissions.ts` | 追加(`permissionState`: 未確認/許可/未許可) |
| コンポーネント | `src/canvas/tools/arrowTool.ts` | 追加(矢印描画、既定色 `#FF5C8A`) |
| コンポーネント | `src/canvas/tools/mosaicTool.ts` | 追加(矩形選択→ピクセル化焼き込み) |
| コンポーネント | `src/ui/toolbar.ts` | 追加(矢印/モザイクのツール切替 UI) |
| コンポーネント | `src/ui/sidebar.ts` | 追加(履歴一覧表示・再読込) |
| コンポーネント | `src/ui/permissionBanner.ts` | 追加(権限未許可時の案内 UI) |
| コンポーネント | `src/ui/captureButton.ts` | 追加(キャプチャ開始ボタン・Cmd+C バインド) |
| ページ | `index.html` | 変更(greet スキャフォールド撤去、エディタ画面のマークアップに置換) |
| ページ | `src/main.ts` | 変更(greet スキャフォールド撤去、DOMContentLoaded で各 `init*()` 呼び出し・IPC イベント購読) |
| ページ | `src/styles.css` | 変更(CSS カスタムプロパティ `--arrow-color` 等、レイアウト追加) |
| ユーティリティ | `src-tauri/src/commands.rs` | 追加(`#[tauri::command]` 関数の集約) |
| ユーティリティ | `src-tauri/src/capture/screencapture.rs` | 追加(`screencapture -i` 実装、Esc キャンセル処理) |
| ユーティリティ | `src-tauri/src/capture/permission.rs` | 追加(CoreGraphics `extern "C"` FFI、画面収録権限事前確認) |
| ユーティリティ | `src-tauri/src/clipboard/mod.rs` | 追加(`arboard` によるクリップボード書込フォールバック) |
| ユーティリティ | `src-tauri/src/tray.rs` | 追加(メニューバー常駐・3 項目メニュー) |
| ユーティリティ | `src-tauri/src/shortcuts.rs` | 追加(グローバルショートカット登録) |
| ユーティリティ | `src-tauri/src/lib.rs` | 変更(プラグイン登録・`setup()`・`on_window_event`・`invoke_handler` の組立、既存 `greet` は撤去) |
| テスト | `src-tauri/src/**/*.rs` 内 `#[cfg(test)] mod tests` | 追加(各バックエンドタスクに同梱) |
| テスト | `src/**/*.test.ts` | 追加(各フロントエンドタスクに同梱、コロケーション) |
| テスト | `e2e/*.spec.ts`, `e2e/fixtures/tauriMock.ts` | 追加(Playwright、`window.__TAURI__` モック) |
| ドキュメント | `docs/docs/project.md`, `docs/docs/architecture.md`, `docs/docs/data-model.md`, `docs/docs/development-patterns.md` | 変更(実装フェーズで `/implementing-features` が更新。本タスク分解では変更しない) |
| ドキュメント | `project-config.md` §2/§3 | 変更(実装フェーズで `/implementing-features` が更新。本タスク分解では変更しない) |

## タスク分解

> 実装モードは `output/tasks/PROGRESS.md` §1 により**逐次**(1 セッション1タスク)。
> 以下の Phase 分けは「変更ファイルが重複しないタスク群」の識別(将来複数エージェント並行時の目安)であり、
> 現行運用では Phase 番号順に 1 タスクずつ着手してよい。各タスクの「受け入れ条件」は先頭で必ず
> スモークテストコマンド(§要件サマリー)の exit 0 を含む。

> **【実行順】(ゲート3 決定 2026-09-23)**: タスクID は変更しないが、T15・T16(トレイ・グローバルショートカット)を
> T07 の直後に前倒しする。Phase 番号もこの順に振り直した:
>
> `T01 → T02 → T03 → T04 → T05 → T06 → T07 → T15 → T16 → T08 → T09 → T10 → T11 → T12 → T13/T14 → T17 → T18`

### Phase 1(並行可能・起点)
- [ ] T01 — テスト基盤とスモークテスト整備(変更ファイル: package.json, vite.config.ts または vitest.config.ts, tsconfig.json(必要な場合), src/test/smoke.test.ts(新規プレースホルダ) | 依存: なし)
  - 目的: TS ユニットテスト FW(Vitest)を導入し、`cargo test`・`cargo clippy` とフロントエンドビルドが既存スキャフォールドで通ることを確認したうえで、以降全タスク共通のスモークテストコマンドを確定する(ゲート3 決定: 専用リンター(ESLint)は導入せず `cargo clippy -- -D warnings` をスモークテストに組み込む)
  - 受け入れ条件: `npm install` が exit 0 / `npm run build` が exit 0 / `npm run test:run` が exit 0(`src/test/smoke.test.ts` に `1+1=2` 等の自明なテストを 1 件含め、Vitest の配線を証明する) / `cargo test --manifest-path src-tauri/Cargo.toml` が exit 0 / `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` が exit 0(既存スキャフォールド(`greet` コマンド等)に clippy 警告が出ている場合は本タスク内で解消する)
  - 対応 FR/NFR: NFR-003(軽量性の確認基盤)、以降全 FR の検証基盤

### Phase 2(Phase 1 完了後)
- [ ] T02 — Rust エラー型・コマンド集約の雛形(変更ファイル: src-tauri/src/error.rs(新規), src-tauri/src/commands.rs(新規、空のハンドラ集約のみ), src-tauri/src/lib.rs, src-tauri/Cargo.toml | 依存: T01)
  - 目的: `thiserror` によるコマンド共通エラー型と、`#[tauri::command]` を集約する `commands.rs` の器を用意し、以降のタスクが 1 関数ずつ追加できるようにする
  - 受け入れ条件: スモークテストコマンドが exit 0(既存 `greet` コマンドは維持したまま `commands.rs` 経由に整理してもよい)
  - 対応 FR/NFR: 全 FR の基盤(ARCH §11 エントリーポイント構成)

### Phase 3(Phase 2 完了後)
- [ ] T03 — キャプチャ抽象化(CaptureProvider trait)と一時ファイル管理(変更ファイル: src-tauri/src/capture/mod.rs(新規), src-tauri/src/capture/tempfile.rs(新規), src-tauri/src/lib.rs(モジュール宣言) | 依存: T02)
  - 目的: `CaptureProvider` trait を定義し、OS 一時ディレクトリ配下に一意なファイル名を生成する関数を実装する(固定パス上書きの防止、FR-001 受け入れ基準)
  - 受け入れ条件: スモークテストコマンドが exit 0 / `cargo test` に一時ファイル名の一意性テスト(連続 N 回呼び出しで重複が無いこと)が追加され pass
  - 対応 FR/NFR: FR-001, FR-002(基盤)、PRD §10 決定#2(trait 抽象化)

### Phase 4(Phase 3 完了後)
- [ ] T04 — 画面収録権限チェック(CoreGraphics FFI)(変更ファイル: src-tauri/src/capture/permission.rs(新規), src-tauri/src/capture/mod.rs(モジュール宣言・呼び出し口) | 依存: T03)
  - 目的: `CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess` を `extern "C"` 宣言の最小 FFI(`unsafe` ブロックに限定)で呼び出し、許可状態を判定する関数を実装する(第三者プラグイン不使用、ARCH §15 決定#1)
  - 受け入れ条件: スモークテストコマンドが exit 0(`cargo build` でリンクエラーが出ないこと)。実際の権限状態のモックは OS 依存のため自動テストの対象外とし、手動確認チェックリストへ回す
  - 対応 FR/NFR: NFR-002(実装基盤)

### Phase 5(Phase 3, 4 完了後)
- [ ] T05 — screencapture CLI 実装 + Esc キャンセル処理(変更ファイル: src-tauri/src/capture/screencapture.rs(新規)、src-tauri/src/capture/mod.rs(`ScreenCaptureCli` 登録) | 依存: T03, T04)
  - 目的: `screencapture -i <一時ファイルパス>` を起動する `ScreenCaptureCli` 実装を追加し、権限未許可時は起動しない分岐、Esc キャンセル時(ファイル未生成)はエラー扱いにしない分岐を実装する
  - 受け入れ条件: スモークテストコマンドが exit 0 / `cargo test` に「権限未許可なら screencapture を起動しない」「ファイル未生成時は Cancelled としてエラーにしない」の 2 分岐テストが追加され pass(プロセス起動をトレイト経由でモック可能な構造にする)
  - 対応 FR/NFR: FR-001, FR-002, NFR-002(実装)

### Phase 6(Phase 5 完了後)
- [ ] T06 — capture_screen コマンド実装 + completed イベント発火(変更ファイル: src-tauri/src/commands.rs, src-tauri/src/lib.rs(invoke_handler 登録) | 依存: T05)
  - 目的: `commands::capture_screen` を実装し、`capture::run()` の成功結果を Tauri イベント `capture://completed` でフロントエンドへ一方向通知する(ARCH §5.2, §7.1)
  - 受け入れ条件: スモークテストコマンドが exit 0 / `cargo test` で `capture_screen` の戻り値・エラー変換(`error.rs`)のユニットテストが pass
  - 対応 FR/NFR: FR-001, FR-002

### Phase 7(Phase 6 完了後)
- [ ] T07 — フロントエンド IPC 層(capture)と Canvas 表示(変更ファイル: src/ipc/capture.ts(新規), src/canvas/canvasState.ts(新規), src/canvas/render.ts(新規), src/ui/captureButton.ts(新規), src/main.ts, index.html, src/styles.css | 依存: T06)
  - 目的: `startCapture()` / `onCaptureCompleted()` を実装し、`capture://completed` 受信で `convertFileSrc(sourcePath)` から Canvas へ画像を反映する。既存の greet スキャフォールド(フォーム・ロゴ)を撤去し、キャプチャ開始ボタンを配置する
  - 受け入れ条件: スモークテストコマンドが exit 0 / `npm run test:run` に `canvasState` の状態更新(画像セット等)の純粋関数テストが追加され pass。実際の `screencapture` 起動確認は手動確認チェックリストへ
  - 対応 FR/NFR: FR-001, FR-002(フロントエンド連携)

### Phase 8(Phase 6 完了後。ゲート3 決定(2026-09-23)により T07 の直後・T08 着手前に前倒し)
- [ ] T15 — メニューバー常駐(トレイ)+ Dock アイコン非表示 + ウィンドウクローズ制御(変更ファイル: src-tauri/src/tray.rs(新規)、src-tauri/src/lib.rs(`set_activation_policy(Accessory)`, `build_tray()`, `on_window_event` 追加) | 依存: T06)
  - 目的: `TrayIconBuilder` で「キャプチャ/エディタを開く/終了」3 項目メニューを構築し、いずれも既存の `capture::run()` 系コマンドを再利用する。`#[cfg(target_os = "macos")] app.set_activation_policy(tauri::ActivationPolicy::Accessory)` で Dock アイコンを非表示にし、`CloseRequested` イベントで `window.hide()` + `api.prevent_close()` によりプロセスを継続させる
  - 受け入れ条件: スモークテストコマンドが exit 0(トレイ構築関数のコンパイル確認)。メニュー動作・ウィンドウクローズ後のプロセス継続は手動確認チェックリストへ
  - 対応 FR/NFR: FR-009

### Phase 9(Phase 8 完了後。`lib.rs` の `setup()` 内順序を ARCH §11 の「トレイ→ショートカット」に合わせるため T15 の後に着手する。ゲート3 決定により T07 にも依存を追加)
- [ ] T16 — グローバルショートカット登録(変更ファイル: src-tauri/src/shortcuts.rs(新規)、src-tauri/src/lib.rs(`tauri_plugin_global_shortcut` 登録・`register_capture_shortcut()` 呼び出し、`#[cfg(desktop)]` ガード)、src-tauri/Cargo.toml(`tauri-plugin-global-shortcut`)、package.json(`@tauri-apps/plugin-global-shortcut`)、src-tauri/capabilities/default.json(`global-shortcut:allow-register`/`allow-unregister`/`allow-is-registered`) | 依存: T06, T15, T07(ゲート3 決定で追加。エディタ前面表示に必要))
  - 目的: 既定候補キー `Cmd+Shift+2`(`Cmd+Shift+4` は OS 予約のため使用不可、PRD FR-004)で `capture::run()` を起動するショートカットを登録する。押下後、キャプチャ完了時に Rust 側でメインウィンドウの `show()` + `set_focus()` を呼び前面表示する
  - 受け入れ条件: スモークテストコマンドが exit 0(登録関数のコンパイル確認)。既定キーの OS 標準/主要アプリとの衝突確認、押下→前面表示の実機確認は手動確認チェックリストへ(衝突が判明した場合はコード側の既定値を変更しキー変更 UI は追加しない)
  - 対応 FR/NFR: FR-004

### Phase 10(Phase 4, 7, 9 完了後)
- [ ] T08 — 画面収録権限未許可時の案内 UI(変更ファイル: src/ipc/permissions.ts(新規), src/ui/permissionBanner.ts(新規), src-tauri/src/commands.rs(`check_screen_recording_permission`, `open_screen_recording_settings` 追加), src-tauri/src/lib.rs(invoke_handler 追加), src-tauri/capabilities/default.json(`opener:allow-open-url` を固定 URL スコープで追加), src/main.ts | 依存: T04, T07)
  - 目的: 起動時・キャプチャ試行前に権限状態を確認し、未許可なら案内 UI(説明 + 「システム設定を開く」ボタン)を表示する。ボタンは `opener` プラグインで固定 URL `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` のみを開く
  - 受け入れ条件: スモークテストコマンドが exit 0 / `npm run test:run` で権限状態(未確認/許可/未許可)ごとのバナー表示分岐のロジックテストが pass。実機での権限フロー確認は手動確認チェックリストへ
  - 対応 FR/NFR: NFR-002(UI)

### Phase 11(Phase 7, 10 完了後。T08 と `src/main.ts` を共有するため Phase 10 の後に着手する)
- [ ] T09 — 矢印ツールとツール切替 UI 土台(変更ファイル: src/canvas/tools/arrowTool.ts(新規), src/ui/toolbar.ts(新規), src/canvas/canvasState.ts(ツール状態追加), src/styles.css(`--arrow-color` 等), src/main.ts | 依存: T07)
  - 目的: ドラッグ操作で始点→終点の矢印を Canvas ピクセルに焼き込む処理と、矢印/モザイクをトグル切替する `toolbar.ts` の土台(モザイクは T10 で有効化)を実装する。既定色は `#FF5C8A`
  - 受け入れ条件: スモークテストコマンドが exit 0 / `npm run test:run` に矢印の座標計算(始点・終点から描画パラメータを導出する純粋関数)のテストが追加され pass
  - 対応 FR/NFR: FR-006

### Phase 12(Phase 11 完了後。`toolbar.ts` を共有)
- [ ] T10 — モザイクツール(変更ファイル: src/canvas/tools/mosaicTool.ts(新規), src/ui/toolbar.ts(モザイク選択肢を有効化) | 依存: T09)
  - 目的: ドラッグで選択した矩形領域を Canvas ピクセルにピクセル化焼き込みする(CSS フィルタ等の見た目のみの変更は不可、FR-008 受け入れ基準)。ぼかしオプションは実装しない
  - 受け入れ条件: スモークテストコマンドが exit 0 / `npm run test:run` にピクセル化アルゴリズムの純粋ロジックテスト(矩形内ピクセル値のブロック平均化などを Canvas 依存を最小化して検証)が追加され pass
  - 対応 FR/NFR: FR-008

### Phase 13(Phase 12 完了後)
- [ ] T11 — NFR-001 中間計測とScreenCaptureKit 移行判断ポイント(変更ファイル: src-tauri/src/capture/mod.rs(計測用タイムスタンプのログ出力を追加), testreport/ 配下に計測結果ログ | 依存: T05, T06, T10)
  - 目的: PRD §9 Phase4 相当のチェックポイントとして、ショートカット/ボタン押下(keydown・click)から `screencapture -i` プロセス起動完了までの差分をログ出力し、10 回試行の中央値を計測する。200ms 未満なら CLI 継続、未達なら ScreenCaptureKit 移行検討を次工程へ引き継ぐ
  - 受け入れ条件: スモークテストコマンドが exit 0 / 手動計測(10 回試行)の中央値を `testreport/` に記録し、200ms 未満か否かを明記する。未達の場合は本ドキュメント §要確認事項 相当の判断ポイントとして `output/tasks/PROGRESS.md` へ申し送り(PJM が追記、本タスクでは編集しない)
  - 対応 FR/NFR: NFR-001(中間計測)

### Phase 14(Phase 7, 12 完了後)
- [ ] T12 — クリップボードコピー(プラグイン + Rust フォールバック)(変更ファイル: src/ipc/clipboard.ts(新規), src-tauri/src/clipboard/mod.rs(新規、`arboard` 使用), src-tauri/src/commands.rs(`write_image_fallback` 追加), src-tauri/src/lib.rs(`tauri_plugin_clipboard_manager` 登録), src-tauri/Cargo.toml(`arboard`, `tauri-plugin-clipboard-manager`), package.json(`@tauri-apps/plugin-clipboard-manager`), src-tauri/capabilities/default.json(`clipboard-manager:allow-write-image`), src/ui/captureButton.ts またはコピー用 UI モジュール(新規), src/main.ts(Cmd+C バインド) | 依存: T07, T10)
  - 目的: `canvas/render.ts` が生成した最終 PNG バイト列を、まず `@tauri-apps/plugin-clipboard-manager` の `writeImage()` で書き込み、失敗時のみ Rust フォールバック(`write_image_fallback` → `arboard`)へ切り替える。「クリップボードにコピー」ボタンと `Cmd+C` の両方から起動できるようにする
  - 受け入れ条件: スモークテストコマンドが exit 0 / `npm run test:run` でプラグイン失敗時にフォールバック分岐へ切り替わることをモックで検証するテストが pass / `cargo test` で `write_image_fallback` の入力バイト列の型検証テストが pass(実クリップボードへの書込確認は手動確認チェックリストへ)
  - 対応 FR/NFR: FR-005

### Phase 15(Phase 14 完了後・並行可能: T13 と T14 は変更ファイルが重複しない)
- [ ] T13 — E2E テスト基盤(Playwright + IPC モック)(変更ファイル: package.json(`@playwright/test` 追加、`e2e` スクリプト追加), playwright.config.ts(新規), e2e/fixtures/tauriMock.ts(新規), e2e/capture-flow.spec.ts(新規) | 依存: T12)
  - 目的: Vite dev server 上で `window.__TAURI__` をモックし、「ツール切替→矢印/モザイク付与→クリップボードボタン押下」の UI フローを Playwright で検証する結合テストを 1 本作成する(ARCH §10 決定#4)。実際の Tauri 実行・OS ネイティブ導線は対象にしない
  - 受け入れ条件: スモークテストコマンドが exit 0 / `npm run e2e`(= `playwright test`)が exit 0
  - 対応 FR/NFR: PRD §8(E2E 対象)、ARCH §10.1

- [ ] T14 — セッション内履歴(サイドバー)(変更ファイル: src/history/historyStore.ts(新規), src/ui/sidebar.ts(新規), src/main.ts(サイドバー初期化), src/canvas/canvasState.ts(再読込対応), src/styles.css | 依存: T12)
  - 目的: クリップボードコピー成功時に編集後画像を `HistoryItem` として `historyStore` に追加(サムネイル生成含む)し、サイドバーの項目クリックで `canvasState` に再読込する(元画像には戻さない、PRD §10 決定#3)。アプリ終了で履歴は破棄される(非永続)
  - 受け入れ条件: スモークテストコマンドが exit 0 / `npm run test:run` で `historyStore` の追加/選択/破棄ロジックの純粋関数テストが pass
  - 対応 FR/NFR: FR-010

### Phase 16(Phase 4, 8, 9, 10, 14 完了後)
- [ ] T17 — セキュリティ・Capabilities 最終化(変更ファイル: src-tauri/capabilities/default.json, src-tauri/tauri.conf.json | 依存: T04, T08, T12, T15, T16)
  - 目的: `capabilities/default.json` に列挙された permission が、実際に使用するコマンド・プラグインの範囲に過不足なく限定されていることをレビューし、`tauri.conf.json` の `app.security.assetProtocol.scope` を一時キャプチャディレクトリ(`capture::tempfile` が使うサブディレクトリ)のみに限定する。CSP 最小設定(`default-src 'self'; img-src 'self' asset: data:`)の適用可否を判断する
  - 受け入れ条件: スモークテストコマンドが exit 0 / `capabilities/default.json` の permission 一覧と、各タスクが実際に呼ぶコマンド/プラグイン API の対応表を本ドキュメントまたは PR 説明に添付しレビューで確認する
  - 対応: ARCH §12(セキュリティ設計)

### Phase 17(全タスク完了後)
- [ ] T18 — 最終検証: NFR-001/NFR-002 実機確認 + 手動確認チェックリスト全項目実行(変更ファイル: testreport/ 配下に計測・確認結果ログ(新規) | 依存: T01〜T17 全て)
  - 目的: 実機 macOS で NFR-001(10 回試行の中央値 < 200ms)を最終計測(グローバルショートカット・トレイ経由も含む)し、NFR-002 の 3 点(①`screencapture` が起動しない②案内 UI 表示③システム設定アプリの該当画面が開く)を確認する。下記「手動確認チェックリスト」の全項目を実行し結果を記録する
  - 受け入れ条件: スモークテストコマンドが exit 0 / 手動確認チェックリスト全項目が実行され結果(pass/fail)が `testreport/` に記録されている / NFR-001 が未達の場合は ScreenCaptureKit 移行要否を human 判断事項として `output/tasks/PROGRESS.md` へ申し送る(PJM が追記)
  - 対応 FR/NFR: NFR-001(最終検証), NFR-002(最終検証)、PRD §8 手動確認項目全て

### Phase 18(追記。実績: T13 完了後・T17 着手前に人間フィードバックを受けて実施済み)

> T19 は当初のタスク分解(T01〜T18)には無く、T11 完了後の人間フィードバック(UI 見直し要望)を受けて
> Phase 5 期間中に追加実施された(`output/tasks/PROGRESS.md` 実行順: `…T12→T14→T13→T19→T17→T18`)。
> 本ドキュメントに未記載だったため、**完了済みタスクとして**ここに追記する(T01〜T18 の記述・Phase 番号は変更しない)。
> PRD §6「T19方針の維持」・§9.1〜9.2(UI設計方針)は T19 の成果を前提に改訂済み(2026-09-24)。

- [x] T19 — UI 見直し(「主役はキャプチャ画像、UIは脇役」への再設計)(変更ファイル: index.html, src/styles.css, src/ui/toolbar.ts, src/ui/captureButton.ts, src/ui/clipboardButton.ts, src/ui/permissionBanner.ts | 依存: T13)
  - 目的: 文言主体のボタン群を 1 本のアイコンツールバー(インライン SVG、意味は `aria-label`/`title` で保持)に再設計し、フィードバック表示をトースト化、画像未読込時の空状態に「⌘⇧2 でキャプチャ」を表示、アクセントカラーを既存の矢印色(`--arrow-color`)1 色に統一する。あわせて `[hidden] { display: none !important; }` を追加し、`hidden` 属性が他要素の `display` 宣言に上書きされて権限バナーが常時表示され続けるバグ(T13 の E2E で検出)を修正する
  - 受け入れ条件(状態: **完了・2026-09-24**): スモークテストコマンドが exit 0(vitest 128 / cargo test 60 / clippy 0 / e2e 2 passed) / before・after のスクリーンショットと所見を `output/reports/ui/UI_REVIEW_T19.md` に記録 / リポジトリ内に第三者製品名を含まないことを grep で確認済み。証跡: `output/reports/ui/UI_REVIEW_T19.md`, `output/reports/test/E2E_T13_capture-flow.md`(バナー修正後の再実行分)
  - 対応: PRD §6「T19方針の維持」、§9.1〜9.2(UI設計方針)。以降 T20〜T30(下記)で追加する色・フォントサイズ・取り消し/やり直しの各アイコンボタンは、本タスクが確立した「アイコン中心・説明文なし・グループ化」方針を踏襲すること(PRD §6【改訂 2026-09-24】T19方針の維持 参照)

## 依存関係グラフ

> ゲート3 決定(2026-09-23)により、T15・T16 を T07 の直後・T08 着手前に前倒しした。以前のドラフトでは
> T15/T16 を T06 から独立した並行枝として描いていたが、T16 の依存に T07 を追加したことで実行順・依存関係とも
> ほぼ完全な線形チェーンになった(枝分かれは T13/T14 のみ)。

```
T01→T02→T03→T04→T05→T06→T07→T15→T16→T08→T09→T10→T11→T12──┬──→T13──┐
                                                              └──→T14──┤
                                                                        ├──→T17→T18
              (T04, T08 も T07 以前/以後に完了済みのため T17 が参照) ────┘
```

- 実行順(T01〜T12・T15・T16)はほぼ完全に線形。`src/main.ts`(T07, T08, T09, T14 が共有)、`src-tauri/src/lib.rs`(T02, T06, T08, T12, T15, T16 が共有)、`capabilities/default.json`(T08, T12, T16, T17 が共有)のいずれかを多くのタスクが共有するため、変更ファイル重複により実質逐次にならざるを得ない
- T15(トレイ)は T06 完了後に着手可能。T16(グローバルショートカット)はゲート3 決定により **T07 にも依存を追加**(キャプチャ完了後にメインウィンドウを前面表示する挙動を T07 のフロントエンド連携と整合させるため)。`lib.rs` の `setup()` 内順序(ARCH §11「トレイ→ショートカット」)に合わせ T15→T16 の順で実装する
- T13, T14 のみ変更ファイルが完全に重複しない(package.json/playwright.config.ts/e2e/\*\* と src/history/\*\*・src/ui/sidebar.ts)。複数エージェント運用時はこの 2 タスクだけ並行着手可能
- T17(セキュリティ最終化)は T04, T08, T12, T15, T16 の全 permission 定義が出揃った後でないとレビューが不完全になるため、それらすべてに依存する(実行順ではすべて T17 より前に完了済み)
- T18(最終検証)は全タスクの成果物を対象とするため T01〜T17 全てに依存する

### タスク一覧(依存・並行化サマリー、実行順)

| タスク | 依存 | 主な変更ファイル(要約) | 並行可能な相手(ファイル重複なし) |
| ------ | ---- | ----------------------- | ---------------------------------- |
| T01 | なし | package.json, vite設定, src/test/ | — |
| T02 | T01 | error.rs, commands.rs, lib.rs, Cargo.toml | — |
| T03 | T02 | capture/mod.rs, capture/tempfile.rs | — |
| T04 | T03 | capture/permission.rs | — |
| T05 | T03, T04 | capture/screencapture.rs | — |
| T06 | T05 | commands.rs, lib.rs | — |
| T07 | T06 | ipc/capture.ts, canvas/*, ui/captureButton.ts, main.ts, index.html | — |
| T15 | T06 | tray.rs, lib.rs | — (lib.rs を T02/T06/T08/T12/T16 と共有) |
| T16 | T06, T15, T07 | shortcuts.rs, lib.rs, Cargo.toml, capabilities/default.json | — (lib.rs/capabilities を他タスクと共有) |
| T08 | T04, T07 | ipc/permissions.ts, ui/permissionBanner.ts, commands.rs, main.ts | — |
| T09 | T07 | canvas/tools/arrowTool.ts, ui/toolbar.ts, canvasState.ts, main.ts | — |
| T10 | T09 | canvas/tools/mosaicTool.ts, ui/toolbar.ts | — |
| T11 | T05, T06, T10 | capture/mod.rs(計測ログ), testreport/ | — |
| T12 | T07, T10 | ipc/clipboard.ts, clipboard/mod.rs, commands.rs, lib.rs, main.ts | — |
| T13 | T12 | package.json, playwright.config.ts, e2e/** | **T14** |
| T14 | T12 | history/historyStore.ts, ui/sidebar.ts, main.ts, canvasState.ts | **T13** |
| T17 | T04, T08, T12, T15, T16 | capabilities/default.json, tauri.conf.json | — |
| T18 | T01〜T17 全て | testreport/ | — |

並行可能候補は **T13 と T14 の 1 組のみ**(変更ファイルが完全に非重複)。それ以外は `src/main.ts` /
`src-tauri/src/lib.rs` / `src-tauri/capabilities/default.json` のいずれかを共有するため、
スキルの並行可能基準(変更ファイル重複なし)を満たさず逐次実装が必須(ゲート3 決定によりこれが正式な実行順)。

## テスト戦略

### ユニットテスト(Rust、`cargo test`)

- `capture::tempfile`: 一時ファイル名の一意性(T03)
- `capture::permission`: FFI 呼び出し関数のコンパイル・呼び出し可能性(T04。実際の許可状態は OS 依存のため自動テスト対象外)
- `capture::screencapture` / `capture::run()`: 権限未許可時に `screencapture` を起動しない分岐、Esc キャンセル時に `Cancelled`(エラー扱いしない)分岐(T05)
- `commands::capture_screen`: 戻り値・エラー変換(T06)
- `clipboard::write_image_fallback`: 入力バイト列の型検証(T12。実クリップボードへの書込は手動確認)

### ユニットテスト(TS、Vitest)

- `canvasState`: 画像セット・ツール状態更新の純粋関数(T07, T09)
- `arrowTool`: 矢印の座標計算(始点・終点から描画パラメータを導出)(T09)
- `mosaicTool`: ピクセル化アルゴリズム(Canvas 依存を最小化した純粋ロジック)(T10)
- `permissionBanner` / `permissions.ts`: 権限状態(未確認/許可/未許可)ごとの表示分岐(T08)
- `clipboard.ts`: プラグイン失敗時に Rust フォールバックへ切り替わる分岐(モック使用、T12)
- `historyStore`: 追加/選択/破棄ロジック(T14)

### 結合テスト(限定的 E2E、Playwright)

- 対象: ツール切替 → 矢印/モザイク付与 → クリップボードボタン押下までの UI フロー(T13、`window.__TAURI__` をモック)
- 対象外: `screencapture` の実起動、グローバルショートカット、トレイメニュー、画面収録権限ダイアログ(いずれも OS ネイティブ導線のため自動化しない。下記「手動確認チェックリスト」で実機確認する)

## 手動確認チェックリスト

> 実機 macOS でのみ確認できる項目。PRD §8・ARCH §10.1 の手動確認項目をタスク単位に対応付ける。
> 結果は `testreport/` に記録する(T18 で総合実行、個別タスク完了時に先行確認してもよい)。

| # | 確認項目 | 対応タスク | 対応 FR/NFR |
| - | -------- | ---------- | ------------ |
| 1 | 範囲指定/ウィンドウキャプチャが実際に `screencapture -i` を起動し、スペースキーでウィンドウ選択に切り替えられる | T05, T07 | FR-001, FR-002 |
| 2 | 画面収録権限を意図的に未許可にした状態で、①`screencapture -i` が起動しない②案内 UI が表示される③「システム設定を開く」ボタンで実際にシステム設定アプリの該当画面が開く | T04, T08 | NFR-002 |
| 3 | グローバルショートカット既定キー(候補 `Cmd+Shift+2`)が OS 標準・主要アプリと衝突しないこと。押下→キャプチャ起動→エディタウィンドウ前面表示 | T16 | FR-004 |
| 4 | トレイメニュー「キャプチャ」「エディタを開く」「終了」各項目の動作。メインウィンドウを閉じてもプロセスが継続し、メニューバー常駐とショートカットが有効なまま | T15, T16 | FR-009 |
| 5 | 実クリップボードへの貼付確認(他アプリへの実貼り付け) | T12 | FR-005 |
| 6 | NFR-001: 10 回試行の中央値計測(中間: モザイク実装後 / 最終: グローバルショートカット・トレイ経由含む) | T11(中間), T18(最終) | NFR-001 |
| 7 | Dock アイコンが非表示であること(メニューバーアイコンのみでアプリの存在が視認できること) | T15 | FR-009, ARCH §1.1 |

## ドキュメント更新計画

> `.claude/rules/document-management.md` により、`docs/docs/*.md` と `project-config.md` §2/§3 の一次更新責務は
> `/implementing-features` にある。本タスク分解(`/plan`)はこれらのファイルを変更しない。
> 以下は実装フェーズで反映されるべき内容の申し送りであり、各タスクの実装時に該当スキルが更新する。

### project-config.md

- §2(技術スタック): T01(Vitest)、T02(thiserror)、T12(arboard, `tauri-plugin-clipboard-manager`)、T13(Playwright)、T16(`tauri-plugin-global-shortcut`)で追加した依存を反映
- §3(コマンド): `npm run test` / `npm run test:run` / `npm run e2e`、`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`(ゲート3 決定)を反映
- §11(既知の落とし穴): T05 実装時に「一時キャプチャファイルは自動クリーンアップしない(ARCH §12、MVP は要件外)」を追記

### docs/docs/*.md

- `docs/docs/project.md`: ルーティング(単一画面 `/`)、ストア一覧(`canvasState` / `historyStore` / `permissionState`)、コマンド一覧、技術スタックを ARCH §2・§8・§6 から転記
- `docs/docs/architecture.md`: ディレクトリ構成(ARCH §4 準拠の実装後構成)、テスト一覧(§テスト戦略の内容)を反映
- `docs/docs/data-model.md`: `Capture` / `HistoryItem` の型定義(PRD §5)を反映
- `docs/docs/development-patterns.md`: CoreGraphics FFI の取り扱い、`screencapture` の macOS バージョン差異、一時ファイル未クリーンアップ等の落とし穴を追記

## リスク・懸念事項

| リスク | 影響度 | 対策 |
| ------ | ------ | ---- |
| `src/main.ts` / `src-tauri/src/lib.rs` / `capabilities/default.json` が複数タスク(main.ts: T07,T08,T09,T14 / lib.rs: T02,T06,T08,T12,T15,T16 / capabilities: T08,T12,T16,T17)にまたがる「ホットスポットファイル」になっている。ゲート3 決定で T15・T16 を T07 の直後(T08 着手前)に前倒ししたため、`lib.rs` は T07 完了直後から T15→T16→T08 と 3 タスク連続で編集されることになる | 中 | 実行順(§タスク分解【実行順】)を厳守する。並行実装する場合は当該ファイルの担当を 1 タスクに限定し、他タスクは差分をレビューで確認してから着手する |
| `screencapture` CLI は macOS のバージョンアップで挙動が変わる可能性がある(PRD §11 継承) | 中 | T18 で主要 macOS バージョンでの動作確認を行う。NFR-001 未達なら T11/T18 の判断ポイントで ScreenCaptureKit 移行を検討する |
| CoreGraphics FFI(T04)がリンクエラーやクラッシュを起こすリスク(第三者プラグインを使わない自前実装のため) | 中 | `unsafe` ブロックと呼び出し関数を最小限(2 関数)に絞る(ARCH §15 決定#1 済み)。T04 完了時にコードレビュー(`/code-review`)で重点確認する |
| `arboard`(T12)のクリップボード書込みが環境によって失敗する可能性(PRD §11 継承) | 中 | T12 の受け入れ条件にフォールバック分岐のユニットテストを含める。実クリップボード確認は手動確認チェックリスト#5 |
| グローバルショートカット既定キー(候補 `Cmd+Shift+2`)が他アプリと衝突する可能性(PRD §11 継承) | 中 | T16 の手動確認チェックリスト#3 で確認。衝突時はコード側の既定値を変更(キー変更 UI は追加しない、MVP 外) |
| NFR-001(200ms 未満)が未達の場合、T11(中間)・T18(最終)の判断ポイントで ScreenCaptureKit 移行が必要になり、追加タスク(`CaptureProvider` の新実装)が発生する可能性 | 中 | `CaptureProvider` trait 抽象化(T03)により移行時の変更範囲は `capture/` 配下の新実装追加に限定される設計(ARCH §16) |
| Vitest / Playwright / thiserror / arboard の追加により依存数が増え、NFR-003(軽量性)との整合が問われる可能性 | 低 | いずれも開発時依存(devDependencies)または単機能の軽量クレートに限定。T01, T13 完了時に `project-config.md` §2 反映と合わせてレビューする |

## 要確認事項(決定済み)

> ゲート3(2026-09-23、人間決定)によりすべて決定済み。未解決の項目はない。
> PRD/ARCH で既に決定済みの事項(既定ショートカットキーの確定方法、モザイクのみ実装、履歴の永続化方針、
> ScreenCaptureKit 移行判断の枠組み等)は蒸し返していない。以下はタスク分解時に新たに生じた、
> PRD/ARCH が明示的に「実装フェーズ以降に委ねる」としていた 2 点。

| # | 項目 | 選択肢 | 推奨案 | 決定(2026-09-23) |
| - | ---- | ------ | ------ | ----------------- |
| 1 | Lint/静的解析の導入可否(PRD/ARCH ともにリンター選定の記載なし。`project-config.md` §3 テンプレートには `lint` スクリプトの例があるが未確定) | A案: MVP では専用リンターを導入しない(TS は `tsc --strict` の型検査、Rust は開発者が任意で `cargo clippy` を手元実行する運用に留める)／B案: ESLint(TS)・`cargo clippy`(Rust)を追加導入するタスクをタスク分解に加える | A案を推奨 | **A案採用(推奨どおり)**。ESLint 等の専用 TS リンターは導入しない。ただし `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` をスモークテストコマンドの末尾に追加し(§要件サマリー参照)、T01 の受け入れ条件に既存コードの clippy 警告解消を明記した |
| 2 | CI ワークフロー(GitHub Actions)をこのタスク分解の対象に含めるか(ARCH §13.3 は「CI導入は実装フェーズ以降に委ねる」と明記。`.github/workflows/` には未有効化のテンプレートのみ存在) | A案: MVP のタスク分解には含めない(スモークテストコマンドをローカルで各タスク完了時に手動実行する運用)／B案: push 時にスモークテストコマンドを実行する最小 CI ワークフローを追加するタスクを加える | A案を推奨 | **A案採用(推奨どおり)**。CI ワークフローは作成しない。T19/T20 は追加しない |

上記 2 件はゲート3 で確定したため、本ドキュメントに残タスクは無い。実行順の前倒し(T15・T16 を T07 直後へ)も
同ゲートで決定済み(§タスク分解【実行順】、§依存関係グラフ 参照)。

---

## 追加タスク: T20 以降(改訂 2026-09-24 — テーパー矢印・矩形・円・テキスト・色一括指定・取り消し/やり直し)

> 生成元: `output/prd/PRD_tadcap_mvp.md`(FR-006 改訂、FR-007、FR-011〜FR-014、§10 決定#9〜12、決定反映 2026-09-24)、
> `output/design/ARCH_tadcap_mvp.md`(§5・§6・§7、2026-09-24 改訂)。
> 前提: T01〜T19(上記)がすべて完了済み。既存タスクの定義・実行順・依存関係グラフ・要確認事項は変更しない。
> 以下は追記分のみ(T20〜T30)。実装モードは既存同様、逐次(1 セッション1タスク)を基本とするが、
> T20〜T23 の 4 タスクは変更ファイルが完全に非重複のため並行着手できる(下記【依存関係と並行化可能性】参照)。
>
> **推奨実行順**: T20→T21→T22→T23(Phase A、並行可)→T24→T25→T26→T27→T28→T29→T30

### 要件サマリー(追加分)

- [ ] 矢印(FR-006)が、始点から終点に向かって徐々に太くなるテーパー形状(矢じり付き)で焼き込まれる。終点側の太さ・矢じり寸法の算出基準(Canvas対角線基準・クランプ)は変更しない
- [ ] 矩形枠(FR-007)・円(楕円)枠(FR-011)が、ドラッグした範囲に塗りつぶしなしの枠線として焼き込まれる
- [ ] テキスト(FR-012)が、Canvasクリック位置のDOM入力欄経由で、単一行・IME対応で入力でき、Enter/blurで確定・Escでキャンセルできる
- [ ] 色の一括指定(FR-013)により、矢印・矩形・円・テキストの描画色を6色のプリセットまたはmacOS標準カラーピッカーから選べ、以後の描画にのみ反映される
- [ ] 取り消し(Undo、FR-014)・やり直し(Redo、FR-014・§10決定#9)が `Cmd+Z`/`Cmd+Shift+Z` とツールバーのアイコンボタンから実行でき、変更矩形のみを保持する差分方式・上限30件で動作する
- [ ] 新規Capture読込・履歴項目切替時にUndo/Redo両スタックがクリアされ、取り消し対象が常に「現在表示中の画像」に限定される
- [ ] 各タスクの受け入れ条件は、下記【スモークテストコマンド(T20以降)】の exit 0 を含む

### スモークテストコマンド(T20 以降)

```bash
. "$HOME/.cargo/env" && npm run build && npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings && npm run e2e
```

T01〜T19 時点の【スモークテストコマンド】(§要件サマリー冒頭)に対し、`. "$HOME/.cargo/env" &&` の前置(Bashでcargoにパスを通す。`output/tasks/PROGRESS.md` §1の既知の落とし穴と同じ対応)と、`&& npm run e2e`(T13で導入済みのPlaywright結合テストを毎タスク回帰確認する)が追加されている。T20〜T30の各タスクの受け入れ条件はこのコマンドのexit 0を指す。

### 影響調査(追加分)

| カテゴリ | ファイル | 変更内容 |
| --- | --- | --- |
| ユーティリティ | `src/canvas/coords.ts` | 移動(`mosaicTool.ts` から `Rect`/`normalizeRect()`/`clipRectToCanvas()` を移設・共通化) |
| ストア | `src/canvas/toolSettings.ts` | 追加(`color`/`fontSize` の現在値、購読機構) |
| ストア | `src/canvas/undoStack.ts` | 追加(Undo/Redoスタック、差分方式、上限30件) |
| ユーティリティ | `src/ui/shortcutGuards.ts` | 追加(`clipboardButton.ts` から `isEditableTarget()` を抽出・共通化) |
| コンポーネント | `src/canvas/tools/arrowTool.ts` | 変更(テーパー多角形描画へ改訂、`toolSettings`/`undoStack` 連携) |
| コンポーネント | `src/canvas/tools/rectangleTool.ts` | 追加(矩形枠描画) |
| コンポーネント | `src/canvas/tools/ellipseTool.ts` | 追加(円(楕円)枠描画) |
| コンポーネント | `src/canvas/tools/textTool.ts` | 追加(DOM入力オーバーレイ→Canvas焼き込み) |
| コンポーネント | `src/ui/toolbar.ts` | 変更(矩形/円/テキストのツール定義を追加) |
| コンポーネント | `src/ui/colorPicker.ts` | 追加(6色プリセット+ネイティブカラーピッカー) |
| コンポーネント | `src/ui/fontSizePicker.ts` | 追加(小・中・大の3段階切替) |
| コンポーネント | `src/ui/undoButton.ts` | 追加(取り消し/やり直しボタン + `Cmd+Z`/`Cmd+Shift+Z`) |
| ページ | `src/main.ts` | 変更(新規ツールの `bind*Tool()` 呼び出し、色/フォントサイズ/Undo系UIの初期化、Undo/Redoクリア呼び出し追加) |
| ページ | `index.html` | 変更(色・フォントサイズ・取り消し/やり直しのマウント要素を追加) |
| ページ | `src/styles.css` | 変更(テキスト入力オーバーレイ・色見本・フォントサイズボタンのスタイル追加。T19のアイコン中心方針を踏襲) |
| テスト | `e2e/annotation-tools.spec.ts` | 追加(矩形/円/テキスト/色/取り消し・やり直しのUIフロー) |

### タスク分解(T20〜T30)

> Phase(A〜D)は「変更ファイルが重複しないタスク群」の識別。数字Phase(1〜18、T01〜T19)と混同しないようA〜Dの記号を用いる。

#### Phase A(並行可能・共通基盤。T20〜T23は変更ファイルが完全に非重複)

- [ ] T20 — 共有ジオメトリ関数を coords.ts へ移設(変更ファイル: src/canvas/coords.ts, src/canvas/coords.test.ts, src/canvas/tools/mosaicTool.ts, src/canvas/tools/mosaicTool.test.ts | 依存: なし)
  - 目的: `mosaicTool.ts` が保持している `Rect` 型・`normalizeRect()`・`clipRectToCanvas()` を `coords.ts` へ移設し、矩形・円ツール(T25・T26)が同じ純粋関数を再利用できるようにする(ARCH §5.1改訂、振る舞いは変更しないリファクタ)。`mosaicTool.ts` は移設後の関数を `coords.ts` からimportし直す
  - 受け入れ条件: スモークテストコマンド(T20以降)が exit 0 / 既存の `normalizeRect`/`clipRectToCanvas` のユニットテストケースを `coords.test.ts` へ移設しすべて pass / `mosaicTool.ts` から `Rect`/`normalizeRect`/`clipRectToCanvas` の定義本体が削除されていること(grepで重複定義が無いことを確認)
  - 対応 FR/NFR: FR-007, FR-011(基盤)

- [ ] T21 — toolSettings ストア新設(色・フォントサイズ)(変更ファイル: src/canvas/toolSettings.ts(新規), src/canvas/toolSettings.test.ts(新規) | 依存: なし)
  - 目的: 矢印・矩形・円・テキスト共通の現在色(既定 `#FF5C8A`)と、テキストのフォントサイズ段階(`"small" | "medium" | "large"`、既定値は実装時に確定)を保持する薄いストアを実装する(ARCH §5.1・§6.1)。`getToolSettings()`/`setColor()`/`setFontSize()`/`subscribeToolSettings()` を提供。色コード(`#RRGGBB`)の妥当性判定を純粋関数として実装する(PRD §8【新設2026-09-24】テスト対象)
  - 受け入れ条件: スモークテストコマンド(T20以降)が exit 0 / 新規テストが pass(初期値が色`#FF5C8A`・フォントサイズ既定値であること、`setColor()`/`setFontSize()`後に購読者へ通知されること、不正な色コード文字列の判定関数のtrue/false)
  - 対応 FR/NFR: FR-013(基盤)

- [ ] T22 — shortcutGuards.ts 抽出(isEditableTarget共通化)(変更ファイル: src/ui/shortcutGuards.ts(新規), src/ui/shortcutGuards.test.ts(新規), src/ui/clipboardButton.ts, src/ui/clipboardButton.test.ts | 依存: なし)
  - 目的: `clipboardButton.ts` 内の `isEditableTarget()` を `shortcutGuards.ts` へ抽出し、T29(取り消し/やり直しボタン)・T27(テキストツール)が同じ判定を再利用できるようにする(ARCH §5.1改訂「`clipboardButton.ts`から抽出」)。振る舞いは変更しない。`clipboardButton.ts` は抽出後の関数を再import する
  - 受け入れ条件: スモークテストコマンド(T20以降)が exit 0 / 既存 `clipboardButton.test.ts` が全て pass(importの向き先変更のみ、判定ロジック自体のテストは `shortcutGuards.test.ts` へ移設) / `clipboardButton.ts` から `isEditableTarget()` の定義本体が削除されていること
  - 対応 FR/NFR: FR-012, FR-014(基盤)

- [ ] T23 — Undo/Redoスタック(undoStack.ts)(変更ファイル: src/canvas/undoStack.ts(新規), src/canvas/undoStack.test.ts(新規) | 依存: なし)
  - 目的: 焼き込み操作の差分(変更矩形+焼き込み前ピクセル)を保持するUndoスタックと、対称のRedoスタックを実装する(ARCH §6.4差分方式、PRD §10決定#9でRedoを追加)。`pushUndoStep(rect, before)`: Undoスタックへpushし、Redoスタックをクリアする。`popUndo()`: Undoスタックから取り出しRedoスタックへ積んで返す。`popRedo()`: Redoスタックから取り出しUndoスタックへ戻して返す。`canUndo()`/`canRedo()`。上限30件(超過時は最も古いものから破棄、PRD §11リスク)。`clearUndoStack()`はUndo・Redo両方を空にする
  - 画像差し替え時の扱い(明記): `clearUndoStack()` は新規Capture読込(`main.ts::handleCaptureCompleted`)・履歴項目再読込(`reloadHistoryItemIntoCanvas`)の**完了後**に呼ぶ想定であり、取り消し対象を常に「現在表示中の画像」に限定する(PRD §5)。これはF1で導入された `isSameCanvasImage()` によるドラッグ中断(ドラッグ**途中**の非同期差し替えを検知して焼き込み自体を中断する仕組み、`arrowTool.ts` 等)とは別レイヤーの処理であり、両者は併用する: ドラッグ中の差し替えは中断されるためUndoStepは積まれず、差し替えが完了した後に次に`pushUndoStep()`されるのは新しい画像を前提としたエントリになる
  - 受け入れ条件: スモークテストコマンド(T20以降)が exit 0 / 新規テストが pass(push/popの対応関係、上限30件超過時に最古のエントリが破棄されること、`popUndo()`後に`pushUndoStep()`(新規描画)するとRedoスタックがクリアされること、`clearUndoStack()`でUndo/Redo双方が空になり`canUndo()`/`canRedo()`が`false`を返すこと)
  - 対応 FR/NFR: FR-014

#### Phase B(Phase A 完了後)

- [ ] T24 — テーパー矢印(既存 arrowTool の改修)(変更ファイル: src/canvas/tools/arrowTool.ts, src/canvas/tools/arrowTool.test.ts | 依存: T21, T23)
  - 目的: 矢印の描画を、既存の「線(stroke)+矢じり(fill)」から、始点から終点に向かって徐々に太くなる単一多角形の塗りつぶし(`computeTaperArrowPolygon()`)へ改訂する(PRD FR-006改訂、ARCH §5.2)。終点側の太さ・矢じり寸法は既存 `arrowLineWidth()`/`arrowHeadLength()` をそのまま使用し(算出基準は変更しない、PRD決定#1継承)、始点側の太さは終点側に対する比率定数(実装時確定)とし常に終点以下になるようクランプする。多角形の頂点は (a)始点の左右2点、(b)矢じり基部(終点から`headLength`手前)の左右2点、(c)既存 `computeArrowGeometry()` と同じ矢じり3点(tip/left/right)の順に並べ `ctx.fill()` で塗る。色は `--arrow-color` のCSS変数直読みから `toolSettings.getToolSettings().color` の参照に置き換える(UIアクセント色としてのCSS変数自体はT19の方針どおり維持し、注釈の「現在色」は`toolSettings`を単一の真実源にする、ARCH §5.2)。確定時(`finishDrag`)に、ドラッグ開始時取得済みの`snapshot`から矢印の外接矩形分を切り出し `undoStack.pushUndoStep(rect, before)` を呼んでから焼き込む。既存の「pointerdownスナップショット→pointermoveプレビュー→pointerup焼き込み」パターンと、`imageAtDragStart`+`isSameCanvasImage()`によるドラッグ中断パターン(MUST-1、レビュー2026-09-24)はそのまま維持する
  - 受け入れ条件: スモークテストコマンド(T20以降)が exit 0 / `arrowTool.test.ts` に `computeTaperArrowPolygon()` の頂点算出テストを追加しpass(始点側太さが終点側太さ以下であること、矢じり3点が既存`computeArrowGeometry()`と同じ算出になること、ドラッグ距離が`MIN_DRAG_DISTANCE`未満で`null`を返すこと)
  - 対応 FR/NFR: FR-006, FR-013(色参照), FR-014(undo連携)

- [ ] T25 — 矩形枠ツール(変更ファイル: src/canvas/tools/rectangleTool.ts(新規), src/canvas/tools/rectangleTool.test.ts(新規), src/ui/toolbar.ts, src/main.ts | 依存: T20, T21, T23)
  - 目的: ドラッグした範囲に、塗りつぶしなしの矩形枠線を焼き込むツールを実装する(FR-007)。`coords.ts`(T20で移設済み)の`normalizeRect()`/`clipRectToCanvas()`を再利用して選択矩形を算出する。枠線の太さはCanvas対角線基準の決定論的算出+クランプ(矢印`arrowLineWidth()`と同じ考え方だがローカル定数、ARCH §5.2「太さの比率は視覚調整のためツールごとに異なってよい」)。色は`toolSettings.getToolSettings().color`から読み取る。**新ドラッグ系ツールとして、既存の「pointerdownでCanvas全体のImageDataをスナップショット取得→pointermoveでスナップショットへ復元しつつプレビュー枠線を描く→pointerupで最終図形を確定焼き込み」というドラッグパターンをそのまま踏襲し、`imageAtDragStart`+`isSameCanvasImage()`によるドラッグ中断パターン(MUST-1)も同様に実装すること**(`arrowTool.ts`/`mosaicTool.ts`を参照実装とする)。確定時に変更矩形分を`undoStack.pushUndoStep()`へpushしてから焼き込む。`toolbar.ts`の`TOOLS`配列に矩形を追加し、`main.ts`で`bindRectangleTool(canvasEl)`を呼ぶ
  - 受け入れ条件: スモークテストコマンド(T20以降)が exit 0 / `rectangleTool.test.ts` に枠線太さ算出関数のテスト(Canvas対角線からのクランプ、矩形サイズに依存しないこと)を追加しpass
  - 対応 FR/NFR: FR-007

- [ ] T26 — 円(楕円)枠ツール(変更ファイル: src/canvas/tools/ellipseTool.ts(新規), src/canvas/tools/ellipseTool.test.ts(新規), src/ui/toolbar.ts, src/main.ts | 依存: T20, T21, T23, T25(`toolbar.ts`/`main.ts`をT25と共有するため))
  - 目的: ドラッグした範囲を外接矩形とする楕円(正円に限定しない)の枠線を焼き込むツールを実装する(FR-011)。枠線の太さはT25(矩形枠)と同じ考え方の算出ロジックを本ファイル内にローカルな定数として持つ(共通モジュールへは強制集約しない、ARCH §5.2)。色は`toolSettings.getToolSettings().color`。T25と同じ「pointerdownスナップショット→pointermoveプレビュー→pointerup焼き込み」パターン、`imageAtDragStart`+`isSameCanvasImage()`中断パターンを踏襲する。確定時に変更矩形分を`undoStack.pushUndoStep()`へpush。`toolbar.ts`の`TOOLS`配列に円を追加し、`main.ts`で`bindEllipseTool(canvasEl)`を呼ぶ
  - 受け入れ条件: スモークテストコマンド(T20以降)が exit 0 / `ellipseTool.test.ts` に外接矩形→中心・X半径・Y半径を算出する純粋関数のテストを追加しpass
  - 対応 FR/NFR: FR-011

- [ ] T27 — テキストツール(変更ファイル: src/canvas/tools/textTool.ts(新規), src/canvas/tools/textTool.test.ts(新規), src/ui/toolbar.ts, src/main.ts, src/styles.css | 依存: T20, T21, T22, T23, T26(`toolbar.ts`/`main.ts`をT26と共有するため))
  - 目的: Canvasクリック位置にDOMオーバーレイ(絶対配置`<input>`要素)を表示し、日本語IMEに対応したテキスト入力を受け付ける(FR-012)。**単一行のみとし、複数行(改行)入力は提供しない(PRD §10決定#10、A案)**。確定は`Enter`(変換中を除く。`event.isComposing`で判定)またはフォーカスアウト(blur)。`Esc`でキャンセル(何も焼き込まない)。空文字列のまま確定・キャンセルした場合も何も焼き込まない。フォントサイズは`toolSettings.getToolSettings().fontSize`(小・中・大)から`computeFontSizePx()`で実寸pxを決定論的に算出する(係数は実装時確定、PRD §10決定#12)。色は`toolSettings.getToolSettings().color`。テキスト入力欄が表示されている間は`shortcutGuards.ts::isEditableTarget()`により`Cmd+C`/`Cmd+Z`/`Cmd+Shift+Z`等のアプリショートカットを奪わない(T22で共通化済みの判定を利用)。オーバーレイ表示中にCanvasの画像が非同期に差し替えられた場合(新規キャプチャ完了・履歴再読込)は、`isSameCanvasImage()`で検知しオーバーレイを破棄・焼き込みしない(ドラッグ系ツールのMUST-1と同じ防御をクリック起点のテキストツールにも適用する)。確定直前に`ctx.measureText()`で焼き込み矩形を算出し、その領域を`getImageData()`で取得してから`undoStack.pushUndoStep()`し、`ctx.fillText()`で焼き込む。`toolbar.ts`の`TOOLS`配列にテキストを追加し、`main.ts`で`bindTextTool(canvasEl)`を呼ぶ
  - 受け入れ条件: スモークテストコマンド(T20以降)が exit 0 / `textTool.test.ts` に `computeFontSizePx()` の3段階算出テスト、空文字列判定・IME変換中判定(`event.isComposing`相当の入力を渡すラッパー関数)の純粋関数テストを追加しpass
  - 対応 FR/NFR: FR-012

#### Phase C(Phase B 完了後)

- [ ] T28 — 色・フォントサイズ選択UI(ツールバー拡張)(変更ファイル: src/ui/colorPicker.ts(新規), src/ui/colorPicker.test.ts(新規), src/ui/fontSizePicker.ts(新規), src/ui/fontSizePicker.test.ts(新規), index.html, src/main.ts, src/styles.css | 依存: T21, T27(`main.ts`/`styles.css`をT27と共有するため))
  - 目的: プリセット色見本(6色: ピンク`#FF5C8A`既定・赤・橙・黄・緑・青。ピンク以外の正確な配色コードは実装フェーズで確定、PRD §10決定#11)+ macOS標準カラーピッカー(`<input type="color">`)のUIを実装し(`colorPicker.ts`)、選択結果を`toolSettings.setColor()`へ反映する。フォントサイズ小・中・大の3段階をアイコンボタン群として実装し(`fontSizePicker.ts`)、`toolSettings.setFontSize()`へ反映する。いずれもT19の「アイコン中心・説明文なし、意味は`aria-label`/`title`で保持」方針を踏襲する(PRD §6「T19方針の維持」)。フォントサイズUIはテキストツール専用設定だが常時表示・常時操作可能とする(他ツール選択中の変更も副作用なし、PRD §6)
  - 受け入れ条件: スモークテストコマンド(T20以降)が exit 0 / DOM非依存の純粋関数部分(色プリセット定義からの選択インデックス→色コード変換等、`toolSettings.ts`の色コードバリデーションと重複させない)のテストがpass / 手動確認チェックリスト(下記追加分#2)にmacOS標準カラーピッカーの起動・選択・反映を追加
  - 対応 FR/NFR: FR-013

- [ ] T29 — 取り消し/やり直しボタン+ショートカット結線(変更ファイル: src/ui/undoButton.ts(新規), src/ui/undoButton.test.ts(新規), index.html, src/main.ts | 依存: T22, T23, T24, T25, T26, T27, T28(`main.ts`/`index.html`をT28と共有するため。全ツールが`undoStack.pushUndoStep()`を呼ぶようになった後でないと取り消し対象が揃わない))
  - 目的: `undoStack.popUndo()`/`popRedo()`で取り出した`{rect, before}`を`ctx.putImageData(before, rect.x, rect.y)`で書き戻す実行ロジックと、`Cmd+Z`/`Cmd+Shift+Z`のキー結線、ツールバーのアイコンボタン(取り消し不可/やり直し不可時は無効表示、`canUndo()`/`canRedo()`を購読)を実装する(FR-014)。`shortcutGuards.ts::isEditableTarget()`でテキスト入力欄フォーカス中はどちらも発火しない。ドラッグ中(`canvasState.isDrawing === true`)は無視する(既存ツールバーボタンと同じ無効化条件)。`main.ts::handleCaptureCompleted`(新規Capture読込)・`reloadHistoryItemIntoCanvas`(履歴項目再読込)の末尾で`undoStack.clearUndoStack()`を呼ぶ(T23で明記した画像差し替え時の扱いを実装する。取り消し対象を常に「現在表示中の画像」に限定するため)
  - 受け入れ条件: スモークテストコマンド(T20以降)が exit 0 / `undoButton.test.ts` に `Cmd+Z`/`Cmd+Shift+Z`の判定関数、`isEditableTarget()`中は発火しない判定、`isDrawing`中は発火しない判定のテストを追加しpass / 手動確認チェックリスト(下記追加分#1)に複数回焼き込み後の連続Undo/Redo確認を追加
  - 対応 FR/NFR: FR-014

#### Phase D(Phase C 完了後)

- [ ] T30 — E2E追加(新規ツール・色・取り消し/やり直しのUIフロー)(変更ファイル: e2e/annotation-tools.spec.ts(新規)、e2e/fixtures/tauriMock.ts(必要な場合のみ変更) | 依存: T24, T25, T26, T27, T28, T29)
  - 目的: Playwright結合テスト(`window.__TAURI__`モック)で、①矩形/円/テキストツールでの描画→色・フォントサイズ変更が以後の描画にのみ反映されること(FR-007, FR-011, FR-012, FR-013)、②複数回の焼き込み後に`Cmd+Z`を連続実行して1操作ずつ元に戻り、`Cmd+Shift+Z`で再度やり直せること(FR-014)、をカバーする結合テストを追加する(PRD §8【新設2026-09-24】E2E対象)。既存`e2e/capture-flow.spec.ts`・`e2e/capture-race.spec.ts`は変更せず回帰確認のみ行う
  - 受け入れ条件: `npm run e2e` が exit 0(新規spec含む) / 既存e2e specも回帰でpass / スモークテストコマンド(T20以降)全体もexit 0
  - 対応 FR/NFR: FR-006, FR-007, FR-011, FR-012, FR-013, FR-014(E2E検証)、PRD §8【新設2026-09-24】

- [ ] T31 — 直前に描いた図形の編集(リサイズ・移動)+ 矢印 1.5 倍(2026-09-24 人間要望で追加。T27 より先に実施)(変更ファイル: src/canvas/tools/arrowTool.ts, rectangleTool.ts, ellipseTool.ts, 新規 src/canvas/pendingShape.ts(仮), src/main.ts, src/ui/clipboardButton.ts ほか | 依存: T24, T25, T26)
  - 目的: 矢印・矩形・円は pointerup で即焼き込みせず「編集中の図形」として保持し、ハンドル(矩形・円は四隅、矢印は始点・終点)でリサイズ、内側(矢印は胴体)ドラッグで移動できるようにする。編集できるのは直前の 1 つだけ。次の図形を描く・ツール切替・モザイク・クリップボードコピー・履歴切替/新規キャプチャ・Enter/Esc・画像外クリックで確定し、確定時に `pushUndoStep` → 焼き込み。ハンドルは焼き込まれない(オーバーレイで描画)。あわせて矢印の終点胴幅・矢じり・影を現行の 1.5 倍に
  - 受け入れ条件: スモーク exit 0 / 編集中図形の状態遷移(作成→リサイズ→移動→確定、確定トリガー各種、画像差し替えで破棄 or 確定)の純粋関数テスト / コピー結果にハンドルが写らない・編集中の図形は確定されてから写ることの E2E / 取り消しは確定済みの操作単位
  - 対応 FR: FR-006, FR-007, FR-011(改訂)、FR-014

- [ ] T32 — オブジェクト層の基盤(2026-09-24 人間要望: 確定後も再調整)(依存: T31)
  - 目的: 矢印・矩形・円を焼き込まず「オブジェクト」として保持(1 画像 50 個、超過分は古い順に元画像へ焼き込み固定)。描画 = 元画像(モザイク等のピクセル加工を含む)+ オブジェクトを重ね順に描画。クリックで選択 → ハンドルで移動・リサイズ。取り消し/やり直しをオブジェクト操作(追加・変更・削除)とモザイク(ピクセル)のコマンドに再設計。コピーは合成結果を出力(ハンドル無し)。PRD/ARCH を改訂
- [ ] T33 — テキストのオブジェクト化(依存: T32)
  - 目的: テキストもオブジェクトに。選択・移動、ダブルクリックで文字の再編集(IME 対応は既存どおり)
- [ ] T34 — 選択中の操作と履歴ごとの保持(依存: T32, T33)
  - 目的: Delete/Backspace で削除、色の変更、テキストの文字サイズ変更、前面/背面へ移動。履歴ごとに元画像+オブジェクト一覧を保持し、切り替えて戻っても再調整可(サムネイルは合成結果)。E2E 追加

### 依存関係グラフ(追加分)

```
T20 ──┐
T21 ──┼─→ T24 ──┐
T22 ──┤         │
T23 ──┘         ├─→ T25 → T26 → T27 → T28 → T29 → T30
                 └───────────────────────────────┘
```

- T20・T21・T22・T23 は変更ファイルが完全に非重複のため並行着手可能(Phase A)
- T24(テーパー矢印)はT21・T23のみに依存し、T20・T22には依存しない(矢印は`Rect`型もeditable target判定も使わない)。ファイル(`arrowTool.ts`)もT25以降と重複しないため、実際にはT25と並行着手も可能(下記【依存関係と並行化可能性】参照)。推奨順としては先にT24で「既存ツールへtoolSettings/undoStackを組み込む」パターンを確立してからT25以降の新規ツールに展開する
- T25〜T29は`src/ui/toolbar.ts`・`src/main.ts`・`index.html`・`src/styles.css`のいずれかを共有するため実質逐次(既存T01〜T18の`main.ts`/`lib.rs`ホットスポット問題と同種)
- T30はT24〜T29全ての成果物(全新規ツール+色/フォントサイズUI+Undo/Redo)を対象とするため、それらすべてに依存する

### 依存関係と並行化可能性(変更ファイル重複)の表

| タスク | 依存 | 主な変更ファイル(要約) | 並行可能な相手(ファイル重複なし) |
| ------ | ---- | ----------------------- | ---------------------------------- |
| T20 | なし | coords.ts, mosaicTool.ts | **T21, T22, T23**(+ T24: ファイル非重複だがT21/T23の完了を待つ) |
| T21 | なし | toolSettings.ts | **T20, T22, T23** |
| T22 | なし | shortcutGuards.ts, clipboardButton.ts | **T20, T21, T23** |
| T23 | なし | undoStack.ts | **T20, T21, T22** |
| T24 | T21, T23 | arrowTool.ts | **T25**(ファイル非重複。ただしT25の依存(T20)を満たす必要あり) |
| T25 | T20, T21, T23 | rectangleTool.ts, toolbar.ts, main.ts | **T24**(上記参照) |
| T26 | T20, T21, T23, T25 | ellipseTool.ts, toolbar.ts, main.ts | — (toolbar.ts/main.tsをT25/T27と共有) |
| T27 | T20, T21, T22, T23, T26 | textTool.ts, toolbar.ts, main.ts, styles.css | — (toolbar.ts/main.ts/styles.cssを他タスクと共有) |
| T28 | T21, T27 | colorPicker.ts, fontSizePicker.ts, index.html, main.ts, styles.css | — (main.ts/styles.cssを他タスクと共有) |
| T29 | T22, T23, T24, T25, T26, T27, T28 | undoButton.ts, index.html, main.ts | — (main.tsを他タスクと共有) |
| T30 | T24〜T29 全て | e2e/annotation-tools.spec.ts | — |

並行可能候補は **T20・T21・T22・T23 の4タスク組(Phase A)** が中心(変更ファイルが完全に非重複)。
T24とT25も変更ファイルは非重複だが、T25はT20にも依存するためT20完了が前提。T26以降は`toolbar.ts`/`main.ts`/
`index.html`/`styles.css`のいずれかを共有し合うため、既存T01〜T18と同様の理由でほぼ逐次にならざるを得ない
(複数エージェント運用時でもPhase Aの4タスクを並行させるのが最も効果が大きい)。

### テスト戦略(追加分)

#### ユニットテスト(TS、Vitest)

- `coords`: `normalizeRect`/`clipRectToCanvas`(移設後、T20)
- `toolSettings`: 色コードバリデーション、初期値、購読通知(T21)
- `shortcutGuards`: `isEditableTarget`(抽出後、T22)
- `undoStack`: push/pop対称性、上限30件、Redoクリア条件、`clearUndoStack`(T23)
- `arrowTool`: `computeTaperArrowPolygon`の頂点算出(始点/終点太さ・矢じり)(T24)
- `rectangleTool`/`ellipseTool`: 枠線太さ算出、楕円の中心・半径算出(T25, T26)
- `textTool`: `computeFontSizePx`の3段階算出、IME変換中判定・空文字列判定(T27)
- `colorPicker`/`fontSizePicker`: DOM非依存部分のみ(T28)
- `undoButton`: `Cmd+Z`/`Cmd+Shift+Z`判定、editable/isDrawingガード(T29)

#### 結合テスト(限定的E2E、Playwright)

- 対象(追加): 矩形/円/テキストの描画→色・フォントサイズ変更の反映範囲、複数回焼き込み後のUndo/Redo連続実行(T30)
- 対象外(既存同様): `screencapture`の実起動、グローバルショートカット、トレイメニュー、画面収録権限ダイアログ、macOS標準カラーピッカーの実起動(いずれもOSネイティブ導線のため下記「手動確認チェックリスト」で実機確認する)

### 手動確認チェックリスト(T20 以降・追加分)

| # | 確認項目 | 対応タスク | 対応 FR/NFR |
| - | -------- | ---------- | ------------ |
| 1 | 矢印・矩形・円・テキスト・モザイクを複数回焼き込んだ後、`Cmd+Z`を連続実行して1操作ずつ元に戻り、`Cmd+Shift+Z`を連続実行して元の状態までやり直せること。上限30件を超える焼き込みでも異常終了しないこと | T23, T29 | FR-014, §10決定#9 |
| 2 | macOS標準カラーピッカー(`<input type="color">`)の起動・任意色の選択・矢印/矩形/円/テキストへの反映が主要macOSバージョンで動作すること | T28 | FR-013, §10決定#11 |
| 3 | 日本語IME変換中に`Enter`を押してもテキストが確定・焼き込みされず、変換確定後の`Enter`で正しく確定されること | T27 | FR-012, §10決定#10 |
| 4 | テキスト入力欄表示中に`Cmd+C`/`Cmd+Z`/`Cmd+Shift+Z`を押しても、入力欄自体の編集操作(コピー・取り消し等)として扱われ、Canvasの注釈操作が実行されないこと | T27, T29 | FR-012, FR-014 |
| 5 | 5K相当の大きな画像で矩形/円/モザイクを多数回描画し、Undoスタックのメモリ使用量(差分方式)と取り消し動作が破綻しないこと | T25, T26, T23 | FR-014, PRD §11リスク |

### リスク・懸念事項(T20 以降・追加分)

| リスク | 影響度 | 対策 |
| ------ | ------ | ---- |
| `src/ui/toolbar.ts` / `src/main.ts` / `src/styles.css` / `index.html` が T25〜T29 の複数タスクにまたがる「ホットスポットファイル」になっている(既存T01〜T18の`main.ts`/`lib.rs`問題と同種) | 中 | 実行順(T25→T26→T27→T28→T29)を厳守する。並行実装する場合は当該ファイルの担当を1タスクに限定し、他タスクは差分をレビューで確認してから着手する |
| Undo/Redoスタック(T23)を先に実装しても、各ツール(T24〜T27)が実際に`pushUndoStep()`を呼ぶまで結合動作を確認できない(T23単体のテストは差分の入出力のみを検証する純粋関数テストに留まる) | 低 | T29(取り消し/やり直しボタン)で全ツール実装後にまとめて結合確認する。T30のE2Eで最終検証する |
| テキストツール(T27)のDOM入力オーバーレイが、既存の「Canvasピクセルスナップショット」パターンと異なる実装形態のため、`isSameCanvasImage()`によるドラッグ中断パターンをそのまま流用できない箇所がある(クリック起点でドラッグではない) | 低 | T27の設計どおり、オーバーレイ表示中の画像差し替えを`isSameCanvasImage()`で検知しオーバーレイを破棄する方式で対応する(ドラッグ系と同じ判定関数を再利用しつつ、適用ポイントのみクリック起点用に調整する) |

### ドキュメント更新計画(T20 以降・追加分)

> `.claude/rules/document-management.md` により、`docs/docs/*.md` と `project-config.md` §2/§3 の一次更新責務は
> `/implementing-features` にある。本追記(`/plan`)はこれらのファイルを変更しない。

- T20〜T30 はいずれも新規npm依存・Cargo依存を追加しない(既存のCanvas 2D API・DOM APIの範囲で実装する想定)ため、`project-config.md` §2への追加は見込まない。追加が必要になった場合は実装タスク側が報告する
- `docs/docs/data-model.md`: `ToolSettings`/`UndoStep`(Redo分含む)の型定義(PRD §5)を実装フェーズで反映
- `docs/docs/architecture.md`: `coords.ts`/`toolSettings.ts`/`undoStack.ts`/`shortcutGuards.ts`/新規ツール3種/新規UI3種のディレクトリ構成差分(ARCH §4・§5.1)を実装フェーズで反映
- `docs/docs/development-patterns.md`: テーパー矢印の多角形塗りつぶしパターン、Undo/Redoの差分方式、`isEditableTarget()`共通化の落とし穴(あれば)を実装フェーズで追記
