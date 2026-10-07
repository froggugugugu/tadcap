# 設計ドキュメント: キャプチャのショートカット変更(設定画面)

> 作成: 2026-10-08 / `/plan` / 状態: **承認済み・実装済み**(2026-10-08。【要確認】6 件はすべて推奨案)
> 人間承認済みの範囲: キャプチャのキーのみ(エディタ内のキーは対象外)/ 設定画面はエディタ上のモーダル
> タスク ID は本プラン内の連番(T1〜T9)。既存の T01〜T34 と区別するため、PROGRESS では `KS-T1` のように書く

## 要件サマリー

- トレイメニューに「設定…」を追加し、選ぶとエディタを前面に出して設定モーダルを開く
- アプリメニュー(Tadcap メニュー)に「設定…」(`⌘,`)を追加し、同じモーダルを開く
- モーダルのキー入力欄にフォーカスしてキーを押すと、その組み合わせを記録してキャプチャのキーにする
- 修飾キー(⌘ / ⌥ / ⌃ のいずれか)を含まない組み合わせは受け付けず、理由を表示する(⇧ だけは不可)
- 新しいキーの登録に失敗したら、元のキーを登録し直してエラーを表示する(キャプチャできない状態を作らない)
- 「既定に戻す」で ⌘⇧2 に戻る
- 設定はアプリの設定ファイルに保存し、次回起動時もそのキーを登録する(設定保存の仕組みは新設)
- キャプチャボタンのツールチップ・`aria-label`・空状態の「⌘⇧2 でキャプチャ」表記が、選んだキーに追従する
- モーダルを開いている間はエディタのキー操作(⌘Z / ⌘C / ⌘⇧F / Delete など)が働かない
- エディタ内のショートカット(⌘Z 等)は変更できない(範囲外)

## 現状の把握(根拠)

| 項目 | 現状 | 根拠 |
| ---- | ---- | ---- |
| ショートカット登録 | `setup()` で既定キー 1 つを固定登録。ハンドラはクロージャに捕まえた固定 `Shortcut` と比較 | `src-tauri/src/shortcuts.rs:60-110` |
| 登録失敗時 | ログのみで起動継続 | `src-tauri/src/shortcuts.rs:101-107` |
| 文字列表現 | `global-hotkey` 0.8.0 の `HotKey` は `FromStr`(`"shift+super+Digit2"` 等、キーは `KeyboardEvent.code` 名)と `Display` を持ち往復できる | `~/.cargo/registry/.../global-hotkey-0.8.0/src/hotkey.rs:117-150` |
| トレイ | 「キャプチャ」「エディタを開く」「終了」の 3 項目 | `src-tauri/src/tray.rs:158-169` |
| アプリメニュー | 自前で作っていない(Tauri の既定メニュー。v0.3.1 で Dock 表示にしたため表示される) | `src-tauri/src/lib.rs:13-80` |
| 設定の保存 | 仕組みなし(store プラグイン等も未導入) | `src-tauri/Cargo.toml`、`package.json` |
| 表記 | `index.html` に直書き(`title`/`aria-label`/空状態の `<kbd>`) | `index.html:18-19`、`index.html:148` |
| エディタのキー処理 | `window` の `keydown` で処理(5 か所) | `src/ui/arrangeButtons.ts:72`、`undoButton.ts:114`、`clipboardButton.ts:168`、`selectionKeys.ts:68`、`canvas/tools/shapeTools.ts:346` |
| モーダルの前例 | 履歴「すべて削除」の `<dialog>`(`confirm-dialog` クラス) | `src/ui/sidebar.ts:196-240` |
| E2E モック | 未知のコマンドは `null` を返す | `e2e/fixtures/tauriMock.ts:276-280` |
| アプリ識別子 | `dev.tadcap.app` → 設定ファイルは `~/Library/Application Support/dev.tadcap.app/settings.json` | `src-tauri/tauri.conf.json:5` |

## 設計の要点

### IPC 契約(先に固定し、Rust とフロントを並行で作れるようにする)

| 種別 | 名前 | 引数 / ペイロード | 戻り値 / 備考 |
| ---- | ---- | ----------------- | ------------- |
| コマンド | `get_capture_shortcut` | なし | `CaptureShortcutInfo` |
| コマンド | `set_capture_shortcut` | `{ accelerator: string }` | `CaptureShortcutInfo`。失敗は固定文字列で reject |
| コマンド | `reset_capture_shortcut` | なし | `CaptureShortcutInfo`(既定 ⌘⇧2 に戻す) |
| コマンド | `set_shortcut_recording` | `{ recording: boolean }` | `null`。記録中はキャプチャのショートカット押下を無視する(【要確認】#1) |
| イベント | `settings://open` | なし | トレイ / アプリメニューの「設定…」で Rust → フロントへ送る |

```ts
interface CaptureShortcutInfo {
  accelerator: string;   // global-hotkey の文字列形式。例 "shift+super+Digit2"
  isDefault: boolean;    // 既定キーと同じか(「既定に戻す」の有効/無効に使う)
  registered: boolean;   // OS への登録に成功しているか(起動時の失敗を設定画面で知らせる)
}
```

エラー文字列(既存の `"permission_denied"` と同じ固定文字列方式。`src-tauri/src/error.rs:26`):

| 文字列 | 意味 | 表示文言(案) |
| ------ | ---- | ------------ |
| `shortcut_invalid` | 解釈できない / 修飾キー(⌘⌥⌃)が無い | 「⌘・⌥・⌃ のどれかと一緒に押してください。」 |
| `shortcut_reserved` | macOS 標準のスクリーンショット(⌘⇧3/4/5)等と重なる(【要確認】#2) | 「このキーは macOS が使っています。」 |
| `shortcut_register_failed` | 他のアプリが使用中などで登録できなかった(元のキーに戻した) | 「このキーは使えませんでした。ほかのアプリが使っている可能性があります。元のキーのままです。」 |
| `settings_save_failed` | 設定ファイルに書けなかった(元のキーに戻した) | 「設定を保存できませんでした。元のキーのままです。」 |

### 設定ファイル(新設)

- 場所: `app.path().app_config_dir()/settings.json`
- 形式: `{ "version": 1, "captureShortcut": "shift+super+KeyK" }`(`captureShortcut` 省略 = 既定)
- 読込: ファイル無し・壊れている・解釈できないキー → 既定キーで起動し、ログを出す(ファイルは次の保存で上書き)
- 書込: 同じディレクトリの一時ファイルへ書いてから `rename`(書きかけのファイルを残さない)。ディレクトリが無ければ作る
- 新規クレートは追加しない(`serde` / `serde_json` は導入済み。store プラグインは使わない=依存を増やさない)

### キー変更の手順(Rust、決定論的に)

1. `accelerator` を `Shortcut` に解釈 → 修飾キー検査 → 予約キー検査(失敗なら何も変えずに reject)
2. 現在のキーと同じなら何もせず成功を返す
3. 現在のキーを登録解除 → 新しいキーを登録。失敗したら元のキーを登録し直して `shortcut_register_failed`
4. 設定ファイルへ保存。失敗したら新キーを解除・元キーを再登録して `settings_save_failed`(【要確認】#5)
5. 管理状態(`Mutex<CaptureShortcutState>`)の現在キーを更新して `CaptureShortcutInfo` を返す

手順 3〜4 は `trait ShortcutRegistrar { register / unregister }` 越しの純粋関数にし、偽の登録器で巻き戻しを `cargo test` する。
ハンドラは固定値ではなく管理状態の現在キーと比較する(変更後のキーで動くように)。

### メニュー

- トレイ: 「キャプチャ」「エディタを開く」「設定…」「終了」の 4 項目
- アプリメニュー: `Menu::default()` を組み立て、先頭(Tadcap)サブメニューの「Tadcap について」の直後に「設定…」(`CmdOrCtrl+,`)を挿入して `app.set_menu()`
- どちらも共通関数 `open_settings(app)` = `bring_main_window_to_front(UserMenu)` のあと `settings://open` を送出
- フロント側のモーダルは「既に開いていれば何もしない」(冪等)。Tauri のアプリ全体の `on_menu_event` にトレイのメニューイベントも届く場合の二重起動を、フロント側でも吸収する

### フロント

- `src/ui/shortcutFormat.ts`(純粋関数): `KeyboardEvent` → `accelerator`(`event.code` を使う。⌥ を押すと `event.key` が特殊文字になるため)/ `accelerator` → 表示ラベル(例 `⌘⇧2`)/ 修飾キー検査(Rust と同じ規則。Rust 側が最終判定)
- `src/ui/settingsDialog.ts`: `<dialog>` を組み立てる(既存の `confirm-dialog` の見た目を流用)。中身はキー入力欄・状態メッセージ・「既定に戻す」・「閉じる」
  - キー入力欄(`<button>` に `role` 不要、表示は現在キー)にフォーカスで記録開始 → `set_shortcut_recording(true)`、フォーカスが外れる・閉じる・記録完了で `false`
  - 修飾キーだけの `keydown`(`MetaLeft` など)は無視して待ち続ける。`Esc` は記録の取消(記録中でなければモーダルを閉じる)、`Tab` はフォーカス移動に使う
  - 有効な組み合わせを押したらその場で `set_capture_shortcut`(【要確認】#3)。成功 → 表示更新、失敗 → 元のキー表示に戻しエラー文言
  - ダイアログ要素の `keydown` で `stopPropagation()` し、`window` のエディタ用ハンドラへ届かせない(⌘Z・Delete 等がモーダルの裏で動かないように)
  - `registered: false` のときは「現在のキーは登録できていません」を表示
- `src/ui/captureShortcutLabel.ts`: 現在のラベルを `#capture-button` の `title`/`aria-label` と `#empty-state kbd` に反映(起動時は `get_capture_shortcut` の結果、失敗・`null` なら `index.html` の既定表記のまま)

## 影響調査

| カテゴリ | ファイル | 変更内容 |
| -------- | -------- | -------- |
| スキーマ | `src-tauri/src/settings.rs`(新規) | 追加: `AppSettings` の読込・保存(原子的書込)とテスト |
| スキーマ | `src/ipc/settings.ts`(新規) | 追加: `CaptureShortcutInfo` 型と 4 コマンド・`settings://open` 購読のラッパー |
| ストア | `src-tauri/src/shortcuts.rs` | 変更: 現在キーの管理状態化、検証(修飾・予約)、変更 / 既定に戻す / 記録中無視、起動時に保存済みキーを登録 |
| ユーティリティ | `src/ui/shortcutFormat.ts`(新規) | 追加: キー入力 → accelerator、accelerator → 表示ラベル、修飾検査 |
| コンポーネント | `src/ui/settingsDialog.ts`(新規) | 追加: 設定モーダル(記録・エラー表示・既定に戻す・冪等な open) |
| コンポーネント | `src/ui/captureShortcutLabel.ts`(新規) | 追加: ツールチップ・空状態の表記を現在キーへ追従 |
| コンポーネント | `src-tauri/src/tray.rs` | 変更: 「設定…」項目と `open_settings()` 共通関数 |
| コンポーネント | `src-tauri/src/app_menu.rs`(新規) | 追加: 既定のアプリメニューに「設定…」(⌘,)を挿入 |
| ページ | `index.html` | 変更: 表記に `id`/`data-` フックを付与(既定表記は残す) |
| ページ | `src/main.ts` | 変更: ラベル反映・モーダル初期化・`settings://open` 購読 |
| 設定 | `src-tauri/src/commands.rs` | 変更: 4 コマンドを追加(既存方針「コマンドはここに集約」) |
| 設定 | `src-tauri/src/error.rs` | 変更: `AppError` にショートカット・保存のバリアント追加 |
| 設定 | `src-tauri/src/lib.rs` | 変更: `mod settings` / `mod app_menu`、`manage`、`set_menu`・`on_menu_event`、`invoke_handler` |
| 設定 | `src/styles.css` | 変更: 設定モーダル(キー入力欄・エラー文言)のスタイル追加 |
| テスト | `src-tauri/src/settings.rs` / `shortcuts.rs` / `tray.rs` / `app_menu.rs` 内 `mod tests` | 追加 |
| テスト | `src/ui/shortcutFormat.test.ts` / `settingsDialog.test.ts` / `captureShortcutLabel.test.ts` / `src/ipc/settings.test.ts`(新規) | 追加 |
| テスト | `e2e/fixtures/tauriMock.ts` | 変更: 4 コマンドのモック・登録失敗の切替・`settings://open` 発火手段 |
| テスト | `e2e/shortcut-settings.spec.ts`(新規) | 追加 |
| テスト | `testreport/manual/CHECKLIST_T18.md` | 変更: 実機確認項目を追加 |
| ドキュメント | `docs/docs/architecture.md` / `data-model.md` / `development-patterns.md`、`README.md`、`.github/pages/index.html` | 変更: 後述 |

## タスク分解

### Phase 1(並行可能)

- [ ] T1 — 設定ファイルの読込・保存(`AppSettings`、原子的書込、壊れたファイル・未知キーは既定扱い)と `cargo test`(変更ファイル: src-tauri/src/settings.rs, src-tauri/src/lib.rs(`mod settings;` の 1 行のみ) | 依存: なし)
- [ ] T2 — 表示・入力の純粋関数(`KeyboardEvent` → accelerator、ラベル化、修飾検査)と Vitest(変更ファイル: src/ui/shortcutFormat.ts, src/ui/shortcutFormat.test.ts | 依存: なし)
- [ ] T3 — IPC ラッパー(4 コマンド・`settings://open` 購読・`null` 時は既定扱い)と Vitest(変更ファイル: src/ipc/settings.ts, src/ipc/settings.test.ts | 依存: なし)

### Phase 2(Phase 1 完了後。T4 と T5 は並行可能)

- [ ] T4 — ショートカットの変更機構: 管理状態・検証・登録の巻き戻し(`ShortcutRegistrar` trait)・記録中無視・起動時に保存済みキーを登録、`AppError` 追加、4 コマンド追加と `invoke_handler`/`manage` 登録、`cargo test`(変更ファイル: src-tauri/src/shortcuts.rs, src-tauri/src/error.rs, src-tauri/src/commands.rs, src-tauri/src/lib.rs | 依存: T1)
- [ ] T5 — 設定モーダルと表記追従のモジュール(記録・エラー表示・既定に戻す・冪等 open・`keydown` の伝播停止・記録フラグの ON/OFF)、スタイル、Vitest(jsdom)(変更ファイル: src/ui/settingsDialog.ts, src/ui/settingsDialog.test.ts, src/ui/captureShortcutLabel.ts, src/ui/captureShortcutLabel.test.ts, src/styles.css | 依存: T2, T3)

### Phase 3(Phase 2 完了後。T6 と T7 は並行可能)

- [ ] T6 — メニュー: トレイに「設定…」、アプリメニューに「設定…」(⌘,)、共通の `open_settings()`(前面化 + `settings://open`)、メニュー ID 判定の `cargo test`(変更ファイル: src-tauri/src/tray.rs, src-tauri/src/app_menu.rs, src-tauri/src/lib.rs | 依存: T4)
- [ ] T7 — 結線: 起動時に現在キーを取得して表記へ反映、モーダル初期化、`settings://open` 購読、`index.html` に表記のフック(変更ファイル: src/main.ts, index.html | 依存: T5)

### Phase 4(Phase 3 完了後)

- [ ] T8 — E2E: モック拡張と設定フローのシナリオ(変更ファイル: e2e/fixtures/tauriMock.ts, e2e/shortcut-settings.spec.ts | 依存: T6, T7)
- [ ] T9 — ドキュメント・手動確認項目・README / 紹介ページの「キー変更機能は現在ありません」等の更新(変更ファイル: docs/docs/architecture.md, docs/docs/data-model.md, docs/docs/development-patterns.md, README.md, .github/pages/index.html, testreport/manual/CHECKLIST_T18.md | 依存: T8)

> `src-tauri/src/lib.rs` は T1(1 行)→ T4 → T6 の順に逐次で触る(同一ファイルの同時編集禁止)。実装モードは既存どおり逐次でもよい。

## 依存関係グラフ

```text
T1 ──────────────→ T4 ──→ T6 ──┐
T2 ──┐                         ├──→ T8 ──→ T9
     ├──→ T5 ──→ T7 ───────────┘
T3 ──┘
```

## テスト戦略

### 検証手段(着手前に固定)

スモーク: `npm run build && npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings && npm run e2e`(Bash では先頭に `. "$HOME/.cargo/env" &&`)。全 green + 新規テスト件数の報告を完了条件とする。

### ユニットテスト(Rust、`cargo test`)

- `settings.rs`: ファイル無し → 既定 / 正常 JSON → 値 / 壊れた JSON → 既定 / 未知フィールドは無視 / 保存 → 読込で往復 / ディレクトリが無くても保存できる(`std::env::temp_dir()` 配下の一時ディレクトリ)
- `shortcuts.rs`: 検証(修飾なし → `shortcut_invalid`、⇧ のみ → `shortcut_invalid`、⌘⇧3/4/5 → `shortcut_reserved`、⌥K・⌃⌘P → 成功)/ 文字列の往復 / 偽の登録器で「新キー登録失敗 → 元キー再登録」「保存失敗 → 元キーへ巻き戻し」「同じキー → 何もしない」/ 記録中は押下を無視 / 既存の `should_handle_shortcut_event` テストは維持
- `tray.rs` / `app_menu.rs`: 「設定…」の ID → アクション判定

### ユニットテスト(TS、Vitest)

- `shortcutFormat`: ⌘⇧2 → `"shift+super+Digit2"` / ⌥K(`key` が `"˚"` でも `code` で判定)/ 修飾キーだけの押下は「待機」/ 修飾なし・⇧ のみはエラー理由 / F キー・記号キー / ラベル化(既定 `⌘⇧2` が現状表記と一致すること)
- `ipc/settings`: コマンド名・引数、`null`(未対応環境)時は既定扱い
- `settingsDialog`(jsdom): 開く(2 回呼んでも 1 つ)/ 記録 → `set_capture_shortcut` 呼び出し / 失敗時に元のキー表示 + 文言 / 既定に戻す(既定のときは無効)/ Esc の扱い / `keydown` が `window` に届かない / 記録フラグが閉じる・blur で必ず OFF
- `captureShortcutLabel`: `title`・`aria-label`・空状態の `kbd` がそろって更新される

### E2E テスト(Playwright + IPC モック、`e2e/shortcut-settings.spec.ts`)

- `settings://open` 発火でモーダルが開き、現在キー `⌘⇧2` が表示される
- キー入力欄で `Meta+Alt+KeyK` を押す → モーダル・ツールチップ・空状態がすべて `⌘⌥K` 表記になる
- 修飾キーなし(`KeyK`)→ エラー文言、表記は元のまま、`set_capture_shortcut` は呼ばれない
- モックで登録失敗を返す → エラー文言、表記は元のまま
- 「既定に戻す」→ `⌘⇧2` に戻る
- 画像を読み込んだ状態でモーダルを開き ⌘Z / Delete を押しても、エディタの内容が変わらない

### 手動確認(実機、`testreport/manual/CHECKLIST_T18.md` に追記)

- トレイとアプリメニュー(⌘,)の両方から「設定…」でモーダルが 1 つだけ開く(エディタを閉じていても前面に出る)
- 新しいキーでどのアプリからでもキャプチャでき、古いキーでは反応しない
- アプリを終了 → 再起動しても新しいキーが効く。設定ファイルを壊しても既定キーで起動する
- 他アプリが使っているキーを指定するとエラーになり、元のキーでキャプチャできる
- 記録中に現在のキーを押してもキャプチャが始まらない
- 記録中に ⌘Q / ⌘W / ⌘C など既定のアプリメニューにあるキーを押したときの挙動(リスク参照)

## ドキュメント更新計画

### project-config.md

- §2(技術スタック): 新規ライブラリなし。設定ファイルを serde_json で自前保存する旨を 1 行(実装タスクが更新)
- §11(既知の落とし穴): ①グローバル登録したキーは OS に先取りされ webview の `keydown` に届かない ②キーの記録は `event.code` を使う(⌥ で `event.key` が化ける)③アプリメニューのキー(⌘Q 等)は webview より先に処理される — を重複確認のうえ追記
- §5(データ永続化)は人間の決定領域のため AI は書き換えない。「戦略: アプリ設定ファイル(JSON)」の記入を人間に依頼する

### docs/

- `docs/docs/architecture.md`: `settings.rs`・`app_menu.rs`・`ui/settingsDialog.ts` 等の追加、`setup()` の順序(設定読込 → トレイ → アプリメニュー → ショートカット)、新規コマンド・イベント、テスト一覧
- `docs/docs/data-model.md`: `AppSettings`(ファイル形式)・`CaptureShortcutInfo`・エラー文字列
- `docs/docs/development-patterns.md`: 設定ファイルの原子的書込、モーダル内 `keydown` の伝播停止、登録の巻き戻しパターン
- `README.md` 16・86・98・117-118 行、`.github/pages/index.html` の「⌘⇧2」記述に「(設定で変更可)」を添え、「キー変更機能は現在ありません」を削除
- `src-tauri/src/shortcuts.rs` の doc コメント「キー変更 UI は提供しない(MVP 外)」を改訂(T4)
- PRD FR-004「変更 UI は MVP 外」・ARCH の該当記述は人間 / アナリスト側で改訂する(本プランでは触らない)

## 【要確認】(人間の判断が必要)

1. **記録中に現在のキーを押したとき**: A 案(推奨)= 記録中フラグで Rust のハンドラが押下を無視する(登録は維持。キーは OS に先取りされるので入力欄には何も出ない)。B 案 = 記録中は登録を一時解除する(現在のキーも記録できるが、解除したまま戻らない失敗経路が増える)
2. **禁止するキー**: 推奨 = ①⌘⇧3/⌘⇧4/⌘⇧5(macOS のスクリーンショット)を拒否 ②⌘ + 1 キーだけ(⌘C・⌘V・⌘Q など)も拒否し、⌘ を使うなら ⇧/⌥/⌃ のどれかとの併用を必須にする(全アプリのコピー等を奪うため)。②は承認済みの「修飾キー必須」より厳しいので要判断
3. **適用のタイミング**: 推奨 = キーを押した時点で即適用(保存ボタンなし)。代案 = 「保存」ボタンで確定
4. **記号の並び**: 推奨 = 既存表記(⌘⇧F など)に合わせ ⌘ → ⌥ → ⌃ → ⇧ → キー(既定は今と同じ `⌘⇧2`)。代案 = Apple HIG の順 ⌃⌥⇧⌘(既定が `⇧⌘2` になり、他のボタンの表記と並びが揃わない)
5. **保存に失敗したとき**: 推奨 = 新キーを取り消して元に戻す(画面・登録・ファイルが常に一致)。代案 = 新キーは今回だけ有効にして警告
6. **起動時に保存済みキーを登録できなかったとき**: 推奨 = 保存値は変えずにログを出し、設定画面に「登録できていません」と表示(トレイの「キャプチャ」は使える)。代案 = 既定キーへ自動で切り替える

## リスク・懸念事項

- **アプリメニューのキーとの衝突**: 既定のアプリメニュー(v0.3.1 から表示)の ⌘Q・⌘H・⌘W・⌘C 等は webview の `keydown` より先にメニューが処理しうる。記録中に ⌘Q を押すと終了する可能性がある。【要確認】#2 の②を採れば記録対象から外れるが、押下自体は防げない。実機確認項目に入れる
- **メニューイベントの二重配送**: Tauri v2 ではアプリ全体の `on_menu_event` にトレイのメニューイベントも届く可能性がある。ID を分けて片方だけで処理し、フロントの open も冪等にして二重でも 1 つしか開かない設計にした。実機で確認する
- **記録フラグの取り残し**: フロントが記録中に再読込・異常終了するとフラグが ON のまま残り、ショートカットが効かなくなる。フロント初期化時に必ず OFF を送り、閉じる / blur でも OFF にする
- **Option 単独の組み合わせ**: ⌥ + 文字(⌥K 等)を登録すると全アプリでその特殊文字が入力できなくなる。禁止はせず、文言での注意に留める(【仮定】)
- **既存ダイアログ**: 履歴「すべて削除」の `<dialog>` でもエディタのキーが裏で動く可能性がある(今回の範囲外。必要なら別タスク)
