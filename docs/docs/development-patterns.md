# 開発パターン集

> **これはテンプレートです。** セットアップ直後は空の状態です。
> 以下のいずれかの方法で内容が生成されます:
> - `/implementing-features` スキルで新パターン発見時に自動追記
> - `/performance` `/refactoring` スキル実行時に自動追記
> - PJMチームのPhase 4以降で自動生成
>
> **生成方法**: `project-config.md` セクション2, 11 を基にAIが初期生成する。
> 新しいパターンや落とし穴の発見時にAI・人間が協調メンテナンスする。

プロジェクト固有のコード規約・落とし穴・アンチパターンをまとめる。
汎用的な知識はここには含めない。
ルート定義・ストア一覧・ディレクトリ構成・スキーマ定義は `docs/project.md`, `docs/architecture.md`, `docs/data-model.md` を参照。

---

## 1. 状態管理

<!-- project-config.md セクション2「状態管理」の技術に基づき、
     セレクタ、永続化、マイグレーション等のパターンを記述 -->

状態管理ライブラリ(Zustand等)は導入しない(ARCH §1.3 決定#1、NFR-003)。各ストアはモジュール単位の
薄い状態オブジェクトとして実装する: (1) 状態遷移を表す**純粋関数**(`createXxxState()`/`withYyy()` 等、
イミュータブルに新しい状態を返す)と、(2) それを保持し購読者に通知する**モジュール内シングルトン**
(`getXxxState()`/`setXxx()`/`subscribeXxxState()`)を分離してエクスポートする。前者はVitestで
DOM無しに直接テストでき、後者はUI層(`src/ui/`)が読み書き・購読に使う(例: `src/canvas/canvasState.ts`、T07)。

### 1.1 セレクタの注意点

<!-- 状態管理ライブラリ固有のアンチパターン -->

### 1.2 永続化パターン

<!-- 永続化の方式と注意点 -->

### 1.3 マイグレーション

<!-- データマイグレーションのパターン -->

---

## 2. UIフレームワーク固有

<!-- project-config.md セクション2「その他」の技術に基づき、
     フレームワーク固有の注意点を記述 -->

---

## 3. 数値精度

<!-- プロジェクトで扱う数値の丸め・精度に関するルール -->

---

## 4. データモデル変更時の規約

### スキーマ追加

<!-- 後方互換のための規約 -->

### マイグレーション

<!-- データマイグレーション時の規約 -->

### スキーマ設計パターン

<!-- Create / Update 派生型等のパターン -->

---

## 5. UI 規約

### ダークモード

```typescript
// OK: セマンティックカラー（自動対応）
className="text-foreground bg-background border-border"

// OK: ダークモード対応ユーティリティ
className="bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100"

// NG: ハードコードされた色値
style={{ backgroundColor: '#f0f0f0' }}
```

### コンポーネント設計

- **Presentational**: props のみに依存、ストアを直接参照しない
- **Container**: ストア/hooks を使用、pages ディレクトリまたは feature のトップに配置

### 条件付きスタイル

<!-- プロジェクトで使用するスタイル合成ヘルパーを記載 -->

---

## 6. E2E テストパターン

### テストデータ注入

<!-- project-config.md セクション11 に基づき、テストデータの注入方法を記述 -->

### UIコンポーネント操作ヘルパー

<!-- フレームワーク固有のUIコンポーネント操作パターン -->

---

## 7. デザインシステム

固有のデザインシステム(URL参照)は無し。「主役はキャプチャ画像、UIは脇役」の方針(T19、PJM決定)で
UIコンポーネントライブラリ・アイコンライブラリは導入せず、`src/styles.css` のトークン + インラインSVGで
完結させている(NFR-003、依存追加なし)。

### 7.1 参照するデザインシステム

外部のデザイン監査観点(既存UIの問題パターン監査)・エディトリアル系ミニマルUIの方向性(1アクセント色・
控えめな装飾・タイポグラフィ重視)を方針決定の参考にした(T19、`output/reports/ui/UI_REVIEW_T19.md`参照。
具体的な参照元の固有名詞は記載しない方針)。恒久的な外部URL参照は無し。

### 7.2 カラートークン

`:root`(`src/styles.css`)で定義する。値の重複定義を避けるため、CSS変数を単一の情報源(single source of
truth)とする(【改訂 2026-09-24、T24】`--arrow-color`は例外。下記参照):

| トークン | 値 | 用途 |
| -------- | --- | ---- |
| `--arrow-color` | `#ff5c8a` | UI全体のアクセント色の出所(下記`--accent-color`参照)・初期値の由来。T24以降、矢印等の注釈描画色そのものは`src/canvas/toolSettings.ts::DEFAULT_COLOR`(同じ`#FF5C8A`)を単一の真実源とする`toolSettings`ストアが担う(FR-013、色の一括指定)ため、**本トークンを変更しても描画色には反映されない**。2箇所の独立した`#FF5C8A`定義が生じた経緯・同期の要否はproject-config.md §11参照 |
| `--accent-color` | `var(--arrow-color)` | UI全体のアクセント色(選択中ツール・選択中履歴サムネイル・フォーカスリング)。`--arrow-color` への参照のみで、複製しない(T19「アクセントは1色のみ」) |
| `--border-color` | `#e2e2e2` | 罫線・区切り線(単一のグレー系統に統一、暖色/寒色グレーを混在させない) |
| `--text-muted` | `#7a7a7a` | 補助テキスト(空状態のヒント等) |
| `--surface-color` | `#ffffff` | ツールバー・サイドバー等の前景面 |

権限バナーの警告色(赤系、`#fdeceb`/`#8a2c22`/`#b23b2d`)はブランドアクセントではなくHIG準拠の意味的な
状態色(エラー/警告)として例外的に使用する(アクセント色1色ルールの対象外、Apple HIGのsystem red相当の
扱い)。

### 7.3 スペーシングスケール

厳密なスケール定義は無し(コンポーネント数が少ないため過剰設計を避けた、YAGNI)。ツールバー高さ `40px`、
アイコンボタン `30px` 角、アイコン本体 `17px` 角を基準値として踏襲する。

### 7.4 コンポーネント追加手順

UIコンポーネントライブラリは導入しない。新規UI要素は `src/ui/*.ts` に1ファイル1コンポーネントの
Presentational/Container分離パターン(`docs/development-patterns.md` §1参照)で追加し、スタイルは
`src/styles.css` にBEM風クラス名(`.block__element--modifier`)で追記する。

### 7.5 アイコン使用規約

アイコンライブラリは導入せず、依存を増やさないインラインSVG(`viewBox="0 0 20 20"` 統一、
`stroke-width`/`fill` は `currentColor` でボタンの文字色を継承)で実装する(T19)。絵文字は使用しない。
静的なボタン(キャプチャ・クリップボードコピー)は `index.html` に直接記述し、動的に生成するボタン
(矢印/モザイクツール、`src/ui/toolbar.ts`)は文字列定数として埋め込む。アイコンのみのボタンは
`aria-label`/`title` で意味(操作名 + ショートカットキー)を保持する。

---

## 8. 過去の問題事例

<!-- project-config.md セクション11 から展開。開発中に発見した問題を追記 -->

| 問題 | 原因 | 対策 |
| ---- | ---- | ---- |
| `thiserror::Error` を derive しただけのエラー enum は、実際に production コードから構築されるまで `cargo clippy -D warnings` の `dead_code` に引っかかる(T02 で発生) | `#[cfg(test)]` 内でのみ値を構築していても、非テストビルドでは construction が無いため dead code とみなされる | 雛形段階では該当バリアントに `#[allow(dead_code)]` + 理由コメントを付ける。実際に失敗しうるコマンド(T05以降)が使い始めた時点で `allow` を外す |
| 骨組みだけ先に作る新規モジュール(trait 定義・型・生成関数)は、呼び出し元(コマンド層)が未実装の間、モジュール内の `pub fn`/`pub trait`/`pub struct`/`pub use` すべてが `dead_code`/`unused_imports` に引っかかる(T03、`capture/` で発生)。`cargo test` は `#[cfg(test)] mod tests` 内の呼び出しがあるため通るが、`cargo clippy`(`--tests` 無し)はテストを見ないため別に警告が出る | `cargo clippy` の既定ターゲットはテストを含まないため、非テストコードから未参照の項目はすべて対象になる | 個々の型/関数に `#[allow(dead_code)]`(理由コメント付き)。サブモジュール丸ごと未使用なら `mod foo;` 宣言側に付けると配下全体に伝播する。再エクスポート(`pub use`)には別途 `#[allow(unused_imports)]` が要る。実装が追いつくタスク(例: T03→T05/T06)で `allow` を外す |
| macOSフレームワークのC関数(CoreGraphicsの `CGPreflightScreenCaptureAccess` 等)は戻り値がC `Boolean`(`unsigned char`)であり、Rustの `bool` とFFI境界での表現が異なる(T04で発生) | `Boolean` は 0=false/非0=true の `unsigned char`。Rustの `bool` をFFI越しに直接バインドすると未定義動作のリスクがある | `extern "C"` 宣言の戻り値型は `c_uchar`(`std::ffi::c_uchar`)で受け、0/非0を判定する純粋関数に変換ロジックを切り出してユニットテストする(`capture/permission.rs::to_permission`) |
| macOSフレームワークへ `#[link(name = ..., kind = "framework")]` でリンクする `extern "C"` ブロックを無条件に書くと、将来非macOS環境でビルドした場合にリンクエラーになりうる(T04で発生) | フレームワークリンクはOS依存であり、他OSには存在しない | `extern "C"` ブロックと、それを呼ぶ安全なラッパー関数の両方に `#[cfg(target_os = "macos")]` を付ける(本プロジェクトは `screencapture` CLI前提のためmacOS専用) |
| 一時キャプチャファイル(`capture::generate_capture_path` が生成するPNG)は起動時(`setup`)と終了時(`RunEvent::Exit`)に自動削除される(2026-09-24 人間決定で T05 時点の「削除しない」を改訂。ARCH §12) | スクリーンショットは機微情報を含みうるため(Phase 5 security MEDIUM / legal WARNING) | `capture::cleanup_capture_files()` が `tadcap-captures/` 直下の `*.png` のみ削除(非再帰・シンボリックリンクは辿らない・失敗はログのみ)。ファイルがセッションを跨いで残る前提のコードを書かない |
| `write_image_fallback` の入力には上限がある(各辺 16384px = `MAX_IMAGE_DIMENSION`、総バイト 256MiB = `MAX_IMAGE_BYTES`、`clipboard/mod.rs` で 1 か所定義) | release ビルドは overflow-checks 無効のため `width*height*4` がラップして長さ検証をすり抜けうる(Phase 5 security HIGH) | 乗算は `checked_mul`、上限は定数を参照し重複定義しない |
| PRD §5 の `Capture.createdAt`(`string(ISO8601)`)は、NFR-003(軽量性)により `chrono` 等の日付クレートを追加せず実現する必要があった(T06で発生) | ISO8601文字列の生成だけのために日付クレートを追加するのは過剰 | `SystemTime`/`Duration`(std)でミリ秒を取得し、Howard Hinnant の `civil_from_days` アルゴリズムを移植して年月日を求める(`commands.rs::iso8601_utc_from_unix_millis`)。既知のUNIXタイムスタンプでユニットテストする |
| `AppError` はメッセージ文字列としてのみシリアライズされる(T02決定)ため、フロントエンドがエラー種別を構造的に判別できない(T06で発生。`capture_screen` の権限未許可エラー) | `serde::Serialize` の手動実装が常に `serialize_str` を使うため、シリアライズ結果はオブジェクトではなく単なる文字列 | 判別が必要なバリアントは `Display` の出力を固定識別子文字列にする(例: `AppError::PermissionDenied` → `"permission_denied"`)。フロントは完全一致で分岐する |
| `tauri.conf.json` の `app.security.assetProtocol` を `{ "enable": true, "scope": [...] }` に設定しても、`src-tauri/Cargo.toml` の `tauri` 依存に `protocol-asset` featureを追加しないと `cargo build`/`cargo test` がビルドスクリプトの段階で失敗する(T07で発生。「tauri dependency features does not match the allowlist」エラー) | Tauri v2は `tauri.conf.json` の機能フラグとCargoのfeatureフラグの一致をビルドスクリプトで検証するため、設定ファイル側だけの変更では不十分 | `convertFileSrc()` でasset URLを使う場合は `Cargo.toml` の `tauri = { version = "2", features = ["protocol-asset"] }` を忘れずに追加する。`scope` はOS一時ディレクトリの専用サブディレクトリのみに限定するglob(`$TEMP/tadcap-captures/*`)にし、広いスコープにしない(ARCH §12)。**実機不具合②〜⑤の修正でasset protocol自体を撤去済み**(下の「Canvas汚染」行参照) |
| Vitestの既定 `environment` は `node` であり、`document`/`Image`/`HTMLCanvasElement` 等のDOM APIが存在しない(T07で確認。`vite.config.ts` の `test` に `environment` 未指定) | jsdom/happy-dom 等の追加依存を入れていない(NFR-003、依存を最小限に保つ方針) | DOM/Canvas APIに直接依存するコード(例: `src/canvas/render.ts`)はVitestで自動テストせず、手動確認チェックリストへ回す。ロジックをDOM非依存の純粋関数に切り出せる部分(例: エラーメッセージ組み立て、状態遷移)だけをテスト対象にする |
| Tauri v2では `async` を付けない `#[tauri::command]`、およびトレイの `on_menu_event`・グローバルショートカットの `with_handler` は既定でメインスレッド(UI・イベントループと同じスレッド)上で同期的に実行される(T16でPJMが指摘、公式ドキュメントで確認) | `screencapture -i` はユーザーの範囲選択が終わるまで戻らないブロッキング呼び出しのため、そのまま呼ぶとアプリ全体(UI含む)が固まる | `commands::capture_screen` を `async fn` 化し、`capture::run()` の呼び出しは `tauri::async_runtime::spawn_blocking` に包む。トレイ・グローバルショートカットのハンドラは `tauri::async_runtime::spawn` でキャプチャ処理を非同期タスクへ逃がし、完了後のウィンドウ操作だけ `AppHandle::run_on_main_thread` でメインスレッドへ戻す(詳細は下記9.5) |
| `tauri-plugin-opener` のRustネイティブ拡張トレイト経由の呼び出し(`AppHandle::opener().open_url()`、`OpenerExt`)は、`capabilities/default.json` のスコープ設定(`opener:allow-open-url` 等)を経由しない(T08で確認、`tauri-plugin-opener` 2.5.5のソースで検証) | スコープチェック(`Scope::is_url_allowed`)はプラグインが生成する `#[tauri::command] open_url` ハンドラ(JS側 `invoke()`/`openUrl()` 経由専用)の内部にのみ実装されており、Rustコードから直接呼ぶ `Opener::open_url()` はこのハンドラを経由しない | フロントエンドではなくRust側のコマンド(`commands::open_screen_recording_settings`)で固定URL文字列の定数のみを渡す設計にし、ユーザー入力・外部由来の値がこの経路に到達しないようにする。【T17で更新】`opener:default`(未使用の`allow-reveal-item-in-dir`・無制限`allow-default-urls`を含む)はYAGNIに反するため削除し、固定URL1件にスコープ限定した`opener:allow-open-url`のみを残した(このpermission自体は`default`が無くても独立して`open_url`コマンドを許可できる) |
| macOSの画面収録権限は、システム設定で許可した直後にアプリへ即座に反映されず再起動が必要になる場合があることが広く知られているが、Apple公式ドキュメントで一次情報を確認できなかった(T08) | TCCは権限状態をプロセス起動時にキャッシュする実装のOSバージョンが存在するとされる(一次情報未確認) | 【仮定】案内バナーの文言(`permissionBanner.ts::permissionBannerMessage()`)に再起動を促す文言を含めた。実機での要否確認は手動確認チェックリスト#2へ回す |
| `tauri.conf.json`の静的`assetProtocol.scope`(`$TEMP/tadcap-captures/*`)は、macOSでは実際のリクエストパスと一致しないおそれがある(T17で発見・修正) | `$TEMP`(`std::env::temp_dir()`)はcanonicalizeされないが、`Scope::is_allowed()`はリクエストパスを`std::fs::canonicalize`してから照合する。macOSは`$TMPDIR`が`/var/folders/...`でも`/var`は`/private/var`へのシンボリックリンクのため、実パスは`/private/var/folders/...`になり一致しない(実機`readlink /var`で確認) | `lib.rs::run()`の`setup()`で起動時にキャプチャ用ディレクトリをcanonicalizeし、`asset_protocol_scope().allow_directory()`で実体パスを動的に追加登録する(下記9.7参照)。**asset protocol撤去に伴い動的登録も撤去済み**。`read_capture_image` のパス検証も同じ理由で両辺を`canonicalize`してから比較する(`capture/tempfile.rs::resolve_capture_file_in`) |
| Dock非表示(Accessory)アプリの前面化は、macOS 14+の協調的activationにより別アプリが前面のとき(`screencapture -i`終了直後等)は`NSApplication::activate`/`set_focus`(`makeKeyAndOrderFront:`)が拒否されうる。加えて非アクティブのまま最後に`makeKeyAndOrderFront:`系を呼ぶと`orderFrontRegardless`の並び順が打ち消されうる(B2で発見。旧`BRING_TO_FRONT_STEPS`のactivate→orderFrontRegardless→set_focusを1回では前面化しない実機不具合が残った) | tao 0.35.3の`set_focus`実装・AppKitの`orderFrontRegardless`のドキュメント上の非対称性(通常のorder系は非アクティブアプリでは前面順を保証しない)・`screencapture`終了直後のOSによる直前アプリの再アクティブ化との競合、の3点が重なるため(`window_front.rs`冒頭のdoc commentに詳細) | `src-tauri/src/window_front.rs`に前面化処理を切り出し、`orderFrontRegardless`を手順の最後に置く・前面化の間だけ`NSFloatingWindowLevel`へ上げる・即時/150ms/350ms後に再試行し500ms後に通常レベルへ戻す、という計画(`front_plan()`)にした。`tauri`の`set_always_on_top`はtao内部で非同期実行(`DispatchQueue::main().exec_async`)になり手順の順序が崩れるため使わず、`NSWindow::setLevel`をメインスレッドで同期的に呼ぶ |
| asset URL(`convertFileSrc()`)を`<img>`で読んでCanvasへ描画すると、矢印・モザイク・コピー・履歴がすべて`SecurityError`で失敗する(実機不具合②〜⑤。E2Eは同一オリジンの相対パスで画像を配信していたため検出できなかった) | asset URLはwebviewのオリジン(dev: `http://localhost:1420`)と別オリジン。asset protocolは`Access-Control-Allow-Origin`を返すが(tauri 2.11.6 `src/protocol/asset.rs`)、`crossOrigin`無しの`<img>`はno-corsで読むためCanvasが汚染(tainted)され、`getImageData()`/`toBlob()`が例外になる | 画像はRustコマンドのバイト列(`tauri::ipc::Response`)→`Blob`→`URL.createObjectURL()`で読む(同一オリジン扱い)。E2Eのモックはasset URLを実機同様に別オリジンで配信し、例外・失敗表示が無いことを検証する(`e2e/fixtures/tauriMock.ts`) |
| Dock非表示(`Accessory`)アプリで、グローバルショートカット起点の撮影後に `show()` + `set_focus()` してもエディタが前面に来ない(実機不具合①) | taoの`set_focus`は`activateIgnoringOtherApps:`を呼ぶが、macOS 14+のactivateは協調的でOSが拒否しうる(`NSApplication::activate`のドキュメント)。ショートカット起点は`screencapture -i`終了後(前面は別アプリ)に要求するため拒否されやすく、非アクティブアプリの`makeKeyAndOrderFront`は他アプリのウィンドウより前に出ない | `tray.rs::BRING_TO_FRONT_STEPS`の順(最小化解除→`show()`→`NSApplication::activate`→`NSWindow::orderFrontRegardless`→`set_focus()`)で全起点共通に前面化する |
| `Uint8ClampedArray` を返す純粋関数(モザイクのピクセル化処理)を `new Uint8ClampedArray(data)`(他のTypedArrayからのコピー構築)で作ると、`new ImageData(data, sw, sh)` が要求する `Uint8ClampedArray<ArrayBuffer>` に対して `tsc` の型エラーになる(T10で発生) | TypeScriptの組み込みTypedArray型は `ArrayBufferLike` を汎用パラメータに持ち、コピー構築は入力側の型パラメータ(`ArrayBufferLike`)を引き継ぐため `ArrayBuffer` に確定しない。関数の戻り値型注釈を単に `Uint8ClampedArray` とすると、その広い型のまま呼び出し元へ伝播する | 新しい配列を返す場合は `new Uint8ClampedArray(length)` + `.set(source)`(`length` 版コンストラクタは常に `ArrayBuffer` 裏付け)で確保し、戻り値型注釈も明示的に `Uint8ClampedArray<ArrayBuffer>` にする(`src/canvas/tools/mosaicTool.ts::pixelateImageData`) |
| `.permission-banner { display: flex; ... }`(著者スタイルシート)がUA既定の`[hidden] { display: none }`を上書きし、`hidden`属性を付与してもバナーが常に可視状態になっていた(T13のE2Eで発見) | `!important`の無い宣言同士では、著者オリジンのルールがUAオリジンのルールより詳細度に関わらず常に優先されるため | T19で `src/styles.css` に `[hidden] { display: none !important; }` を追加して修正した。個別セレクタを`:not([hidden])`化する対症療法ではなく、`!important`で`[hidden]`を一元的に最優先にすることで同種の不具合を他要素にも作らないようにした |

---

## 9. Rust バックエンドパターン

### 9.1 コマンド集約とエラー型

- 新規の `#[tauri::command]` は必ず `src-tauri/src/commands.rs` に追加する(呼び出し口の一元化。他モジュールから直接コマンドを追加しない)
- 各コマンドの戻り値は `Result<T, crate::error::AppError>` とする
- `AppError` は `thiserror::Error` で `Display` を導出し、`serde::Serialize` は手動実装する(`thiserror` は `Serialize` を自動導出しないため。Tauri の `#[tauri::command]` はエラー型が `Serialize`(`Into<InvokeError>`)を実装していないとコンパイルできない)
- 新しい失敗ケースが増えたときだけバリアントを追加する(YAGNI。先回りしてバリアントを作らない)
- フロントエンドがエラー種別を判別する必要があるバリアントは、`Display`(`#[error("...")]`)の出力を固定の識別子文字列にする(例: `PermissionDenied` → `"permission_denied"`)。`AppError` はシリアライズ時に文字列化されるだけなので(上記)、動的なメッセージを持つ `Internal(String)` と混同しない固定値を選ぶ
- Tauriコマンド本体(`AppHandle` 等ランタイム型を引数に取る関数)は薄く保ち、変換・構築ロジック(エラー変換、レスポンス組み立て等)はランタイムに依存しない純粋関数へ切り出してユニットテストする(例: `commands::app_error_from_run_error`、`commands::capture_result_for`)。コマンド本体は実機/実プロセスに依存するため自動テスト対象外とし、純粋関数側でロジックの分岐網羅を担保する

### 9.2 macOSフレームワークへのFFI(CoreGraphics等)

- 第三者プラグインではなく直接 `extern "C"` 宣言でOS標準フレームワークを呼ぶ場合、`#[link(name = "<フレームワーク名>", kind = "framework")]` を `extern "C"` ブロックに付ける(追加クレート不要)
- `unsafe` はFFI関数の呼び出し(`unsafe { ... }`)のみに閉じ込め、公開する関数は安全な戻り値型に変換するラッパーにする。`unsafe` ブロックには何が安全かを示す `SAFETY:` コメントを付ける
- C の `Boolean`(`unsigned char`)等、Rustの `bool` と表現が異なる型はプリミティブ型(`c_uchar` 等)で受け取り、変換ロジックを独立した純粋関数に切り出してユニットテストする(FFI呼び出し自体はOS依存のため自動テスト対象外)
- macOS専用のFFIは `extern "C"` ブロックと呼び出し元の両方に `#[cfg(target_os = "macos")]` を付ける(例: `capture/permission.rs`)

### 9.3 外部プロセス起動・OSダイアログを実際に起動せずテストする

- 対話的な外部CLI(`screencapture -i` 等、実行すると画面選択UIが出るもの)を呼ぶロジックは、プロセス起動を `trait` の背後に隠す(例: `CaptureProvider`)。テストではモック実装に差し替え、実プロセスを起動しない
- OS権限確認等の実行環境に依存する値は、呼び出し元の関数に**注入**する(例: `capture::run_with(provider, check_permission: impl FnOnce() -> ScreenRecordingPermission)`)。新規traitは追加せず、クロージャ/関数ポインタで十分な場合はそちらを使う(過剰な抽象化を避ける)
- 「プロセスの終了コード」ではなく「副作用の結果(生成物ファイルの有無等)」で分岐を判定するロジックは、プロセス起動を伴わない純粋関数として切り出す(例: `screencapture.rs::outcome_for(dest: &Path) -> CaptureOutcome`)。こうすることでOS依存の分岐(Escキャンセル等)も高速・決定論的にユニットテストできる

### 9.4 日付クレートを追加せず ISO8601(UTC)文字列を生成する

- NFR-003(軽量性)で日付クレート(`chrono` 等)を避けたい場合、`SystemTime::now().duration_since(UNIX_EPOCH)` でミリ秒を取得し、Howard Hinnant の `civil_from_days` アルゴリズム(整数演算のみでうるう年・月末日数を正しく扱える)を移植して年月日を求める(`commands.rs::iso8601_utc_from_unix_millis` / `civil_from_days`)
- 既知のUNIXタイムスタンプ(1970-01-01=0、2000-01-01=946684800、2024-01-01=1704067200、うるう日 2020-02-29=1582934400 等)を固定値としてユニットテストし、アルゴリズム移植の正しさを担保する

### 9.5 ブロッキング処理をメインスレッド外へ逃がす(T16)

- Tauri v2では `async` を付けない `#[tauri::command]` は既定でメインスレッド実行される。トレイの `on_menu_event`・グローバルショートカットの `with_handler` も同じメインスレッド(イベントループ)上で同期的に呼ばれる。対話的な外部プロセス(`screencapture -i` 等、ユーザー操作が終わるまで戻らないもの)をこれらの中で直接呼ぶとUIごと固まる
- コマンドは `async fn` にし、実際のブロッキング呼び出し(例: `capture::run()`)は `tauri::async_runtime::spawn_blocking(...)` へ包んで `.await` する(コマンド自体を `async` にするだけでは、内部の同期ブロッキング呼び出しが async ランタイムのワーカースレッドを塞ぐ可能性が残るため)
- トレイ・グローバルショートカットのイベントハンドラ(戻り値を返せず `Fn` として同期的に呼ばれる箇所)は `tauri::async_runtime::spawn(async move { ... })` で非同期タスクへ切り出し、ハンドラ自体は即座に処理を返す(`src-tauri/src/tray.rs::run_capture_and_show_editor`)
- ウィンドウ操作(`window.show()`/`set_focus()`)はメインスレッド必須のため、非同期タスク側から直接呼ばず `AppHandle::run_on_main_thread(closure)` でメインスレッドへ戻して実行する。`emit()` はスレッドに依存しないため(async コマンドの内部から呼ぶのが標準的な使い方)、`run_on_main_thread` を経由しなくてよい
- 複数起点(アプリ内ボタン・トレイ・グローバルショートカット)が同じブロッキング処理を共有する場合、`AtomicBool` の `compare_exchange` による最小限の実行中排他フラグ(`commands.rs::try_begin_capture`/`end_capture`)で多重起動を防止する。専用の状態機械やMutexロックは導入しない(過剰設計を避ける)
- OS起点(トレイ・グローバルショートカット・AppKit操作等)の診断ログは `[tadcap:<領域>]` に続けて `key=value` を空白区切りで stderr に出す(例: `[tadcap:latency]`、B2で追加した `[tadcap:front]`)。ログ文字列の整形は純粋関数(`format_front_log()` 等)に切り出し、実際のOS呼び出しと分離してユニットテストする

### 9.6 大きなバイナリ引数は生ボディ(`tauri::ipc::Request`)で受け取る(T12)

- 通常の `#[tauri::command]` 引数(`Vec<u8>` 等)はフロント→バックエンドの送信時にJSONへシリアライズされ、バイト列は要素ごとにカンマ区切りの10進数文字列(数値配列)へ展開される。数MB〜数十MBのRGBA画像等を渡す場合、この展開でペイロードが数倍に膨らむ
- 公式ドキュメント(<https://v2.tauri.app/develop/calling-rust/#accessing-raw-request>)が案内する「生ボディ」を使うとこれを避けられる: コマンド引数を `tauri::ipc::Request<'_>` にし、`request.body()` を `let InvokeBody::Raw(bytes) = ... else { ... }` で分岐して取り出す。フロント側は `invoke(cmd, uint8ArrayOrArrayBuffer, { headers: {...} })` のように第2引数(payload)へ `ArrayBuffer`/`Uint8Array` を直接渡す(オブジェクトのフィールドとして渡すとこの経路には乗らない)
- 付随する数値等(例: 画像の`width`/`height`)はボディに混在させず `invoke()` 第三引数の `headers` で渡し、Rust側は `request.headers().get("...")` で読む(`&str` は `AsHeaderName` を実装しているため `http::HeaderName` 型を直接扱わなくてよい)
- `tauri::ipc::Request<'_>` は `CommandArg` を実装しているため `async fn` コマンドの引数としても使える。ただしライフタイム`'a`は呼び出し1回分に閉じているため、`.await` をまたいで使う値(バイト列・ヘッダー値)は `.clone()`/`.to_string()` 等で所有権のある値に変換してから `spawn_blocking` 等へ渡す(`commands.rs::write_image_fallback`)
- ヘッダー値のパース(欠落・非数値の判定)は `Request` に依存しない純粋関数(`parse_image_dimensions(width: Option<&str>, height: Option<&str>)`)に切り出し、`Request` 自体を構築できないユニットテストでも検証できるようにする

### 9.7 Capabilities最小化とasset protocol scopeの実体パス補強(T17)

- `capabilities/*.json` には実際に `invoke()`/プラグインJS APIから呼ぶコマンドの permission だけを列挙する。自前の `#[tauri::command]`(`generate_handler!` に渡すだけの、プラグイン由来ではないコマンド)は `src-tauri/permissions/` を用意しない限りACLの対象外で、permission定義なしに呼び出せる(Tauri公式ドキュメントは permission の説明を一貫して「プラグイン開発者」視点で書いており、自前コマンドへの適用は任意のオプトインという扱い)
- Rustネイティブ拡張トレイト経由の呼び出し(`OpenerExt::open_url()`、`GlobalShortcutExt::register()`、`TrayIconBuilder` 等)はIPC層を経由しないため capabilities 不要(T08/T15/T16の既存判断どおり、T17で再確認)
- 「将来使うかもしれない」を理由に広い permission(例: `opener:default` の無制限 `allow-default-urls`)を先取りで残さない(YAGNI)。実際に使っている経路にスコープを合わせ、必要になった時点で個別に追加する
- (実機不具合②〜⑤の修正でasset protocolと下記の動的登録は撤去済み。記録として残す)`assetProtocol.scope`(`tauri.conf.json`)は `$TEMP` 等の変数を文字列展開するだけで正規化(canonicalize)しないが、`Scope::is_allowed()` はwebviewからの実リクエストパスを`canonicalize`してから照合する。macOSでは `$TMPDIR` が `/var/...` でも `/var` は `/private/var` へのシンボリックリンクのため、静的スコープだけでは実際のリクエストパスと一致しないおそれがある。起動時(`setup()`)にディレクトリを作成・`canonicalize()`したうえで `app.asset_protocol_scope().allow_directory(&canonical, false)`(`tauri::Manager`)を呼び、実体パスを動的に追加登録することで解決する(`lib.rs::run()`)

---

## 10. フロントエンドIPC連携パターン(`src/ipc/`、T07〜)

### 10.1 `@tauri-apps/api` をモックしてIPCラッパーをテストする

- `src/ipc/*.ts` は `invoke()`/`listen()` を直接呼ぶ薄いラッパーのため、Tauriランタイム無しでは実行できない。Vitestでは `vi.mock("@tauri-apps/api/core", () => ({ invoke: ... }))` / `vi.mock("@tauri-apps/api/event", () => ({ listen: ... }))` でサブパスごとにモックする(`vi.mock` はファイル先頭へホイストされるため、モック定義は対象モジュールの `import` より前に書けばよい)
- `invoke()` の戻り値/reject値をそのままテストで検証する(例: `capture.test.ts` の `startCapture()` テストは成功時オブジェクト・Escキャンセル時`null`・失敗時reject文字列の3分岐を検証する)。`listen()` は登録したコールバックを `vi.fn()` で捕まえ、手動で呼び出してpayloadがハンドラへ伝達されることを検証する
- Rust側コマンドの戻り値/エラー形式(`docs/project.md` の「IPCコマンド一覧」参照)とフロント側の型定義(`src/ipc/*.ts`)は手動で同期する。型生成ツール(`tauri-specta` 等)は導入していない(NFR-003、MVP規模では手動同期で十分と判断)

### 10.2 Canvas反映の主経路はイベント購読

- キャプチャ結果をCanvasへ反映する主経路は、コマンドの戻り値ではなく `capture://completed` イベント購読(`onCaptureCompleted()`)にする。理由はアプリ内ボタン起点・グローバルショートカット起点(T16)・トレイメニュー起点(T15)のいずれも同じ経路で処理できるようにするため(ARCH §5.2)。コマンドの戻り値(`startCapture()` の戻り値)は成功/エラー確認用に留め、Canvas更新ロジックを重複させない

### 10.3 クリップボード書込(プラグイン優先→Rustフォールバック)はRGBA8で統一する(T12)

- `@tauri-apps/plugin-clipboard-manager` の `writeImage()` に `Uint8Array`/`ArrayBuffer`/`number[]` を直接渡すと「PNG/ICOの生バイト列」として解釈され(`tauri`公式パッケージの `JsImage::Bytes`)、デコードに `tauri` クレートの `image-png`/`image-ico` Cargo featureが必要になる(公式ドキュメント <https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/image.ts> のdoc comment参照)。一方 `@tauri-apps/api/image` の `Image.new(rgba, width, height)` は生RGBA8ピクセル列を直接受け付け「追加Cargo feature不要」と明記されている
- Rustフォールバック(`arboard::Clipboard::set_image`)はPNG/ICO等のデコードを行わず、生のRGBA8ピクセル列(`arboard::ImageData { width, height, bytes }`)のみを受け付ける。PNGバイト列のままフォールバックへ渡すには別途デコード用クレート(`image`/`png`等)が必要になり、これはARCH §2・§15決定#3が承認した追加依存(`arboard`のみ)の範囲外になる
- 以上より、主経路(`Image.new()` 経由の `writeImage()`)・フォールバック(`write_image_fallback`)のいずれもCanvasの `getImageData()` 由来のRGBA8をそのまま使う設計にした(`src/canvas/render.ts::getCanvasImageData()` → `src/ipc/clipboard.ts::copyToClipboard()`)。PNGのエンコード/デコードの往復が発生せず、追加のCargoクレート・featureも不要になる(NFR-003)。ARCH §5.2の `copyToClipboard(pngBytes)` という名称・PNG想定からの変更点であり、実装時の技術的制約による意図的な逸脱として記録する(project-config.md §11参照)
