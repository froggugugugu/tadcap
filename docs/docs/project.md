# プロジェクト情報

> **これはテンプレートです。** セットアップ直後は空の状態です。
> 以下のいずれかの方法で内容が生成されます:
> - `/architecture` スキル実行時に自動生成
> - `/implementing-features` スキル実行時に自動更新
> - PJMチームのPhase 2以降で自動生成
>
> **生成方法**: `project-config.md` のセクション1〜3, 5, 7, 11〜12 を基にAIが生成・メンテナンスする。
> ルーティング・ストア一覧はAIがコードベースから自動生成する。
> 人間が直接編集しても良いが、`project-config.md` との整合性を保つこと。

## 概要

<!-- project-config.md セクション1 から展開 -->

## コマンド

<!-- project-config.md セクション3 から展開 -->

```bash
npm install                # 依存インストール
npm run dev                # Vite 開発サーバー
npm run build              # tsc && vite build
npm run test               # Vitest（watch）
npm run test:run           # Vitest 一回実行
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run dist:mac           # 配布物 release/Tadcap-<版>-arm64.dmg / .zip(アドホック署名)
```

リリース: 3 ファイル(`package.json`・`src-tauri/tauri.conf.json`・`src-tauri/Cargo.toml`)の版を揃えてコミット → `git tag v<版>` → タグを push。`.github/workflows/release.yml` が検証して GitHub Releases に公開し、`scripts/install.sh`(紹介ページから配信)が最新版を入れる。

スモークテストコマンド(全タスク共通、ゲート3 決定):

```bash
npm run build && npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## 技術スタック

<!-- project-config.md セクション2 から展開 -->

| カテゴリ | 技術 |
| -------- | ---- |
| テスト   | Vitest 5.0.1（TS ユニット、T01 で追加） |
| 状態管理 | ライブラリ導入なし。`src/canvas/canvasState.ts` 等モジュール単位の薄い状態オブジェクト + 購読関数(ARCH §1.3 決定#1、T07 で `canvasState` を追加) |
| 画像描画 | HTML5 Canvas(ブラウザ標準API）。`src/canvas/render.ts` が画像を読み込み Canvas に原寸描画する(T07)。画像は `read_capture_image` コマンドのバイト列 → `Blob` → ObjectURL で読む(asset protocol は webview と別オリジンで Canvas を汚染するため撤去、実機不具合②〜⑤)。矢印描画(`src/canvas/tools/arrowTool.ts`、既定色 `#FF5C8A`)・座標変換(`src/canvas/coords.ts`)・ツール切替UI(`src/ui/toolbar.ts`)をT09で追加。T24【改訂 2026-09-24】で矢印をテーパー形状(`computeTaperArrowPolygon()`)化し、描画色の参照元を`--arrow-color`から`toolSettings`(下記)へ変更した。T25【新設 2026-09-24】で矩形枠ツール(`src/canvas/tools/rectangleTool.ts`、塗りつぶしなしの`ctx.strokeRect()`、線幅はCanvas対角線基準のローカル定数)を追加した。T26【新設 2026-09-24】で円(楕円)枠ツール(`src/canvas/tools/ellipseTool.ts`、塗りつぶしなしの`ctx.ellipse()`+`ctx.stroke()`、線幅・Shift正円補正はT25と同じ算出式をローカルに複製)を追加した。T25追補【改訂 2026-09-24】で人間フィードバックを受け、矢印の終点側太さ(典型サイズ20px前後、上限48px/下限6px)・矢じり寸法(長さ=胴×3、幅=胴×2.4)・始点比率(0.15)を引き上げ、焼き込み時に半透明ドロップシャドウ(`arrowShadowParams()`)を追加した(project-config.md §11参照)。T31【改訂 2026-09-24】で矢印の終点側太さをさらに1.5倍(典型30px、上限72px/下限9px)にし、矢印・矩形・円は描いた直後に「編集中」(ハンドルでリサイズ・移動、ハンドルは重ねたオーバーレイcanvasに描画)となり確定操作で焼き込む方式にした(`src/canvas/pendingShape.ts`・`shapeEdit.ts`・`tools/shapeTools.ts`)。T27【新設 2026-09-24】でテキストツール(`src/canvas/tools/textTool.ts`、クリック位置に重ねた`<input>`で入力しEnter/blurで`ctx.fillText()`焼き込み、フォントはシステムフォント・実寸は画像対角線基準) |
| メニューバー常駐 | Tauri コア機能 `tray-icon` feature（追加クレートなし、T15）。`src-tauri/src/tray.rs` が「キャプチャ/エディタを開く/終了」3項目メニューを構築し、Dockアイコンは `ActivationPolicy::Accessory` で非表示にする。エディタの前面化は `objc2` 0.6 / `objc2-app-kit` 0.3(macOSのみ。tao が既に依存している版・機能の範囲)で `NSApplication::activate` + `NSWindow::orderFrontRegardless` を併用する(実機不具合①) |
| グローバルショートカット | `tauri-plugin-global-shortcut` 2.x（Rustクレートのみ、T16）。`src-tauri/src/shortcuts.rs` が既定キー `Cmd+Shift+2` を登録し、押下（`ShortcutState::Pressed`）時に `tray::run_capture_and_show_editor()` を呼ぶ。JS側パッケージ・`capabilities/default.json` の権限追加はいずれも不要(フロントから呼ばずRustネイティブAPIのみで完結するため) |
| クリップボード | `tauri-plugin-clipboard-manager` 2.x（JS/Rust両方、T12）+ `arboard` 3.x（Rustフォールバックのみ、T12）。`src/ipc/clipboard.ts::copyToClipboard()` がまず `@tauri-apps/api/image::Image.new(rgba, width, height)` + `writeImage()`(主経路)を試行し、失敗時のみ Rust コマンド `write_image_fallback`(`src-tauri/src/clipboard/mod.rs` が `arboard::Clipboard::set_image()` を呼ぶ)へ切り替える。Canvas の `getImageData()` 由来の生RGBA8を主経路・フォールバック共通のペイロードにしている(ARCH §5.2は`toBlob('image/png')`のPNGバイト列を想定していたが、`arboard`がPNGデコードをサポートせずデコード用クレート追加はARCH承認範囲外のため変更した。理由はproject-config.md §11参照)。フォールバックへの転送は`invoke()`の生ボディ渡し(`Uint8Array`をpayload引数に直接渡す)を使い、JSON配列化によるサイズ膨張を避ける(`width`/`height`はヘッダーで渡す)。`capabilities/default.json` は `clipboard-manager:allow-write-image` のみ追加(読み取り権限は付与しない) |

## IPC コマンド一覧

<!-- AIがコードベース(src-tauri/src/commands.rs, lib.rs の invoke_handler)から自動生成 -->

| コマンド | 引数 | 戻り値 | エラー | 送出イベント |
| -------- | ---- | ------ | ------ | ------------ |
| `capture_screen`(T06、T16で `async fn` 化) | なし(`AppHandle` は Tauri が自動注入。フロントの `invoke()` 呼び出しに引数不要) | `Option<CaptureResult>`。`CaptureResult = { id: string, sourcePath: string, kind: "range", createdAt: string(ISO8601, UTC, 例: `2024-01-01T00:00:00.000Z`) }`。Escキャンセル時、または他起点(トレイ/ショートカット)が実行中で多重起動を防いだ場合は `null`(`Ok(None)`) | `AppError` は文字列としてシリアライズされる。固定文字列 `"permission_denied"` = 画面収録権限未許可(NFR-002。フロント側はこの文字列で専用の案内導線に分岐する、T08) | 撮影成功時(`CaptureResult` が取得できた場合)のみ `capture://completed` に `CaptureResult` と同じペイロードを emit。Escキャンセル時はイベントを送出しない。グローバルショートカット(T16)・トレイメニュー(T15)起点のキャプチャも同じイベントで通知され、フロントエンドは起点を区別しない(ARCH §5.2) |
| `check_screen_recording_permission`(T08、`async fn`) | なし | `ScreenRecordingPermission`(camelCaseにシリアライズされ `"granted"`/`"notGranted"` のいずれか)。未許可の場合、Rust側が `request_screen_recording_access()` を1回呼びOSの許可ダイアログ表示とシステム設定「画面収録」一覧へのアプリ登録を行う(PJM決定 2026-09-23) | 発生しない(`spawn_blocking` の `JoinError` のみ `AppError::Internal` に変換) | なし |
| `read_capture_image`(実機不具合②〜⑤、`async fn`) | `{ path: string }`(`CaptureResult.sourcePath`) | `tauri::ipc::Response`(PNGの生バイナリ。JSは `ArrayBuffer` で受け取る) | `AppError::Internal`(正規化後のパスがキャプチャ専用ディレクトリ直下でない・PNG通常ファイルでない・I/Oエラー) | なし |
| `open_screen_recording_settings`(T08) | なし | `()` | `AppError::Internal`(`opener` プラグインの起動失敗時) | なし。固定URL `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` のみを開く(フロントエンドからURLは渡せない、ARCH §12) |
| `write_image_fallback`(T12、`async fn`) | 通常のJSON引数ではなく `tauri::ipc::Request` の生ボディ(RGBA8バイト列)+ ヘッダー(`x-tadcap-image-width`/`x-tadcap-image-height`) | `()` | `AppError::Internal`(ヘッダー欠落・不正値、`width*height*4`とバイト長の不一致、`arboard`の書込失敗のいずれも`Internal`に集約。専用バリアントは追加しない、YAGNI) | なし |
| `greet`(既存スキャフォールド) | `name: string` | `string` | 発生しない | なし |

トレイメニュー(`src-tauri/src/tray.rs`、T15)・グローバルショートカット(`src-tauri/src/shortcuts.rs`、T16)は
`#[tauri::command]` ではなく、それぞれ `on_menu_event`/`with_handler` ハンドラから直接
`tray::run_capture_and_show_editor()`(内部で `commands::run_capture` を呼ぶ共通処理)を呼ぶ。失敗時(画面収録権限未許可 等)は
`capture://error` イベントに `AppError` と同じ文字列ペイロードを emit したうえでエディタウィンドウを前面表示する
(ARCHに失敗系イベント名の規定が無いため T15 で最小追加。フロント側は `src/ipc/capture.ts::onCaptureError()` で購読する、T08)。
アプリ内ボタン・トレイ・グローバルショートカットの3起点は `commands::CAPTURE_IN_PROGRESS`(`AtomicBool`)を共有し、
いずれかが実行中は他の起点からの呼び出しを無視する(多重起動防止、T16)。

## ルーティング

<!-- AIがコードベースから自動生成 -->

| パス | ページ | 機能 |
| ---- | ------ | ---- |
| `/`(`index.html` 単一) | メインエディタ画面 | キャプチャ起動ボタン・Canvas表示(T07)。クライアントサイドルーターは導入しない(ARCH §8) |

## ストア一覧

<!-- AIがコードベースから自動生成 -->

| ストア | 責務 |
| ------ | ---- |
| `canvasState`(`src/canvas/canvasState.ts`、T07) | Canvasに表示中の画像(`CanvasImage \| null`)の保持・購読通知(ARCH §6.1)。T09で選択中ツール(`activeTool: "arrow" \| "mosaic" \| "rectangle" \| null`)・描画中フラグ(`isDrawing`)を追加。T25で`"rectangle"`を追加 |
| `permissionState`(`src/ipc/permissions.ts` の `PermissionState` 型、T08) | 画面収録権限の状態(`"unconfirmed" \| "granted" \| "notGranted"` の3値、ARCH §6.1)。Rust側は `Granted`/`NotGranted` の2値のみ(PJM決定 2026-09-23)。専用のシングルトンストアは持たず、`src/main.ts` がボタンの `invoke` reject・`capture://error` イベント・起動時チェックの3入口から `src/ui/permissionBanner.ts` の表示/非表示を直接呼び出す |
| `historyStore`(`src/history/historyStore.ts`、T14) | セッション内 `HistoryItem[]`(`id`/`thumbnail`/`image`/`createdAt`)の保持・購読通知(ARCH §6.1、FR-010)。永続化なし(アプリ終了で破棄)。`capture://completed`受信時に追加・選択、履歴切替直前・クリップボードコピー成功時に選択中項目のimage/thumbnailを上書き(PJM決定 2026-09-23)。上限件数は`HISTORY_LIMIT`(50件、【仮定】) |
| `toolSettings`(`src/canvas/toolSettings.ts`、T21) | 矢印/矩形/円/テキスト共通の現在色(`color: string`、既定`#FF5C8A`)・テキストのフォントサイズ段階(`fontSize: "small" \| "medium" \| "large"`、既定`"medium"`)の保持・購読通知(ARCH §6.1、FR-013)。永続化なし(アプリ起動中のみ)。モザイクは参照しない |
| `undoStack`(`src/canvas/undoStack.ts`、T23) | 焼き込み操作(矢印/矩形/円/テキスト/モザイク)ごとの差分(変更矩形+ピクセル)を保持するUndo/Redoスタックの保持・購読通知(ARCH §6.1・§6.4、FR-014)。永続化なし。件数上限`UNDO_STACK_LIMIT`(30件、Undo・Redo双方)超過時は最も古いものから破棄。`clearUndoStack()`は新規Capture読込・履歴項目再読込の完了後に呼ぶ想定(呼び出しは`main.ts`側、T24以降) |

## 制約事項

<!-- project-config.md セクション1, 5, 11, 12 から展開 -->

- パスエイリアス: <!-- project-config.md セクション4.2 -->
- E2Eテスト: <!-- project-config.md セクション8 -->
- Git Hooks: <!-- project-config.md セクション9 -->
