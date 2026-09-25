# アーキテクチャ

> **これはテンプレートです。** セットアップ直後は空の状態です。
> 以下のいずれかの方法で内容が生成されます:
> - `/architecture` スキル実行時に自動生成
> - `/implementing-features` スキル実行時に自動更新
> - PJMチームのPhase 2で自動生成
>
> **生成方法**: `project-config.md` セクション4 を基にAIが初期生成する。
> 以降は実装の変更に応じてAI・人間が協調メンテナンスする。

## エントリーポイント

<!-- プロジェクトのエントリーポイントとプロバイダー構成を記述 -->

### Rust バックエンド(`src-tauri/src/`)

- `main.rs` → `lib.rs::run()`: `tauri::Builder` を組み立てるエントリーポイント。プラグイン登録(`opener`, `clipboard-manager`(T12)含む)・`setup()`(Dockアイコン非表示 → トレイ構築 → グローバルショートカット登録、T15・T16)・`on_window_event`(ウィンドウを閉じてもプロセス継続、T15)・`invoke_handler`(`commands::greet`, `commands::capture_screen`, `commands::check_screen_recording_permission`, `commands::open_screen_recording_settings`、`commands::write_image_fallback`(T12)を組み立てる。`shortcuts::register_capture_shortcut(app)?` は `#[cfg(desktop)]` ガード付きで `tray::build_tray(app)?` の直後に呼ぶ(ARCH §11 の順序どおり、T16)
- `commands.rs`: `#[tauri::command]` 関数を集約するモジュール。新規コマンドは必ずここに追加し、呼び出し口を一元化する(ARCH §3.2)。`capture_screen`(T06、T16で `async fn` 化)は `run_capture()`(T16で `run_capture_and_notify()` から改称・非同期化した共通関数)に処理を委譲する。`run_capture()` は3起点(ボタン/トレイ/ショートカット)共有の実行中排他フラグ(`CAPTURE_IN_PROGRESS: AtomicBool`、`try_begin_capture()`/`end_capture()`)で多重起動を防いだうえで、`capture::run()` を `tauri::async_runtime::spawn_blocking` に包んで実行し(メインスレッド・非同期ワーカーいずれもブロックしない、T16でPJM指摘のスレッド問題に対応)、成功時(画像取得できた場合のみ)`capture://completed` イベントで `CaptureResult` を送出する(ARCH §5.2・§7.1、`tauri::Emitter` トレイトの `AppHandle::emit()` を使用)。アプリ内ボタン(`capture_screen`)・トレイメニュー「キャプチャ」(`tray.rs`、T15)・グローバルショートカット(`shortcuts.rs`、T16)の3経路がこの共通関数を呼ぶため、キャプチャ処理の実装はここに一元化されている。`RunError → AppError` 変換(`app_error_from_run_error`)・`CaptureOutcome → CaptureResult` 構築(`capture_result_for`)・識別子生成(`id_from_path`、一時ファイル名をそのまま流用)・ISO8601(UTC)日時生成(`iso8601_utc_from_unix_millis` / `civil_from_days`、Howard Hinnant のアルゴリズムを `chrono` 等のクレートを使わず std のみで実装)はいずれも Tauri ランタイムに依存しない純粋関数として切り出し、実際に `screencapture` を起動せずユニットテストしてある。T08で `check_screen_recording_permission`(`async fn`。`capture::ensure_screen_recording_access()` を `spawn_blocking` 経由で呼ぶ)・`open_screen_recording_settings`(同期。固定URL定数 `SCREEN_RECORDING_SETTINGS_URL` のみを `tauri_plugin_opener::OpenerExt::opener().open_url()` へ渡す、ARCH §12)を追加した。T12で `write_image_fallback`(`async fn` + `spawn_blocking`。`tauri::ipc::Request` の生ボディ(`InvokeBody::Raw`)+ ヘッダー(`IMAGE_WIDTH_HEADER`/`IMAGE_HEIGHT_HEADER`)でRGBA8画像を受け取り `clipboard::write_image_fallback()` へ委譲)を追加した。ヘッダー文字列のパース(`parse_image_dimensions()`)・エラー変換(`app_error_from_clipboard_error()`)は純粋関数として切り出しユニットテスト対象(`Request` 自体はTauriランタイム依存のため直接構築せずテストしない)。実機不具合②〜⑤の修正で `read_capture_image`(`async fn` + `spawn_blocking`。`capture::read_capture_file()` でキャプチャ専用ディレクトリ直下のPNGだけを読み、`tauri::ipc::Response` で生バイナリを返す)を追加した(asset protocolは撤去)
- `error.rs`: コマンド共通エラー型 `AppError`(`thiserror` で `Display` 導出、`serde::Serialize` は手動実装。理由は `AppError` の doc comment 参照)。各コマンドは `Result<T, AppError>` を返す。`Internal(String)`(一般エラー)に加え、`PermissionDenied`(T06)は `Display` の出力を固定文字列 `"permission_denied"` にすることで、文字列シリアライズのままフロントエンドが判別できるようにしてある
- `tray.rs`(T15): メニューバー常駐トレイを構築するモジュール(FR-009)。`build_tray()` が `TrayIconBuilder`/`Menu`/`MenuItem`(Tauriコア機能 `tray-icon` feature)で「キャプチャ/エディタを開く/終了」3項目メニューを構築し、`on_menu_event` からメニューIDを判定する純粋関数 `tray_menu_action_from_id()` を経由して分岐する(ID判定ロジックのみユニットテスト対象、実際のトレイ・ウィンドウ操作は手動確認チェックリスト#4・#7)。「キャプチャ」選択時、および `shortcuts.rs`(T16)のショートカット押下時はいずれも `run_capture_and_show_editor()` を呼ぶ(T15で切り出し、T16で共有)。同関数は `tauri::async_runtime::spawn` でキャプチャ処理(`commands::run_capture()`)を非同期タスクへ逃がし、完了後に結果に応じて `window_front::bring_main_window_to_front()`(B2、`window_front.rs`)でエディタウィンドウを前面表示する。結果ごとの後続処理は純粋関数 `capture_follow_up()` で決める。失敗時は `capture://error` イベント(`CAPTURE_ERROR_EVENT`、ARCHに規定が無いためT15で最小追加)でエラー種別をフロントへ伝える。「終了」は `app.exit(0)` を呼び、ウィンドウの✕ボタン(`on_window_event`の`hide()`)とは異なる唯一の終了経路にしてある
- `window_front.rs`(B2): エディタウィンドウを前面に出す処理を `tray.rs` から切り出したモジュール。トリガー(`FrontTrigger::UserMenu`/`AfterCapture`)ごとに手順列を返す純粋関数 `front_plan()`・試行結果から次の試行indexを決める `next_attempt_index()`・診断ログ1行を整形する `format_front_log()` はTauri/AppKitに依存しないユニットテスト対象。`AfterCapture`(ショートカット等、activateが拒否されうる前提)は `RaiseLevel`(`NSFloatingWindowLevel`)→`OrderFrontRegardless` を即時・150ms後・350ms後に再試行し、500ms後に `RestoreLevel`(通常レベル)へ戻す計画(`AFTER_CAPTURE_PLAN`)。実際のAppKit呼び出し(`activate_app`/`set_floating`/`order_front_regardless`/`snapshot`)は `native` サブモジュール(`#[cfg(target_os = "macos")]`)に閉じ込め、非macOSではno-opにフォールバックする。診断ログは `[tadcap:front]`(`format_front_log()`)で stderr に出す
- `shortcuts.rs`(T16): グローバルショートカット(既定 `Cmd+Shift+2`、FR-004)を登録するモジュール。`register_capture_shortcut()` が `tauri_plugin_global_shortcut::Builder` でプラグインを登録し、`GlobalShortcutExt::global_shortcut().register()` でキーを登録する。押下時(`ShortcutState::Pressed` のみ処理、`should_handle_shortcut_event()`)は `tray::run_capture_and_show_editor()` を呼ぶだけで、キャプチャ処理自体は実装しない(重複実装回避)。他アプリが既にキーを使用している等で `register()` が失敗しても `eprintln!` でログ出力するのみでアプリの起動は継続する(PJM指摘対応)。`default_capture_shortcut()`(キー構成)・`should_handle_shortcut_event()`(Pressedのみ処理する判定)はTauriランタイムに依存しない純粋関数としてユニットテスト対象。実際のキー登録・押下・前面表示はOSネイティブ導線のため手動確認チェックリスト#3へ
- `clipboard/`(T12、FR-005): クリップボード書込のRustフォールバックを閉じ込めるモジュール。`mod.rs` が `validate_rgba(width, height, bytes)`(`width`/`height`が0、または`bytes.len()`が`width*height*4`と不一致なら`ClipboardFallbackError`を返す純粋関数。空バイト列・不正長を含めユニットテスト対象)・`write_image_fallback(width, height, bytes)`(検証後に`arboard::Clipboard::new()`/`set_image()`でOSクリップボードへ書込。実OS呼び出しは自動テスト対象外、手動確認チェックリスト#5)を提供する。`commands::write_image_fallback`から呼ばれる
- `capture/`: キャプチャ機能を閉じ込めるモジュール(ARCH §3.1・§4、T03)。`mod.rs` が `CaptureProvider` trait(`capture(&self, dest: &Path) -> io::Result<CaptureOutcome>`)・`CaptureResult`・`CaptureKind` を定義し、`tempfile.rs` が OS一時ディレクトリ配下の専用サブディレクトリ(`tadcap-captures/`)に一意なファイルパスを生成する。`permission.rs`(T04)は macOS の `CoreGraphics` フレームワークへ `extern "C"` 宣言で直接 FFI し(第三者プラグイン不使用、ARCH §15 決定#1)、`preflight_screen_recording_access()` で画面収録権限を確認する安全なラッパーを提供する。`request_screen_recording_access()`(`CGRequestScreenCaptureAccess`)はT08で `mod.rs::ensure_screen_recording_access()` から実使用を開始し(未許可時のみ1回呼ぶ純粋関数 `ensure_screen_recording_access_with()` に権限確認・要求の両方を注入してテストする、`run_with()` と同じ設計方針)、`commands::check_screen_recording_permission` から呼ばれる。`unsafe` は2関数の呼び出しのみに閉じ込め、追加クレートは使わない。`screencapture.rs`(T05)が `screencapture -i <dest>` を起動する `ScreenCaptureCli`(`CaptureProvider` 実装)を提供し、プロセス終了後に `dest` の存在有無で `Completed`/`Cancelled` を判定する(Escキャンセルはエラー扱いしない)。`mod.rs::run()`(T05〜T06)が権限事前確認 → 未許可なら `RunError::PermissionDenied` を返し起動しない → 一時ファイルパス生成 → `ScreenCaptureCli::capture()` の順で結線し、`Result<(CaptureOutcome, PathBuf), RunError>` を返す(T06 で戻り値に生成済み一時ファイルパスを追加し、`commands::capture_screen` が `CaptureResult.source_path` を構築できるようにした)。権限確認・プロセス起動の両方を注入可能な非公開の `run_with()` に処理を切り出し、実際に `screencapture` を起動せず・実OS権限にも依存せずユニットテストできるようにしてある。`commands.rs` からの呼び出し(T06、T16で `spawn_blocking` 経由に変更)を結線済み

### フロントエンド(`src/`、T07〜)

- `main.ts`: `DOMContentLoaded` でキャプチャボタン(`ui/captureButton.ts::initCaptureButton()`)・権限バナー(`ui/permissionBanner.ts::initPermissionBanner()`、T08)を初期化し、起動直後から `ipc/capture.ts::onCaptureCompleted()` を購読開始する(ARCH §11 フロントエンド初期化順序#1・#2。グローバルショートカット・トレイ起点(T15・T16)の結果も同じ購読で受信するため)。イベント受信時は `ipc/capture.ts::readCaptureImage(sourcePath)`(バイト列→`Blob`)→ `URL.createObjectURL()` → `canvas/render.ts::loadImage()` → `renderImageToCanvas()` → `canvas/canvasState.ts::setCanvasImage()` の順で Canvas に反映する(ARCH §7.1 手順5)。T08で画面収録権限未許可の案内バナーを表示する3つの入口(①ボタンの `invoke` reject、②`ipc/capture.ts::onCaptureError()` が購読する `capture://error` イベント、③起動時の `ipc/permissions.ts::checkScreenRecordingPermission()`)をすべて結線し、いずれも同じ `permissionBanner.showDenied()` を呼ぶ(PJM決定 2026-09-23)。T09で `ui/toolbar.ts::initToolbar()`(`#tool-toolbar` 要素)と `canvas/tools/arrowTool.ts::bindArrowTool()`(`#capture-canvas` へのポインタイベント結線)を追加し、T10で同じCanvasへ `canvas/tools/mosaicTool.ts::bindMosaicTool()` を、T25で `canvas/tools/rectangleTool.ts::bindRectangleTool()` を、T26で `canvas/tools/ellipseTool.ts::bindEllipseTool()` を追加結線した(矢印・矩形・円・モザイクは `canvasState.activeTool` で排他的に動作するため、同一Canvasへの多重結線でも競合しない)。T31【改訂 2026-09-24】で矢印・矩形・円の3結線を `canvas/tools/shapeTools.ts::bindShapeTools()` に統合し、`ui/pendingShapeKeys.ts::bindPendingShapeKeys()`(Enter確定/Esc破棄)を追加した。`handleCaptureCompleted()`・`captureCurrentHistoryAssets()`(履歴切替)・`getClipboardPayload()`(コピー)は処理の先頭で `canvas/pendingShape.ts::commitPendingShape()` を呼び、編集中の図形を確定してから保存・コピーする。T27で`canvas/tools/textTool.ts::bindTextTool()`を追加結線し、同じ3箇所で`commitPendingText()`(入力中のテキストを確定)を`commitPendingShape()`の前に呼ぶ。T12で `ui/clipboardButton.ts::initClipboardButton()` を追加し、`getClipboardPayload()`(`canvasEl` から `canvas/render.ts::getCanvasImageData()` でRGBA8を取得)を結線する。T28で`ui/colorPicker.ts::initColorPicker()`(`#color-picker`)・`ui/fontSizePicker.ts::initFontSizePicker()`(`#font-size-picker`)を、T29で`ui/undoButton.ts::initUndoButtons()`(`#undo-button`/`#redo-button`)を追加結線した(Undo/Redoスタックのクリアは既存の`clearUndoStack()`呼び出し(T24)のまま)。T32【改訂 2026-09-24】で`canvas/documentState.ts::setDocumentSurface(createDocumentSurface(canvasEl))`を結線し、画像差し替え(`handleCaptureCompleted`/`reloadHistoryItemIntoCanvas`)は`renderImageToCanvas()`直後の`resetDocument()`(ベース取り込み+オブジェクト・Undo/Redoのクリア)に置き換えた。`commitPendingShape()`の呼び出しは廃止(表示canvasは常に合成結果)、`bindPendingShapeKeys()`は`ui/selectionKeys.ts::bindSelectionKeys()`(Enter/Esc=選択解除)に置き換えた
- `ipc/capture.ts`: `startCapture()`(`invoke("capture_screen")` の薄いラッパー)、`onCaptureCompleted()`(`capture://completed` イベント購読)、`onCaptureError()`(`capture://error` イベント購読、T08で追加。トレイ・グローバルショートカット起点の失敗をペイロード文字列のまま通知)、`readCaptureImage()`(`read_capture_image` を呼び `image/png` の `Blob` を返す。asset URLは webview と別オリジンでCanvasを汚染するため使わない、実機不具合②〜⑤)を提供する。Canvas反映の主経路は `onCaptureCompleted()` 側(コマンドの戻り値は成功/エラー確認用、T07仕様)
- `ipc/permissions.ts`(T08、NFR-002): `checkScreenRecordingPermission()`(`check_screen_recording_permission` コマンド呼び出し)・`openScreenRecordingSettings()`(`open_screen_recording_settings` コマンド呼び出し)・`isPermissionDeniedError()`(`invoke` reject値/イベントpayloadが固定文字列 `"permission_denied"` と一致するかを判定する純粋関数)を提供する。`PermissionState`(`"unconfirmed" | "granted" | "notGranted"` の3値、ARCH §6.1)型もここで定義する
- `ipc/clipboard.ts`(T12、FR-005): `copyToClipboard(payload)` を提供する。`payload`(`ClipboardImagePayload = { rgba, width, height }`、Canvasの`getImageData()`由来)をまず `@tauri-apps/api/image::Image.new()` + `@tauri-apps/plugin-clipboard-manager::writeImage()`(主経路)で書込み、失敗時のみRustコマンド `write_image_fallback` へ`invoke()`の生ボディ渡し(`payload.rgba`を第2引数にそのまま渡し、`width`/`height`はヘッダーで渡す)で切り替える。両方失敗した場合は両エラーを保持する `ClipboardCopyError` をrejectする。ARCH §5.2は `copyToClipboard(pngBytes)` の名称でPNGバイト列を想定していたが、`arboard`がPNGデコードを行わないため実装時にRGBA8ベースの設計へ変更した(project-config.md §11参照)
- `canvas/canvasState.ts`: 現在Canvasに表示中の画像(`CanvasImage | null`)・選択中ツール(`activeTool: ToolId | null`)・描画中フラグ(`isDrawing`)を保持するモジュール単位の薄い状態オブジェクト(ARCH §1.3 決定#1)。`createCanvasState()`/`withImage()`/`withoutImage()`/`withActiveTool()`/`toggleTool()`/`withDrawing()` は純粋関数、`getCanvasState()`/`setCanvasImage()`/`clearCanvasImage()`/`setActiveTool()`/`toggleActiveTool()`/`setDrawing()`/`subscribeCanvasState()` がシングルトンストアとして公開される。`toggleTool()`/`toggleActiveTool()` は同じツールを再指定すると選択解除する(トグル、T09)。`ToolId = "arrow" | "mosaic" | "rectangle" | "ellipse"`(T09で型定義、T10で `ui/toolbar.ts` に `"mosaic"` の選択肢を追加し選択可能にした。T25で`"rectangle"`を、T26で`"ellipse"`を追加)
- `canvas/render.ts`: `loadImage()`(URL(同一オリジン扱いのObjectURLに限る)から `HTMLImageElement` を読み込む)と `renderImageToCanvas()`(画像の原寸に合わせてCanvasサイズを設定し描画する)を提供する。T12で `getCanvasImageData()`(Canvasの現在ピクセルをRGBA8で取得、クリップボードコピー用)を追加した。DOM/Canvas APIに直接依存するためVitestの既定環境(Node)では自動テスト対象外とし、手動確認チェックリスト#1・#5で目視・実クリップボード確認する(project-config.md §11参照)
- `canvas/coords.ts`(T09。T20【改訂 2026-09-24】、T25【改訂 2026-09-24】): CSS表示座標(`PointerEvent.clientX/Y`)→Canvasピクセル座標(画像の実ピクセル)への変換。`clientToCanvasPoint()` はDOM型に依存しないプレーンな数値入力の純粋関数としてユニットテスト対象(`window.devicePixelRatio` は変換に登場しない。理由はproject-config.md §11参照)。T20で`tools/mosaicTool.ts`から`Rect`型・`normalizeRect()`(逆方向ドラッグの正規化)・`clipRectToCanvas()`(Canvas範囲へのクリップ)を移設した(挙動不変。矩形・円ツールが同じ純粋関数を再利用するため、ARCH §5.2)。T25で`tools/arrowTool.ts`/`tools/mosaicTool.ts`から`roundRect()`・`cropSnapshotRect()`も移設した(矩形ツールが3ファイル目の利用者になりRule of Threeで集約、挙動不変。太さ比率自体はツールごとにローカルのまま)
- `canvas/toolSettings.ts`(T21【新設 2026-09-24】、FR-013): 矢印・矩形・円・テキスト共通の現在色(既定`#FF5C8A`)・テキストのフォントサイズ段階(`"small" | "medium" | "large"`、既定`"medium"`)を保持するモジュール単位の薄い状態オブジェクト(`canvasState.ts`と同じ作法)。`createToolSettings()`/`withColor()`/`withFontSize()`は純粋関数、`getToolSettings()`/`setColor()`/`setFontSize()`/`subscribeToolSettings()`がシングルトンストアとして公開される。`isValidColorCode()`(`#RRGGBB`形式かどうかの判定)は独立した純粋関数としてユニットテスト対象(PRD §8)。`setColor()`自体はこの検証をゲートしない(プリセット・ネイティブカラーピッカーは常に正しい形式を渡すため)。モザイクは本ストアを参照しない(FR-013)
- `canvas/undoStack.ts`(T23【新設 2026-09-24】、FR-014): 焼き込み操作(矢印/矩形/円/テキスト/モザイク)ごとの差分(変更矩形+ピクセルデータ)を保持するUndo/Redoスタック(ARCH §6.4 B案、差分方式。Canvas全体のスナップショットは保持しない)。`createUndoStackState()`/`withPushedUndoStep()`/`withPoppedUndo()`/`withPoppedRedo()`/`canUndoState()`/`canRedoState()`は純粋関数、`getUndoStackState()`/`pushUndoStep(rect, before)`/`popUndo(currentImage)`/`popRedo(currentImage)`/`canUndo()`/`canRedo()`/`clearUndoStack()`/`subscribeUndoStack()`がシングルトンストアとして公開される。`pushUndoStep()`が呼ばれる時点(焼き込み前)では焼き込み後のピクセルが存在しないため、`popUndo()`/`popRedo()`は「書き戻す直前に呼び出し側がCanvasから読み取った現在のピクセル(`currentImage`)」を引数に取り、対になるスタックへ積む設計にした(ARCH §5.2はUndo単方向のみ記述していたため、PRD §10決定#9のRedo追加を踏まえた設計判断。モジュールdoc参照)。`ImageData`がVitestのnode環境に無いため`{data: Uint8ClampedArray, width, height}`相当の`ImageDataLike`型で扱う(`mosaicTool.ts`と同じ方針)。件数上限`UNDO_STACK_LIMIT`(30件、超過分は最も古いものから破棄)はUndo・Redo双方に適用する(PRD §11リスク)。`clearUndoStack()`の呼び出し自体は`main.ts`側の責務で、T24で`handleCaptureCompleted`(新規Capture読込完了後)・`reloadHistoryItemIntoCanvas`(履歴項目再読込完了後)に配線した。`Rect`型は【改訂 2026-09-24、T24】`coords.ts`から再importする形に統一した(`ImageDataLike`型は同形の既存型がコードベース内に無いため本ファイルの定義のまま)。T32【改訂 2026-09-24】で要素を`DocumentCommand`(`commands.ts`)に変更し、API を `pushCommand(command)`/`popUndo(apply)`/`popRedo(apply)`(`apply`が返したコマンドを反対側へ積む)にした。`ImageDataLike`は`commands.ts`へ移設(本ファイルは再export)
- `canvas/tools/arrowTool.ts`(T09、FR-006。T24【改訂 2026-09-24】テーパー形状化、T25追補【改訂 2026-09-24】太さ・矢じり・シャドウ改訂): 矢印ツール。`arrowLineWidth()`(Canvas対角線からの線幅算出。T25追補で比率0.0035→0.009・下限2→6px・上限14→48pxへ引き上げ、典型サイズ2000x1000で20px前後)・`arrowHeadLength()`(矢じり長=胴×3、T25追補で比率4→3)・`arrowHeadWidth()`(矢じり幅=胴×2.4、T25追補で新設)・`arrowShadowParams()`(ドロップシャドウのぼかし半径=胴×0.3・下方向オフセット=胴×0.25、T25追補で新設)・`computeArrowGeometry()`(矢じり3点の算出。T25追補で開き角30°の三角関数から、進行方向に直交する軸への直接オフセットへ再設計し`headWidth`を独立制御可能にした)は純粋関数としてユニットテスト対象。`computeTaperArrowPolygon()`(始点→終点で徐々に太くなる7頂点の単一多角形、始点側太さ=終点側太さ×`START_WIDTH_RATIO`(T25追補で0.25→0.15、常に終点側以下へクランプ))・`computeTaperArrowBoundingRect()`(多角形の外接矩形を余白付き・整数・Canvas範囲内クリップ済みで算出。T25追補で余白にシャドウのぼかし×2+オフセット分を追加)も同様。T31【改訂 2026-09-24】で`arrowLineWidth()`の比率・上下限を1.5倍(0.0135・9px・72px、典型2000x1000で30px)にし(矢じり・影は胴幅比で追従)、ポインタ結線`bindArrowTool()`は`shapeTools.ts`へ統合して描画関数`drawTaperArrowPolygon()`をexportした。以下は旧`bindArrowTool(canvas)`の記述: `ctx.lineWidth`ではなく多角形の`ctx.fill()`でテーパー形状を焼き込み(T25追補で`ctx.shadowColor`/`shadowBlur`/`shadowOffsetY`を`fill()`前に設定)、確定直前に`undoStack.pushUndoStep(rect, before)`を呼ぶ(DOM/Canvas API依存のため自動テスト対象外、project-config.md §11参照)。色は`toolSettings.getToolSettings().color`を単一の真実源とし(T24で`--arrow-color`の`getComputedStyle()`直読みから変更)、`--arrow-color`CSSカスタムプロパティ自体はUIアクセント色・初期値の出所として`styles.css`に残る(2箇所の`#FF5C8A`定義が独立して存在する点はproject-config.md §11参照)。T25で`cropSnapshotRect()`は`coords.ts`へ移設した(挙動不変)
- `canvas/tools/mosaicTool.ts`(T10、FR-008。T20【改訂 2026-09-24】Rect移設、T24【改訂 2026-09-24】Undo連携): モザイクツール。`computeMosaicRect()`(`coords.ts`の`normalizeRect()`/`clipRectToCanvas()`を合成しドラッグ距離2px未満は`null`、`arrowTool.ts::computeArrowGeometry()`と同じ構成)・`mosaicBlockSize()`(Canvas対角線からブロックサイズを算出、下限12px/上限64px。矩形サイズには依存させず、選択矩形がどれだけ小さくても判読不能な粗さを保証する)・`pixelateImageData(data, width, height, blockSize)`(`Uint8ClampedArray`のブロック平均、端数ブロックは実ピクセル数で平均、単色画像は不変、入力は変更しない純粋関数)は純粋関数としてユニットテスト対象。T20で`Rect`型・`normalizeRect()`・`clipRectToCanvas()`の定義本体は`../coords.ts`へ移設し、本ファイルは再importして使う(挙動不変)。T24で`bindMosaicTool(canvas)`の確定焼き込み(`applyMosaic()`)直前に`undoStack.pushUndoStep(rect, before)`を呼ぶよう配線した(既存のピクセル化ロジック自体は挙動不変)。T25で`cropSnapshotRect()`/`roundRect()`も`../coords.ts`へ移設した(矩形ツールが3ファイル目の利用者になりRule of Threeで集約、挙動不変)。`bindMosaicTool(canvas)`はDOM/Canvas APIに直接依存するため自動テスト対象外(`arrowTool.ts`と同じ方針、project-config.md §11参照)。処理を選択矩形のImageDataのみに限定することで大きな画像でも全体を処理しない(パフォーマンス要件)。プレビューの矩形枠線色は`--arrow-color`を流用する(ぼかしオプションは実装しない、FR-008決定ログ)。T32【改訂 2026-09-24】でピクセル化はベースだけに適用する(`documentState.ts::applyBaseEdit()`、上のオブジェクトは隠れない)。プレビューは全体スナップショットをやめ`renderDocument()`で合成を描き直してから枠を重ねる
- `canvas/tools/rectangleTool.ts`(T25【新設 2026-09-24】、FR-007): 矩形枠ツール。`rectangleLineWidth()`(Canvas対角線からの枠線幅算出、`arrowTool.ts::arrowLineWidth()`と同じ考え方だがローカル定数、下限2px/上限14px)・`constrainToSquare()`(Shiftキー押下時に始点基準で正方形へ補正、【仮定】ARCH/PRDに明記なし)・`computeRectangleGeometry()`(`coords.ts`の`normalizeRect()`/`clipRectToCanvas()`を合成、ドラッグ距離2px未満は`null`)・`computeRectangleBoundingRect()`(線幅分の余白付き整数外接矩形)は純粋関数としてユニットテスト対象。`bindArrowTool()`/`bindMosaicTool()`と同じ「pointerdownスナップショット→pointermoveプレビュー→pointerup焼き込み」パターンと`imageAtDragStart`+`isSameCanvasImage()`中断パターン(MUST-1)を踏襲し、`ctx.strokeRect()`で塗りつぶしなしの枠線のみ焼き込む。色は`toolSettings.getToolSettings().color`。`bindRectangleTool(canvas)`はDOM/Canvas API依存のため自動テスト対象外。T31【改訂 2026-09-24】でポインタ結線は`shapeTools.ts`へ統合し、描画関数`drawRectangleOutline()`をexportした。v0.2.0後フィードバック(2026-09-25)で角丸にした(`ctx.roundRect()`、半径は`rectangleCornerRadius()` = `min(線幅×2.5, 短辺×0.25)`。`objectModel.ts::hitTestObjectOutline()`も同じ半径の角丸で判定)
- `canvas/tools/ellipseTool.ts`(T26【新設 2026-09-24】、FR-011): 円(楕円)枠ツール。`ellipseLineWidth()`(`rectangleTool.ts::rectangleLineWidth()`と同じ式のローカル定数、下限2px/上限14px)・`constrainToSquare()`(`rectangleTool.ts`と同じ実装をローカルに複製、Rule of Threeにより2ファイル目はまだ共通化しない)・`computeEllipseCenterAndRadii()`(外接矩形→中心・X半径・Y半径)・`computeEllipseGeometry()`(`coords.ts`の`normalizeRect()`/`clipRectToCanvas()`を合成、ドラッグ距離2px未満は`null`)・`computeEllipseBoundingRect()`(線幅分の余白付き整数外接矩形)は純粋関数としてユニットテスト対象。`bindRectangleTool()`と同じドラッグパターン・MUST-1中断パターンを踏襲し、`ctx.ellipse()`+`ctx.stroke()`で塗りつぶしなしの枠線のみ焼き込む。色は`toolSettings.getToolSettings().color`。`bindEllipseTool(canvas)`はDOM/Canvas API依存のため自動テスト対象外。T31【改訂 2026-09-24】でポインタ結線は`shapeTools.ts`へ統合し、描画関数`drawEllipseOutline()`をexportした
- `canvas/shapeEdit.ts`・`canvas/pendingShape.ts`・`canvas/tools/shapeTools.ts`(T31【新設 2026-09-24】、FR-006/007/011改訂): 直前に描いた図形1つを「編集中」として保持し、ハンドルでリサイズ・内側ドラッグで移動する(設計はARCH §5.2末尾「編集中の図形」)。`shapeEdit.ts`は当たり判定・リサイズ・移動・pointerdown分岐・取り消し用外接矩形の純粋関数、`pendingShape.ts`は「図形パラメータ+描く前のbase画像」の薄いストア(確定=baseから外接矩形を切り出して`pushUndoStep()`、破棄=baseを書き戻す)、`shapeTools.ts`はポインタ結線とハンドル用オーバーレイ(`.shape-overlay`、`pointer-events: none`の別canvas。Canvasのピクセルに含まれないためコピー・履歴に写らない)。DOM依存部分はE2E(`e2e/shape-edit.spec.ts`)で検証。T32【改訂 2026-09-24】で`pendingShape.ts`は廃止し、下記オブジェクト層に置き換えた(`decidePointerDown()`はオブジェクト配列・選択中idを受け取る形に一般化)
- `canvas/objectModel.ts`・`canvas/commands.ts`・`canvas/documentState.ts`・`canvas/documentSurface.ts`(T32【新設 2026-09-24】、FR-006/007/011/008/014改訂): 矢印・矩形・円を焼き込まずオブジェクト(`{id, shape}`、配列順=重ね順)として保持し、確定後もクリックで選び直して移動・リサイズできる(設計はARCH §5.2「オブジェクト層」)。`objectModel.ts`は挿入・除去・置換・最前面からの当たり判定(未選択は線の付近のみ)と`OBJECT_LIMIT`(50)、`commands.ts`は取り消し・やり直しのコマンド(add/update/remove/pixels/flatten/group、ピクセル系は差分の入れ替え方式)、`documentState.ts`はドキュメント(ベース+オブジェクト+選択+下書き)の状態と操作(51個目で最古をベースへ焼き込み、追加と同じ1コマンドにする)、`documentSurface.ts`はベースのオフスクリーンcanvasと合成描画(`drawImage(base)`+オブジェクト)のDOM実装。前3つは純粋関数/偽サーフェスでユニットテスト、DOM部分はE2E(`e2e/object-layer.spec.ts`)
- `history/documentArchive.ts`・`ui/arrangeButtons.ts`(T34【新設 2026-09-25】): 履歴項目ごとのドキュメント退避(ベースPNG+オブジェクト+次のid+取り消しスタック、取り消しのピクセルは1項目8MBまで)と、最前面へ・最背面へ(ボタン・⌘⇧F/⌘⇧B)。`documentState.ts`に選択中の操作(`setSelectedColor`・`previewSelectedColor`・`setSelectedFontSize`(`setTextMeasurer`で`textTool.ts`が寸法の測り方を登録)・`arrangeSelected`)と`snapshotDocument`/`exportDocumentBase`/`restoreDocument`を追加、`commands.ts`に`reorder`、`ui/selectionKeys.ts`にDelete/Backspace削除。`main.ts`は切り替え前に退避・再読込時に復元
- `canvas/tools/textTool.ts`(T27【新設 2026-09-24】、FR-012): クリック位置に単一行の`<input>`(`.text-tool-input`、Canvasの兄弟要素)を重ね、Enter(IME変換中を除く)/blurで確定・Escで取消。フォント実寸`computeFontSizePx()`(対角線×0.024を18〜128pxにクランプ、小・中・大=×2/3・×1・×1.5)、影`textShadowParams()`(矢印と同じ半透明黒)、表示倍率`canvasToCssScale()`、CSS行ボックスと同じベースライン`computeBaselineY()`、取り消し用外接矩形`computeTextBoundingRect()`、確定/取消の状態遷移`finishTextSession()`、IME判定`textKeyAction()`は純粋関数。T32【改訂 2026-09-24】で焼き込み先をベース(`applyBaseEdit()`の`pixels`コマンド)にし、常にオブジェクトより下になる。配置前に`commitPendingShape()`(T32で廃止)、ツール切替で確定、確定を経ない画像差し替えでは破棄。DOM依存部分はE2E(`e2e/text-tool.spec.ts`)で検証。T33【改訂 2026-09-24】で純粋関数を`tools/textLayout.ts`へ分離(`textTool.ts`から再export)し、確定は`addShapeObject()`でテキストオブジェクト(`TextShape`)を追加する方式に変更。ダブルクリック(モザイク以外)で再編集(`setHiddenObject()`で隠して入力欄を開き、`decideTextEdit()`でupdate/remove/何もしない)。`isTextEditorOpen()`で入力中のCanvasクリックを確定だけにする
- `ui/captureButton.ts`: キャプチャ開始ボタンに `startCapture()` 呼び出しをバインドする。失敗時は最小限のエラー文言を表示する(`captureErrorMessage()`)。T08で `initCaptureButton()` に任意コールバック `onPermissionDenied` を追加し、`"permission_denied"` 検知時に `main.ts` 経由で権限バナーを表示できるようにした(`captureErrorMessage()` の最小表示とは置き換えず共存させる、PJM指示)
- `ui/permissionBanner.ts`(T08、NFR-002): 画面収録権限未許可時の案内バナー。`shouldShowPermissionBanner(state)`(3状態からの表示要否判定)・`permissionBannerMessage()`(バナー本文、【仮定】アプリ再起動が必要な場合がある旨を含む)は純粋関数としてユニットテスト対象。`initPermissionBanner(mount)`(DOM生成・マウント・「システム設定を開く」ボタンのクリックバインド)はDOM APIに依存するため自動テスト対象外(project-config.md §11参照)
- `ui/colorPicker.ts`(T28【新設 2026-09-24】、FR-013): プリセット6色(`COLOR_PRESETS`、定義はここ1か所。ピンク`#FF5C8A`・赤`#FF3B30`・橙`#FF9500`・黄`#FFCC00`・緑`#34C759`・青`#007AFF`)の丸いスウォッチ + 透明の`<input type="color">`を重ねたカラーピッカー。クリックで`toolSettings.setColor()`、選択状態は購読で`aria-pressed`(ピッカーは`.color-swatch--selected`)。`colorAtPresetIndex()`・`presetIndexOfColor()`・`toColorInputValue()`は純粋関数。編集中の図形(T31)の色は変えない
- `ui/fontSizePicker.ts`(T28【新設 2026-09-24】、FR-013): 文字サイズ小・中・大のアイコンボタン(「A」の大きさの比は`textTool.ts::FONT_SIZE_MULTIPLIER`に一致、`fontSizeGlyphHeight()`)。クリックで`toolSettings.setFontSize()`
- `ui/undoButton.ts`(T29【新設 2026-09-24】、FR-014): 取り消し・やり直しボタン + `Cmd+Z`/`Cmd+Shift+Z`。対象矩形をpeek→`getImageData()`→`popUndo/popRedo(current)`→`putImageData()`。編集中の図形があれば取り消し=`discardPendingShape()`・やり直しは無効。テキスト入力欄フォーカス中・ドラッグ中は発火しない。判定`undoShortcutCommand()`・`resolveUndoCommand()`・`undoAvailability()`は純粋関数。ボタンは`data-preserve-pending-shape`属性で`shapeTools.ts`の「Canvas外pointerdownで確定」から除外。T32【改訂 2026-09-24】で実行は`documentState.ts::undoDocument()`/`redoDocument()`に委ね、編集中の図形の特別扱い(破棄・やり直し無効)は廃止。属性は`data-preserve-selection`(Canvas外pointerdownの選択解除から除外)に改名
- `ui/toolbar.ts`(T09土台、T10でモザイク有効化、FR-006・FR-008共通): 矢印/モザイクのツール切替UI。`TOOLS` 配列(T10で矢印・モザイクの2件)からボタンを生成し、クリックで `canvasState.toggleActiveTool()` を呼ぶ。`canvasState` の変化を購読して `aria-pressed`・活性状態(`isDrawing`中は非アクティブなボタンを無効化)に反映する。DOM生成を伴う `initToolbar()` はVitestの既定環境では自動テスト対象外(project-config.md §11参照)
- `ui/shortcutGuards.ts`(T22【新設 2026-09-24】): `isEditableTarget(target)`(input/textarea/contentEditableかどうかの判定。テキスト入力中はアプリのショートカットを奪わない)を提供する純粋関数モジュール。T22で`clipboardButton.ts`から抽出し、`Cmd+Z`/`Cmd+Shift+Z`(T29)・テキスト入力欄表示中の判定(T27)からも再利用する(挙動不変)
- `ui/clipboardButton.ts`(T12、FR-005。T22【改訂 2026-09-24】): 「クリップボードにコピー」ボタン + `Cmd+C`(通常の`keydown`リスナー、グローバルショートカットではない)。`isClipboardCopyEnabled(state)`(`image !== null`の判定)・`isCopyShortcut(event)`(`metaKey`+`c`/`C`の判定)・`clipboardCopyFeedbackMessage(result)`(plugin/fallback/errorごとの短い文言)は純粋関数としてユニットテスト対象。`isEditableTarget()`はT22で`ui/shortcutGuards.ts`へ抽出し、本ファイルは再importして使う(定義本体は無い、挙動不変)。`initClipboardButton()`(DOM生成・`canvasState`購読・`ipc/clipboard.ts::copyToClipboard()`呼び出し)はDOM依存のため自動テスト対象外(`captureButton.ts`と同じ方針)

## ディレクトリ構成

<!-- ARCH §4(output/design/ARCH_tadcap_mvp.md)の最終形に向け、実装済み分のみを反映する -->

現時点(T07・T15・T16・T08・T09・T10・T12・T14 完了)の実装済みファイルのみ記載:

```
src/                          # フロントエンド(Vanilla TS + Canvas)
├── main.ts                   # エントリーポイント。DOM初期化・IPCイベント購読(T07)。T08で権限バナー初期化・3入口の結線を追加。T09でツールバー初期化・矢印ツール結線を追加。T10でモザイクツール結線を追加。T14でサイドバー初期化・履歴追加/上書きの結線を追加
├── styles.css                # レイアウト・スタイル(T07でgreetスキャフォールド撤去、エディタ画面用に置換)。T08で `.permission-banner` 系を追加。T09で `--arrow-color`・`.tool-toolbar` 系を追加(T10は既存の`--arrow-color`をモザイク選択矩形のプレビュー枠線色として流用、CSS変更なし)。T14で `.main-area`・`.history-sidebar` 系を追加
├── history/                  # セッション内履歴のメモリ管理(T14、FR-010)
│   └── historyStore.ts       # HistoryItem[]の追加・選択・上書き・上限超過時の破棄(純粋関数+薄いストア、canvasStateと同じ作法)。`captureHistoryAssets`は`canvas/render.ts`のre-export
├── ipc/                      # Rustコマンド呼び出し・イベント購読の薄いラッパー(T07〜)
│   ├── capture.ts            # startCapture()・onCaptureCompleted()(T07)。T08で onCaptureError()(capture://error購読)を追加
│   ├── permissions.ts        # checkScreenRecordingPermission()・openScreenRecordingSettings()・isPermissionDeniedError()(T08)
│   └── clipboard.ts          # copyToClipboard()(プラグイン優先→Rustフォールバック、T12)
├── canvas/                   # Canvas状態・描画ロジック(T07〜)
│   ├── canvasState.ts        # 現在表示中の画像を保持する薄い状態オブジェクト(T07)。T09で選択中ツール・描画中フラグを追加。T14で`CanvasImage.capture`をnullable化(履歴からの再読込対応)
│   ├── render.ts             # 画像読み込み・Canvas描画(T07)。T12で getCanvasImageData()(RGBA8抽出)を追加。T14で captureHistoryAssets()(履歴保存用image/thumbnailのObjectURL抽出)を追加
│   ├── coords.ts             # CSS表示座標→Canvasピクセル座標の変換(T09)。T20で`Rect`/`normalizeRect()`/`clipRectToCanvas()`を`tools/mosaicTool.ts`から、T25で`roundRect()`/`cropSnapshotRect()`を`tools/arrowTool.ts`・`tools/mosaicTool.ts`から移設
│   ├── toolSettings.ts       # 矢印/矩形/円/テキスト共通の現在色・フォントサイズ段階(純粋関数+薄いストア、T21、FR-013)
│   ├── undoStack.ts          # Undo/Redoスタック(変更矩形+ピクセルの差分方式、純粋関数+薄いストア、T23、FR-014)
│   ├── shapeEdit.ts          # 選択中の図形の当たり判定・リサイズ・移動・pointerdown分岐の純粋関数(T31、T32で一般化)
│   ├── objectModel.ts        # オブジェクト配列の純粋関数・上限50(T32)
│   ├── commands.ts           # 取り消し・やり直しのコマンド(T32)
│   ├── documentState.ts      # ドキュメント(ベース+オブジェクト+選択+下書き)の状態と操作(T32)
│   ├── documentSurface.ts    # ベースのオフスクリーンcanvasと合成描画(DOM、T32)
│   └── tools/
│       ├── shapeTools.ts     # 矢印/矩形/円の共通ポインタ結線+ハンドル用オーバーレイ(T31)
│       ├── arrowTool.ts      # 矢印の座標計算・描画(T09。T31でポインタ結線をshapeTools.tsへ移動)
│       ├── mosaicTool.ts     # モザイク(矩形選択→ピクセル化焼き込み、T10)。T20で`Rect`/`normalizeRect()`/`clipRectToCanvas()`を`../coords.ts`へ移設
│       ├── rectangleTool.ts  # 矩形枠(塗りつぶしなしの枠線描画、T25、FR-007)
│       ├── ellipseTool.ts    # 円(楕円)枠(塗りつぶしなしの枠線描画、T26、FR-011)
│       └── textTool.ts       # テキスト(クリック位置の入力欄→焼き込み、T27、FR-012)
├── ui/                       # DOM構築・イベントバインディング(T07〜)
│   ├── captureButton.ts      # キャプチャ開始ボタン(T07)。T08で onPermissionDenied コールバックを追加
│   ├── permissionBanner.ts   # 画面収録権限未許可時の案内バナー(T08)
│   ├── toolbar.ts            # 矢印/矩形/円/モザイクのツール切替UI(T09で矢印のみ、T10でモザイク、T25で矩形、T26で円を有効化)
│   ├── selectionKeys.ts      # 選択中のオブジェクトのEnter/Esc=選択解除(T31のpendingShapeKeys.tsをT32で置き換え)
│   ├── colorPicker.ts        # 注釈色のプリセット6色+カラーピッカー(T28、FR-013)
│   ├── fontSizePicker.ts     # 文字サイズ小・中・大(T28、FR-013)
│   ├── undoButton.ts         # 取り消し・やり直しボタン+Cmd+Z/Cmd+Shift+Z(T29、FR-014)
│   ├── toast.ts              # 右下トーストの自動消去(`showToast()`/`clearToast()`、成功・情報2.5秒/エラー5秒、reduced-motionはフェードなし。v0.2.0後フィードバック)
│   ├── shortcutGuards.ts     # `isEditableTarget()`(編集可能要素の判定、T22、`clipboardButton.ts`から抽出)
│   ├── clipboardButton.ts    # 「クリップボードにコピー」ボタン + Cmd+C(T12)。T14で成功時フック`onCopySuccess`を追加。T22で`isEditableTarget()`を`shortcutGuards.ts`へ抽出
│   └── sidebar.ts            # セッション内履歴サイドバー(T14、FR-010)。項目クリックでCanvasへ再読込
├── assets/                   # 既存(vite/tauri/typescriptロゴ。index.htmlからは参照撤去済み、T07)
└── test/
    ├── smoke.test.ts         # Vitest 配線確認用プレースホルダ(T01)
    └── latencySummary.test.ts # scripts/latency-summary.mjs の集計関数テスト(T11)
scripts/
└── latency-summary.mjs       # NFR-001中間計測ログ([tadcap:latency]行)の集計スクリプト(依存追加なし、T11)
src-tauri/src/                # Rustバックエンド
├── main.rs                   # 既存。バイナリエントリーポイント
├── lib.rs                    # tauri::Builder 組み立て・invoke_handler登録(T02、T06で capture_screen 追加、T15でDockアイコン非表示・トレイ構築・ウィンドウクローズ制御を追加、T16でグローバルショートカット登録を追加、T08で check_screen_recording_permission・open_screen_recording_settings を追加、実機不具合②〜⑤で read_capture_image を追加しasset protocol scopeの動的登録を撤去)
├── commands.rs                # #[tauri::command] 集約(T02)。capture_screen(T06、T16で async fn 化)を追加。T15で run_capture_and_notify() をトレイ等との共通関数として切り出し、T16で run_capture() に改称・spawn_blocking化 + 3起点共有の実行中排他フラグ(CAPTURE_IN_PROGRESS)を追加。T08で check_screen_recording_permission・open_screen_recording_settings を追加。T11で run_capture()/capture_screen() に origin/start(Instant)引数を追加(NFR-001中間計測)
├── error.rs                   # コマンド共通エラー型 AppError(T02)。PermissionDenied(T06)を追加
├── tray.rs                    # メニューバー常駐トレイの構築(T15、FR-009)。T16でrun_capture_and_show_editor()をasync_runtime::spawn化。T11でorigin/start(Instant)引数を追加(NFR-001中間計測)
├── window_front.rs             # エディタウィンドウの前面化処理(B2、tray.rsから分離)。run_on_main_thread + 再試行計画・診断ログ([tadcap:front])
├── shortcuts.rs                # グローバルショートカット登録(T16、FR-004)。既定キーCmd+Shift+2、tauri-plugin-global-shortcut使用。T11でハンドラ内にInstant::now()記録を追加(NFR-001中間計測)
├── clipboard/                  # クリップボード書込のRustフォールバック(T12、FR-005)
│   └── mod.rs                  # validate_rgba()・write_image_fallback()(arboard使用)
└── capture/                   # キャプチャ機能(T03〜T06、T08、T11)
    ├── mod.rs                 # CaptureProvider trait・CaptureResult・CaptureKind・RunError・run()/run_with()(T05・T06)。T08で ensure_screen_recording_access()/ensure_screen_recording_access_with() を追加。T11で計測ログ整形の純粋関数(format_latency_log/duration_to_ms)・CaptureProvider::captureへのon_spawnコールバック引数を追加(NFR-001中間計測)
    ├── tempfile.rs             # 一時ファイルパス生成(一意性保証、T03)
    ├── permission.rs           # 画面収録権限チェック(CoreGraphics FFI、T04)。T08で request_screen_recording_access() を実使用開始、ScreenRecordingPermission に Serialize(camelCase)を追加
    └── screencapture.rs        # ScreenCaptureCli(`screencapture -i` 起動、T05)。T11で status() を spawn()+wait() に分割し、spawn完了直後にon_spawn()を呼ぶ(NFR-001中間計測)
```

## テスト構成

TSテストはコロケーション方式で対象ファイルと同じディレクトリに `*.test.ts` として配置する
(`__tests__/` サブディレクトリは使わない。ARCH §10.1 の配置規約 `src/**/*.test.ts` に従う。T01の
`smoke.test.ts` のみ `src/test/` 配下の配線確認用プレースホルダとして例外的に独立配置)。

<!-- AIが実装状況からテスト一覧を生成・更新する -->

### ストアテスト

| テストファイル | 対象 |
| -------------- | ---- |
| `src/canvas/canvasState.test.ts` | `createCanvasState()`/`withImage()`/`withoutImage()`/`withActiveTool()`/`toggleTool()`/`withDrawing()`(純粋関数)、`getCanvasState()`/`setCanvasImage()`/`clearCanvasImage()`/`setActiveTool()`/`toggleActiveTool()`/`setDrawing()`/`subscribeCanvasState()`(シングルトンストア、通知・購読解除を含む)(T07。ツール状態・描画中フラグはT09で追加) |
| `src/history/historyStore.test.ts` | `createHistoryState()`/`withAddedItem()`(追加・新しいものが先頭・`HISTORY_LIMIT`超過時の破棄)/`selectHistoryEvictions()`(件数・合計バイト数の上限、表示中は破棄しない)/`enforceHistoryBudget()`/`withSelectedId()`(選択・存在しないid時は無変更)/`withUpdatedItemImage()`(image/thumbnail上書き・id/createdAt維持・存在しないid時は無変更)/`getSelectedItem()`(純粋関数)、`getHistoryState()`/`addHistoryItem()`/`selectHistoryItem()`/`updateSelectedItemImage()`/`subscribeHistoryState()`(シングルトンストア、破棄・上書き時の`URL.revokeObjectURL()`呼び出しを含む。Node環境でも`Blob`/`URL`はグローバルに存在するため自動テスト可能、project-config.md §11参照)(T14)。DOM/Canvas依存の`captureHistoryAssets()`(re-export元は`canvas/render.ts`)は対象外 |
| `src/canvas/toolSettings.test.ts` | `createToolSettings()`(既定色`#FF5C8A`・既定フォントサイズ`"medium"`)/`withColor()`/`withFontSize()`(純粋関数、イミュータブル)、`isValidColorCode()`(`#RRGGBB`形式の判定、大文字/小文字/桁数不足/桁数超過/16進数以外/空文字列)、`getToolSettings()`/`setColor()`/`setFontSize()`/`subscribeToolSettings()`(シングルトンストア、通知・購読解除を含む)(T21、FR-013) |
| `src/canvas/undoStack.test.ts` | 【改訂 2026-09-24 T32】要素を`DocumentCommand`に変更: `withPushedCommand()`(Redoクリア・上限30件)/`withPoppedUndo()`・`withPoppedRedo()`(LIFO・`apply`の戻り値を反対側へ積む・空は`null`で`apply`を呼ばない・Redo側の上限)/`canUndoState()`/`canRedoState()`、ストア(`pushCommand`・`popUndo/popRedo`の往復・新規操作でRedoクリア・`clearUndoStack`・購読解除)(T23、FR-014) |
| `src/canvas/objectModel.test.ts` | T32: `OBJECT_LIMIT`=50、`insertObject`(範囲外の丸め・イミュータブル)/`removeObject`/`replaceObjectShape`/`findObject`、`hitTestObjectOutline`(矩形・円は線の付近のみ・内側中央と円の外接矩形の角は当たらない・矢印は胴体。矩形の角丸の外側は当たらない)、`pickObjectAt`(最前面優先・外れは`null`) |
| `src/canvas/commands.test.ts` | T32: add/update/remove の取り消し・やり直し、pixels・flatten の入れ替え方式(往復でピクセルとオブジェクトが戻る)、group は逆順取り消し・順やり直し |
| `src/canvas/documentState.test.ts` | T32(偽のサーフェス): `resetDocument`、`addShapeObject`(最前面追加・選択・取り消しで選択解除・やり直し・新規操作でRedoクリア)、上限(50個まで焼き込まない/51個目で最古をベースへ焼き込み1回の取り消しで両方戻る・やり直しは再描画せずピクセルを戻す/超過し続けても50個)、`commitShapeEdit`(update・形が同じなら積まない・存在しないidは無視)、`applyBaseEdit`(ベースだけ変えpixelsで往復・空矩形は無視)、選択は取り消し対象外、下書き・購読通知、サーフェス未登録時 |
| `src/history/documentArchive.test.ts` | T34: `commandPixelBytes`(pixels・flatten・groupの中)、`trimUndoToBudget`(上限以内はそのまま/古い取り消し→遠いやり直しの順に連続して捨てる)、8MB上限、履歴idごとの保存・取得・削除と保存時の上限適用、`archivedDocumentBytes`(実測バイト数) |
| `src/ui/arrangeButtons.test.ts` | T34: `arrangeShortcutCommand`(⇧⌘F=最前面・⇧⌘B=最背面、修飾違い・他キー・入力欄フォーカス中は対象外) |

### Canvasツールテスト

| テストファイル | 配置先 | 対象 |
| -------------- | ------ | ---- |
| `coords.test.ts` | `src/canvas/` | `clientToCanvasPoint()`(等倍/縮小表示時のスケール変換、Canvasオフセット考慮、範囲外座標のクランプ、表示サイズ0時の防御)(T09)。T20で`normalizeRect()`(逆方向ドラッグの正規化)・`clipRectToCanvas()`(範囲外へのはみ出しクリップ、全域はみ出し時は幅・高さ0)のテストを`mosaicTool.test.ts`から移設。T25で`roundRect()`・`cropSnapshotRect()`のテストを`arrowTool.test.ts`/`mosaicTool.test.ts`から移設 |
| `arrowTool.test.ts` | `src/canvas/tools/` | `arrowLineWidth()`(Canvas対角線からの線幅算出・上下限クランプ、T25追補で20px/6px/48pxへ改訂、T31で1.5倍の30px/9px/72pxへ改訂)、`arrowHeadLength()`、`arrowHeadWidth()`(T25追補で新設)、`arrowShadowParams()`(T25追補で新設)、`computeArrowGeometry()`(斜め/水平ドラッグでの矢じり左右対称配置を幾何関係で検証、ドラッグ距離2px未満は`null`)、`computeTaperArrowBoundingRect()`(シャドウ込み余白の厳密値検証、T25追補で追加)(T09)。DOM/Canvas依存の`bindArrowTool()`は対象外(project-config.md §11参照)。T25で`cropSnapshotRect()`のテストは`coords.test.ts`へ移設 |
| `shapeEdit.test.ts` | `src/canvas/` | 編集中の図形(T31): `createShapeFromDrag()`・`getShapeHandles()`・`hitTestShape()`(ハンドル優先・矩形/楕円の内側・矢印の胴体)・`resizeShape()`(対角固定・反転時の正規化・Shift正方形・最小サイズ未満は据え置き・Canvasクランプ)・`moveShape()`(はみ出さないよう移動量をクランプ)・`applyEditDrag()`・`decidePointerDown()`(T32で一般化: 選択中のハンドル・内側/未選択は線の付近で選択+移動/最前面優先/空白は作成 or 選択解除/モザイク・テキスト中は掴まない/選択idが無い場合)・`shapeUndoRect()`・`cursorForHit()` |
| (廃止 T32)`pendingShape.test.ts` | `src/canvas/` | `documentState.test.ts` に置き換え |
| `mosaicTool.test.ts` | `src/canvas/tools/` | `computeMosaicRect()`(`coords.ts`の`normalizeRect()`/`clipRectToCanvas()`を利用、正規化+クリップの合成、ドラッグ距離2px未満は`null`)、`mosaicBlockSize()`(典型サイズ・5K Retina相当・下限12px/上限64pxクランプ)、`pixelateImageData()`(単一ブロックのRGBA平均、ブロックサイズで割り切れない端数ブロックの平均、単色画像は不変、入力配列を変更しない、ブロックサイズが矩形より大きい場合の全体1ブロック化)(T10)。T20で`normalizeRect()`/`clipRectToCanvas()`自体のテストは`coords.test.ts`へ移設。T25で`cropSnapshotRect()`/`roundRect()`のテストも`coords.test.ts`へ移設。DOM/Canvas依存の`bindMosaicTool()`は対象外(project-config.md §11参照) |
| `rectangleTool.test.ts` | `src/canvas/tools/` | `rectangleLineWidth()`(Canvas対角線からの枠線幅算出・上下限クランプ、矩形サイズ非依存)、`constrainToSquare()`(Shift押下時の正方形補正、通常/逆方向/既に正方形の各ケース)、`computeRectangleGeometry()`(正規化+クリップ、ドラッグ距離2px未満・Canvasはみ出し・Shift併用)、`computeRectangleBoundingRect()`(線幅分の余白を含む整数外接矩形、Canvas端でのクリップ)(T25)。`rectangleCornerRadius()`(線幅×2.5・短辺×0.25で頭打ち・幅0で0)。DOM/Canvas依存の`bindRectangleTool()`は対象外(project-config.md §11参照) |
| `ellipseTool.test.ts` | `src/canvas/tools/` | `ellipseLineWidth()`(Canvas対角線からの枠線幅算出・上下限クランプ、外接矩形サイズ非依存)、`constrainToSquare()`(Shift押下時の正方形補正)、`computeEllipseCenterAndRadii()`(外接矩形→中心・X半径・Y半径)、`computeEllipseGeometry()`(正規化+クリップ、ドラッグ距離2px未満・Canvasはみ出し・Shift併用で正円)、`computeEllipseBoundingRect()`(線幅分の余白を含む整数外接矩形、Canvas端でのクリップ)(T26)。DOM/Canvas依存の`bindEllipseTool()`は対象外(project-config.md §11参照) |

### フィーチャーテスト

| テストファイル | 配置先 | 対象 |
| -------------- | ------ | ---- |
| `capture.test.ts` | `src/ipc/` | `startCapture()`(成功/Escキャンセル時null/失敗時reject文字列)、`onCaptureCompleted()`(`capture://completed`購読・payload伝達)、`onCaptureError()`(`capture://error`購読・payload伝達、T08)。`@tauri-apps/api/core`・`@tauri-apps/api/event` は `vi.mock()` でモック(T07) |
| `permissions.test.ts` | `src/ipc/` | `checkScreenRecordingPermission()`(コマンド呼び出し・戻り値伝達)、`openScreenRecordingSettings()`(コマンド呼び出し)、`isPermissionDeniedError()`(`"permission_denied"`/その他文字列/非文字列の分岐)(T08)。`@tauri-apps/api/core` は `vi.mock()` でモック |
| `clipboard.test.ts` | `src/ipc/` | `copyToClipboard()`(主経路成功時は`'plugin'`を返しRustフォールバックを呼ばない、主経路失敗(`writeImage()`/`Image.new()`いずれの失敗も含む)時は`write_image_fallback`へ切り替わり`'fallback'`を返す、両方失敗時は両エラーを保持する`ClipboardCopyError`をreject)(T12)。`@tauri-apps/api/core`・`@tauri-apps/api/image`・`@tauri-apps/plugin-clipboard-manager` は `vi.mock()` でモック |
| `captureButton.test.ts` | `src/ui/` | `captureErrorMessage()`(`"permission_denied"`/その他文字列/非文字列エラーの分岐、IPC結果の分岐ロジック)(T07) |
| `permissionBanner.test.ts` | `src/ui/` | `shouldShowPermissionBanner()`(`"unconfirmed"`/`"granted"`/`"notGranted"` の3状態分岐)、`permissionBannerMessage()`(文言に「システム設定を開く」「再起動」を含むこと)、フロントの3入口(ボタンのinvoke reject・`capture://error`イベント・起動時チェック)がいずれも同じ表示判定に帰着することの検証(T08)。DOM生成を伴う `initPermissionBanner()` はVitestの既定環境(Node、DOM API無し)では対象外(project-config.md §11参照) |
| `clipboardButton.test.ts` | `src/ui/` | `isClipboardCopyEnabled()`(画像未読込/読込済みの分岐)、`isCopyShortcut()`(`metaKey`+`c`/`C`の判定、`metaKey`無し・他キーはfalse)、`clipboardCopyFeedbackMessage()`(plugin/fallback/errorごとの文言)(T12)。T22で`isEditableTarget()`のテストは`shortcutGuards.test.ts`へ移設。DOM生成を伴う `initClipboardButton()` は対象外(project-config.md §11参照) |
| `textTool.test.ts` | `src/canvas/tools/` | `computeFontSizePx()`(小・中・大、上下限クランプ)、`textShadowParams()`、`canvasToCssScale()`、`computeTextLineTop()`、`computeBaselineY()`、`computeTextBoundingRect()`(影の余白・クリップ)、`textKeyAction()`/`isImeComposingKey()`(isComposing・composition中・keyCode 229)、`finishTextSession()`(Enter/blur確定・Esc/画像差し替え/空文字は焼き込まない・二重確定しない)(T27) |
| `textLayout.test.ts` | `src/canvas/tools/` | T33: `textShapeBox()`(行ボックス・字形のはみ出し・文字サイズ段階)、`textShapeBaselineY()`/`textShapeBoundingRect()`(T27と同じ式)、`decideTextEdit()`(新規=追加/何もしない、再編集=変更/同じなら何もしない/空なら削除、Esc・画像差し替えは何もしない) |
| `selectionKeys.test.ts` | `src/ui/` | `selectionKeyAction()`(T32で`pendingShapeKeys.test.ts`から置き換え: 選択中のみEnter・Esc=選択解除、修飾キー・IME変換中・入力欄では奪わない) |
| `toast.test.ts` | `src/ui/` | `toastDurationMs()`(情報2.5秒/エラー5秒)、`showToast()`/`clearToast()`(フェード後に消える・新しい文言でタイマーをやり直す・reduced-motionはフェードなし・空文字はclear。偽タイマー) |
| `shortcutGuards.test.ts` | `src/ui/` | `isEditableTarget()`(null/undefined/INPUT/TEXTAREA/contentEditable/通常要素の分岐)(T22。`clipboardButton.test.ts`から移設、挙動不変)。T28で`type="color"`等の文字入力でないINPUTはfalse |
| `colorPicker.test.ts` | `src/ui/` | `COLOR_PRESETS`(6色・先頭が既定ピンク・形式・重複なし)、`colorAtPresetIndex()`、`presetIndexOfColor()`(大小文字無視・プリセット外は-1)、`toColorInputValue()`(T28) |
| `fontSizePicker.test.ts` | `src/ui/` | `FONT_SIZE_OPTIONS`、`fontSizeGlyphHeight()`(大小比が`FONT_SIZE_MULTIPLIER`に一致)(T28) |
| `undoButton.test.ts` | `src/ui/` | `undoShortcutCommand()`(Cmd+Z/Cmd+Shift+Z、修飾・入力欄・type=color)、`undoAvailability()`・`resolveUndoCommand()`(編集中図形=破棄・やり直し無効、ドラッグ中は無効)(T29) |

`src/ui/toolbar.ts`(T09土台・T10でモザイク有効化)はDOM生成・`canvasState`購読を伴うため自動テスト対象外(`permissionBanner.ts`と同じ方針、project-config.md §11参照)。ツール切替のロジック自体は上記`canvasState.test.ts`の`toggleTool()`/`toggleActiveTool()`で検証する。

`src/ui/sidebar.ts`(T14)も同じ理由でDOM生成・`historyStore`購読を伴うため自動テスト対象外とする。状態遷移ロジック自体は上記`historyStore.test.ts`で検証し、実際のサイドバーDOM描画・Canvas再読込(項目クリック→画像切替)は手動確認チェックリストへ回す。

### 共有レイヤーテスト

| テストファイル | 配置先 | 対象 |
| -------------- | ------ | ---- |
| `smoke.test.ts` | `src/test/` | Vitest 配線確認用のプレースホルダ(`1+1=2`、T01) |
| `latencySummary.test.ts` | `src/test/` | `scripts/latency-summary.mjs`(依存追加なしのNode集計スクリプト)の `parseLatencyLine()`/`parseLatencyLog()`/`median()`/`summarize()`/`formatSummaryTable()` を検証(NFR-001中間計測、T11)。型定義のないプレーンJSモジュールのため `@ts-expect-error` でimportする |

### Rust ユニットテスト(`cargo test`、コロケーション `#[cfg(test)] mod tests`)

| モジュール | 対象 |
| ---------- | ---- |
| `error.rs` | `AppError::Internal` / `AppError::PermissionDenied` の `Display`(`to_string()`)と `serde::Serialize`(JSON文字列化)の挙動(T02、`PermissionDenied` はT06で追加) |
| `capture/tempfile.rs` | `generate_capture_path()` の一意性(連続500回呼び出しで重複無し)・専用サブディレクトリ配下であること・PNG拡張子であること(T03) |
| `capture/permission.rs` | C の `Boolean`(0/非0)から `ScreenRecordingPermission` への変換(`to_permission`)の純粋関数テスト(T04)。`ScreenRecordingPermission` の `Serialize`(camelCase、`"granted"`/`"notGranted"`)テスト(T08)。実際の権限状態はOS(TCC)依存のため対象外、手動確認チェックリストへ回す |
| `capture/screencapture.rs` | `outcome_for()`(プロセス終了後、`dest` の存在有無から `Completed`/`Cancelled` を判定する純粋関数)のテスト(T05)。実際の `screencapture` プロセスは起動しない |
| `capture/mod.rs`(`run_with()`) | モック `CaptureProvider` と権限注入で、「権限未許可なら `screencapture` を起動しない」「ファイル未生成(`Cancelled`)はエラー扱いしない」「権限許可かつ生成時は `Completed`」「生成した一時ファイルパスを結果とともに返す」の4分岐をテスト(T05・T06)。実プロセス・実OS権限には依存しない |
| `capture/mod.rs`(`format_latency_log()`/`duration_to_ms()`) | NFR-001中間計測ログの整形の純粋関数テスト(起点ごとの出し分け、小数第1位への丸め、マイクロ秒精度の保持)(T11)。実際の標準エラー出力(`emit_latency_log()`)は対象外 |
| `capture/mod.rs`(`ensure_screen_recording_access_with()`) | 権限確認・要求を注入し、「許可済みならrequestを呼ばない」「未許可ならrequestを1回呼ぶ」「requestの戻り値をそのまま返す」の3分岐をテスト(T08)。実OS権限・実ダイアログには依存しない |
| `commands.rs` | `app_error_from_run_error()`(`RunError → AppError` 変換)・`capture_result_for()`(`CaptureOutcome → Option<CaptureResult>` 構築、`Cancelled` は `None`)・`id_from_path()`(一時ファイル名からの識別子生成)・`iso8601_utc_from_unix_millis()`/`civil_from_days()`(既知タイムスタンプ・うるう年・時分秒ミリ秒のフォーマット)の純粋関数テスト(T06)。`try_begin_capture()`/`end_capture()`(3起点共有の実行中排他フラグの開始→多重呼び出し拒否→解放→再開始の一連の遷移、T16)。`SCREEN_RECORDING_SETTINGS_URL` 定数の固定文字列回帰テスト(T08)。`parse_image_dimensions()`(width/heightヘッダー文字列のパース。欠落・非数値・空文字列・負数を拒否)・`app_error_from_clipboard_error()`(`ClipboardFallbackError → AppError` 変換)の純粋関数テスト(T12)。`capture_screen`/`run_capture`/`check_screen_recording_permission`/`open_screen_recording_settings`/`write_image_fallback`(`AppHandle`/`Request` を要する部分)は実際の `screencapture` 起動・OSダイアログ・Tauriランタイムに依存するため自動テスト対象外 |
| `clipboard/mod.rs` | `validate_rgba()`(width/heightが0、空バイト列、`width*height*4`と不一致な長さのバイト列をそれぞれ拒否し、正しい長さは受理する)・`ClipboardFallbackError`の`Display`(バリアントごとのメッセージ)の純粋関数テスト(T12)。`write_image_fallback()`内の実クリップボード書込(`arboard::Clipboard::new`/`set_image`)はOS依存のため自動テスト対象外、手動確認チェックリスト#5へ |
| `tray.rs` | `tray_menu_action_from_id()`(メニューID文字列→`TrayMenuAction`の判定。capture/open_editor/quit の3IDと未知ID・空文字の分岐)の純粋関数テスト(T15)。`capture_follow_up()`(成功→前面表示、失敗→エラー通知+前面表示、キャンセル→何もしない、実機不具合①の再発防止)のテスト。`build_tray()`・`run_capture_and_show_editor()`(トレイ・ウィンドウ・Dockアイコンの実操作)はTauriランタイム・OSネイティブ導線に依存するため自動テスト対象外。手動確認チェックリスト#4・#7へ |
| `window_front.rs` | `front_plan()`(トリガー別の手順列。activate/orderFrontRegardlessの順序、RaiseLevel/RestoreLevelの整合)・`next_attempt_index()`(試行結果からの分岐)・`format_front_log()`(`[tadcap:front]`ログの整形、状態あり/なし、空白サニタイズ)の純粋関数テスト(B2、実機不具合①の再発防止)。実際のAppKit呼び出し(`native`サブモジュール)・`bring_main_window_to_front()`はOSネイティブ導線に依存するため自動テスト対象外。手動確認チェックリスト#4・#7へ |
| `shortcuts.rs` | `default_capture_shortcut()`(Cmd+Shift+2で構成されること、Cmd+Shift+4等の他キー組み合わせにマッチしないこと)・`should_handle_shortcut_event()`(`ShortcutState::Pressed`のみ処理しReleasedは無視する判定)の純粋関数テスト(T16)。`register_capture_shortcut()`(実際のプラグイン登録・OSキー登録)はTauriランタイム・OSネイティブ導線に依存するため自動テスト対象外。手動確認チェックリスト#3へ |

### E2Eテスト

Playwright(`@playwright/test`、ブラウザは chromium のみ、T13)。Tauriランタイムは起動せず、
Vite dev server上のページを開き `e2e/fixtures/tauriMock.ts` が `page.addInitScript()` で
`window.__TAURI_INTERNALS__` をモックする(ARCH §10 決定#4。方式・理由は同ファイルの
モジュールdoc参照)。設定は `playwright.config.ts`、レポートは `testreport/e2e/`。

| テストファイル | 対象 |
| -------------- | ---- |
| `e2e/tool-settings.spec.ts` | T28: 起動直後ピンク・文字サイズ中が選択状態/選んだ色で以後の描画、描いた後の色変更は焼き込み済みに影響しない/カラーピッカー選択の反映とフォーカスが残ってもCmd+Cが効く/プリセット外の色でピッカーが選択状態 |
| `e2e/undo-redo.spec.ts` | T29: 矢印→矩形→モザイクをCmd+Z×3で元画像と完全一致・Cmd+Shift+Z×3で描いた後と一致・ボタンでも1操作ずつ/編集中の図形はCmd+Z・ボタンで破棄されやり直し対象にならない(T32で「描いた直後の図形も取り消し後にやり直せる」に変更)/編集中はやり直し無効/テキスト入力中のCmd+ZはCanvasに作用しない/新規キャプチャでスタックが空になる |
| `e2e/text-tool.spec.ts` | T27: 入力+Enterで注釈色の画素が増え入力欄が消える/Escで何も残らない/IME変換中のEnterでは確定しない/入力中のCmd+Cはアプリのコピーに奪われず、コピーボタンで確定後の画像がコピーされ入力欄の枠(白)は写らない/空のままツール切替で何も焼き込まない |
| `e2e/text-object.spec.ts` | T33: テキストツール中に確定済みテキストをクリックで選択(入力欄は開かない)→移動→Cmd+Zで元の位置とバイト一致/ダブルクリックで元の文字入りの入力欄→IME変換中のEnterで確定しない→Enterで変更→Cmd+Z・Cmd+Shift+Zで往復/再編集のEscは編集前のまま・空にして確定で削除・Cmd+Zで戻る/ツール未選択・矢印ツール中もダブルクリックで再編集、モザイク中は開かない |
| `e2e/v020-feedback.spec.ts` | v0.2.0後フィードバック: トーストの自動消去(`page.clock`で時計を止め、コピー成功は2.5秒+フェード200ms・エラーは5秒で消え権限バナーは残る・reduced-motionはフェードなし)/矩形の角丸(白画像で角の外側が白・辺の中央と円弧上が注釈色)/21件目のキャプチャで最古の履歴が消え20件(`tauriMock`の`captureResults`で回ごとに別id) |
| `e2e/object-ops.spec.ts` | T34: Delete/Backspaceで削除・Cmd+Zで戻る・入力欄のBackspaceは文字削除/選択中に色見本で色が変わり選択は外れず取り消せる・以後の描画色も変わる/テキスト選択中に文字サイズ大で大きくなり取り消せる/最前面へ・最背面へ(ボタン・⌘⇧F/⌘⇧B)で交点の色が入れ替わり選択中のみ有効・取り消せる/2枚目をキャプチャして1枚目へ戻っても矩形を選んで動かせ、Cmd+Zで移動→切り替え前の描画の順に戻る・2枚目の矩形も選べる |
| `e2e/shape-edit.spec.ts` | T31: 編集中の図形はコピー時に確定されて写りハンドル(白)は写らない(コピーRGBA=Canvas、近白画素0)/矩形の右下ハンドルでリサイズ/矢印の胴体ドラッグで移動+Enter確定/Escで破棄/次の図形の描き始めで直前の図形が確定。T32で後ろ2件を「Escは選択解除でCmd+Zで描く前に戻る」「次の図形を描いても前の図形は残り、取り消しは新しい方から」に変更 |
| `e2e/object-layer.spec.ts` | T32: 確定後の矢印を選び直して移動・リサイズ→Cmd+Z×2で編集前とバイト一致/51個目で最古が焼き込まれ選べなくなり、1回の取り消しで戻る/選択中(ハンドル表示中)のCmd+Cでもコピー結果にハンドルが写らない/モザイクはベースにだけ効き上の矩形は隠れず後から動かせる/テキストはベースへ焼き込まれ矩形より下(T33で「テキストもオブジェクトとして重ね順に入り、後から置けば矩形より上・Cmd+Zで消える」に変更) |
| `e2e/capture-flow.spec.ts` | ①「キャプチャ→矢印描画→モザイク適用→クリップボードコピーで履歴に1件表示・選択される」: キャプチャボタン押下 → `capture_screen`モック(`capture://completed`をemit)→ Canvasに画像表示 → 矢印ツールへ切替・ドラッグ(既定色`#FF5C8A`付近の画素を`getImageData()`で検証)→ モザイクツールへ切替(排他確認)・ドラッグ(ブロック平均によるピクセル変化を検証)→「クリップボードにコピー」(`plugin:image|new`→`plugin:clipboard-manager|write_image`呼び出し回数で成功を検証)→ 成功フィードバック表示 → 履歴サイドバー(`#history-sidebar`)に1件・選択状態(`.history-sidebar__item--selected`)。②「画面収録権限が未許可(permission_denied)の場合、キャプチャ実行時に権限バナーが表示される」: `capture_screen`が`"permission_denied"`でrejectする場合に`.permission-banner`が表示されることを検証(T13実装時点で既知の不具合(project-config.md §11参照)により本テストはfailする) |

fixture画像は `e2e/fixtures/sampleCapturePng.ts` が `node:zlib` のみでチェッカーボードPNGを
生成する(依存追加なし)。画像は`read_capture_image`モック(`captureImageBase64`)で渡す。
`convertFileSrc()`モックは実機と同じく別オリジン(`http://asset.localhost/...`)を返し、
`routeCrossOriginAssets()`がasset protocolと同じ`Access-Control-Allow-Origin`付きで配信する
(以前は同一オリジンの相対パスにしていたため、実機のCanvas汚染(不具合②〜⑤)を検出できなかった。
asset URLを`<img>`で読む実装に戻ると①のフローが失敗する)。①は最後に「画像の表示に失敗しました。」
が出ていないこと・`pageerror`/`console.error`が無いことも検証する。

## ドキュメント責務

| ファイル                      | 責務                                                   |
| ----------------------------- | ------------------------------------------------------ |
| `docs/project.md`             | ルート定義、ストア一覧、コマンド、技術スタック         |
| `docs/architecture.md`        | ディレクトリ構成、テスト一覧、ドキュメント責務         |
| `docs/data-model.md`          | スキーマ定義、フィールド仕様、バリデーションルール     |
| `docs/development-patterns.md`| コード規約、落とし穴、E2Eテストパターン、デザインシステム |
