//! `#[tauri::command]` 関数を集約するモジュール。
//!
//! レイヤー構成(ARCH §3.1・§3.2)により、新規の Tauri コマンドは必ず
//! このファイルに追加し、呼び出し口を一元化する。他モジュールから直接
//! `#[tauri::command]` を追加しないこと。各関数はフロントエンドへの
//! 構造化エラー伝達のため `crate::error::AppError` を返す。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

use crate::capture::{self, CaptureKind, CaptureOutcome, CaptureResult, RunError, ScreenRecordingPermission};
use crate::clipboard;
use crate::error::AppError;
use crate::window_front::{self, ActivationOrigin};

/// `capture::run()` の結果を通知する Tauri イベント名(ARCH §7.1 手順4)。
///
/// アプリ内ボタン起点(このコマンド)・グローバルショートカット起点(T16)・
/// トレイメニュー起点(T15)のいずれも同じイベントで通知し、フロントエンドは
/// 起点を区別しない設計にしてある(ARCH §5.2)。
pub(crate) const CAPTURE_COMPLETED_EVENT: &str = "capture://completed";

/// アプリ内ボタン・トレイ「キャプチャ」・グローバルショートカットの3起点が
/// 共有する実行中排他フラグ(T16、PJM指摘対応)。
///
/// `screencapture -i` はユーザーの選択が終わるまで戻らないため、3起点のいずれか
/// で実行中に他の起点から再度呼ばれても多重起動しないよう、[`try_begin_capture`]
/// で排他的に開始し [`end_capture`] で解放する(最小実装。専用の状態機械やロックは
/// 導入せず `AtomicBool` の compare-and-exchange のみで足りると判断した)。
static CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// 実行中でなければ排他的にキャプチャ開始状態へ遷移し `true` を返す純粋ロジック。
///
/// 既に実行中(他の起点が実行中)なら状態を変更せず `false` を返す(呼び出し元は
/// 何もしない=多重起動防止)。Tauriランタイムに依存しないためユニットテスト可能。
fn try_begin_capture() -> bool {
    CAPTURE_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// キャプチャ実行中フラグを解放する(成功・失敗を問わず [`run_capture`] の終了時に必ず呼ぶ)。
fn end_capture() {
    CAPTURE_IN_PROGRESS.store(false, Ordering::SeqCst);
}

/// キャプチャを1回実行するコマンド(ARCH §7.1 手順1-4)。
///
/// アプリ内ボタン(本コマンド)からの呼び出しであり、実処理は [`run_capture`] に
/// 委譲する(トレイメニュー「キャプチャ」(T15, `tray.rs`)・グローバルショートカット
/// (T16, `shortcuts.rs` → `tray::run_capture_and_show_editor`)と共通の処理、
/// ARCH §1.1「いずれも既存の capture::run() 系コマンドを再利用する」)。
///
/// # メインスレッドを塞がない(T16、PJM指摘対応)
///
/// Tauri公式ドキュメント(<https://v2.tauri.app/develop/calling-rust/#async-commands>)の
/// 記載どおり、`async` を付けないコマンドは既定でメインスレッド(UI・イベントループと
/// 同じスレッド)で実行される。`screencapture -i` はユーザーの範囲選択が終わるまで
/// 戻らないブロッキング呼び出しのため、これを非asyncコマンドの中で直接呼ぶと
/// アプリ全体が固まる。本コマンドは `async fn` にすることで
/// `tauri::async_runtime::spawn`(公式ドキュメントに記載)経由の別タスクで実行され、
/// さらに [`run_capture`] 内部で実際のブロッキング処理を
/// `tauri::async_runtime::spawn_blocking`(<https://docs.rs/tauri/latest/tauri/async_runtime/fn.spawn_blocking.html>、
/// 「Runs the provided function on an executor dedicated to blocking operations」)
/// へ逃がすことで、メインスレッドはもちろん非同期タスク用のワーカースレッドプールも
/// 塞がないようにしてある。
#[tauri::command]
pub async fn capture_screen(app: AppHandle) -> Result<Option<CaptureResult>, AppError> {
    // 押下(invoke呼び出し)を受けた時刻を起点として記録する(NFR-001中間計測、
    // T11、origin="button")。フロント側のclickからinvoke到達までの時間は含まない
    // (判断根拠は `testreport/nfr-001/README.md` 参照)。
    run_capture(&app, "button", Instant::now()).await
}

/// キャプチャを1回実行し、成功時は `capture://completed` イベントを emit する共通処理。
///
/// 画面収録権限が未許可、またはI/Oエラーで `screencapture` を起動できなかった
/// 場合は `Err` を返す。Escキャンセル([`CaptureOutcome::Cancelled`])は画像が
/// 生成されないため `Ok(None)` を返し(エラー扱いしない)、イベントも送出しない
/// (通知すべき画像情報が無いため)。撮影に成功した場合のみ
/// [`CaptureResult`] を構築し、`capture://completed` イベントで送出したうえで
/// `Ok(Some(result))` を返す。
///
/// 他の起点が実行中の場合([`try_begin_capture`] が `false`)は何もせず
/// `Ok(None)` を返す(多重起動防止。エラー扱いしない、T16指示「最小実装」)。
///
/// アプリ内ボタン([`capture_screen`])・トレイメニュー「キャプチャ」(T15)・
/// グローバルショートカット(T16)の3経路が本関数を共有する(重複実装回避)。
/// 実際に `screencapture` を起動する [`capture::run`] の呼び出しは
/// `tauri::async_runtime::spawn_blocking` に包み、メインスレッド・非同期ワーカーの
/// いずれもブロックしないようにしてある(上記 [`capture_screen`] のdocコメント参照)。
///
/// `origin`(`"button"`/`"tray"`/`"shortcut"`)・`start` は NFR-001 中間計測
/// (T11)のために `capture::run` へそのまま引き渡す。
pub(crate) async fn run_capture(
    app: &AppHandle,
    origin: &'static str,
    start: Instant,
) -> Result<Option<CaptureResult>, AppError> {
    if !try_begin_capture() {
        return Ok(None);
    }

    let join_result =
        tauri::async_runtime::spawn_blocking(move || capture::run(origin, start)).await;
    end_capture();

    let run_result = join_result.map_err(|e| AppError::Internal(e.to_string()))?;
    let (outcome, source_path) = run_result.map_err(app_error_from_run_error)?;
    let Some(result) = capture_result_for(outcome, source_path) else {
        return Ok(None);
    };
    app.emit(CAPTURE_COMPLETED_EVENT, &result)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Some(result))
}

/// [`RunError`] を [`AppError`] へ変換する純粋関数。
///
/// `PermissionDenied` はフロントエンドが専用の案内導線(T08)へ分岐できるよう
/// 専用バリアントへ、`Io` は一般エラーへ変換する(T05→T06 申し送り決定)。
/// Tauriのランタイムに依存しないためユニットテスト可能。
fn app_error_from_run_error(err: RunError) -> AppError {
    match err {
        RunError::PermissionDenied => AppError::PermissionDenied,
        RunError::Io(e) => AppError::Internal(e.to_string()),
    }
}

/// `capture::run()` の結果から [`CaptureResult`] を構築する純粋関数。
///
/// `Cancelled` の場合は画像が存在しないため `None` を返す(エラー扱いしない、
/// ARCH §7.1 手順3)。Tauriのランタイムに依存しないためユニットテスト可能。
fn capture_result_for(outcome: CaptureOutcome, source_path: PathBuf) -> Option<CaptureResult> {
    match outcome {
        CaptureOutcome::Cancelled => None,
        CaptureOutcome::Completed => Some(CaptureResult {
            id: id_from_path(&source_path),
            source_path,
            kind: CaptureKind::Range,
            created_at: now_iso8601_utc(),
        }),
    }
}

/// 一時ファイルパスのファイル名(拡張子を除く)を識別子として使う純粋関数。
///
/// `capture::generate_capture_path` がプロセスID・ナノ秒・連番の組み合わせで
/// 既に一意性を保証しているファイル名を生成しているため(`capture/tempfile.rs`)、
/// `uuid` 等の追加クレートを導入せず流用する(NFR-003)。
fn id_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("capture")
        .to_string()
}

/// 現在時刻を ISO8601(UTC)文字列で返す(PRD §5 `Capture.createdAt`)。
fn now_iso8601_utc() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    iso8601_utc_from_unix_millis(millis)
}

/// UNIX epoch からの経過ミリ秒を ISO8601(UTC、`YYYY-MM-DDTHH:MM:SS.sssZ`)形式の
/// 文字列へ変換する純粋関数。
///
/// `chrono` 等の日付クレートを追加せず標準ライブラリのみで実装する
/// (T05→T06 申し送り決定、NFR-003)。日付計算(ミリ秒 → 年月日)は Howard
/// Hinnant の `civil_from_days` アルゴリズム
/// (<https://howardhinnant.github.io/date_algorithms.html>)を用いる。西暦
/// 1970年以降のグレゴリオ暦について、うるう年・月末日数の判定を含め整数演算
/// のみで正確に計算できることが広く検証されているアルゴリズムであり、自前で
/// カレンダーロジックを再実装するより信頼性が高い。
fn iso8601_utc_from_unix_millis(millis: u128) -> String {
    let total_seconds = (millis / 1000) as i64;
    let millis_part = (millis % 1000) as u32;
    let days = total_seconds.div_euclid(86_400);
    let secs_of_day = total_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis_part:03}Z"
    )
}

/// UNIX epoch(1970-01-01)からの経過日数を (年, 月, 日) へ変換する純粋関数。
/// Howard Hinnant の `civil_from_days` アルゴリズムの移植(上記 doc 参照)。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

/// システム設定「プライバシーとセキュリティ→画面収録」を開くURL(NFR-002)。
///
/// 【仮定】Apple非公式・未文書化のURLスキームだが、macOS 14 Sonoma を含む
/// 広い範囲での動作実績が確認されている(ARCH §2・§15要確認#1決定)。将来の
/// macOSバージョンで変更される可能性を許容した上で採用する。ユーザー入力や
/// 外部由来の値と混ざらないよう、この固定文字列以外を `opener` プラグインへ
/// 渡さない(ARCH §12「システム設定を開く導線の安全性」)。
const SCREEN_RECORDING_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/// 画面収録権限を確認するコマンド(NFR-002、T08)。
///
/// フロントエンドの起動時事前確認(`src/main.ts`)から呼ばれる。未許可の場合は
/// `capture::ensure_screen_recording_access()` が
/// `capture::request_screen_recording_access()`(`CGRequestScreenCaptureAccess`)を
/// 1回呼び、OSの許可ダイアログ表示とシステム設定「画面収録」一覧へのアプリ登録を
/// 行う(呼ばないと一覧に現れず、ユーザーが許可を与える手段自体が無くなる恐れが
/// あるため。PJM決定 2026-09-23)。既に許可済みならダイアログを表示しない。
///
/// # メインスレッドを塞がない
///
/// CoreGraphicsのFFI呼び出し(ダイアログ表示を伴いうる)をメインスレッド・非同期
/// ワーカーのいずれも塞がないよう、`capture_screen`(T06)と同じ方針で `async fn`
/// にし、実処理を `tauri::async_runtime::spawn_blocking` へ退避する。
#[tauri::command]
pub async fn check_screen_recording_permission() -> Result<ScreenRecordingPermission, AppError> {
    tauri::async_runtime::spawn_blocking(capture::ensure_screen_recording_access)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))
}

/// システム設定の「プライバシーとセキュリティ→画面収録」を開くコマンド(NFR-002、T08)。
///
/// フロントエンドから渡された値ではなく固定URL([`SCREEN_RECORDING_SETTINGS_URL`])
/// のみを `opener` プラグインへ渡す(ユーザー入力・外部由来の値は使わない、ARCH §12)。
/// `tauri-plugin-opener` の内部実装(`open::that_detached`)はプロセスを起動する
/// だけで完了を待たないため、`capture_screen`/`check_screen_recording_permission`と
/// 異なりブロッキングI/Oを伴わず、`async`/`spawn_blocking` は不要と判断した。
#[tauri::command]
pub fn open_screen_recording_settings(app: AppHandle) -> Result<(), AppError> {
    app.opener()
        .open_url(SCREEN_RECORDING_SETTINGS_URL, None::<&str>)
        .map_err(|e| AppError::Internal(e.to_string()))
}

/// キャプチャ画像(PNG)のバイト列をフロントエンドへ返すコマンド(実機不具合②〜⑤の修正)。
///
/// # asset protocol を使わない理由
///
/// 以前は `convertFileSrc()` の asset URL(`asset://localhost/...`)を `<img>` で読み
/// Canvasへ描画していたが、asset URLはwebviewのオリジン(dev: `http://localhost:1420`、
/// 本番: `tauri://localhost`)と別オリジンであり、`crossOrigin` 無しの `<img>` は
/// no-corsで読まれるため、描画した時点でCanvasが汚染(tainted)され
/// `getImageData()`/`toBlob()` が `SecurityError` になっていた(矢印・モザイク・
/// コピー・履歴がすべて失敗)。バイト列をIPCで受け取りフロントで
/// `Blob` → `URL.createObjectURL()`(同一オリジン扱い)にすれば、オリジンの差・
/// asset protocolのscope(`/var`→`/private/var`問題)・CSPの設定に左右されない。
///
/// # 生バイナリでの返却
///
/// `Vec<u8>` をそのまま返すとJSON配列(10進数文字列)へ膨張するため、
/// [`tauri::ipc::Response`](公式ドキュメント
/// <https://v2.tauri.app/develop/calling-rust/#returning-array-buffers>)で
/// `ArrayBuffer` として返す。
///
/// # 読み出し範囲の制限
///
/// `path` はフロントエンドから渡される値のため、正規化したうえでキャプチャ専用
/// ディレクトリ直下の `.png` 通常ファイルに限定する(`capture::read_capture_file`)。
/// ファイル読込はブロッキングI/Oのため `spawn_blocking` へ退避する(既存方針)。
#[tauri::command]
pub async fn read_capture_image(path: String) -> Result<Response, AppError> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        capture::read_capture_file(Path::new(&path))
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
    .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Response::new(bytes))
}

/// `write_image_fallback` が画像サイズを受け取るヘッダー名(フロントの
/// `src/ipc/clipboard.ts` と一致させる必要がある。T12)。
const IMAGE_WIDTH_HEADER: &str = "x-tadcap-image-width";
const IMAGE_HEIGHT_HEADER: &str = "x-tadcap-image-height";

/// Canvasの最終画像(RGBA8)をクリップボードへ書き込むRustフォールバックコマンド
/// (FR-005、T12、ARCH §15決定#3)。
///
/// `@tauri-apps/plugin-clipboard-manager` の `writeImage()`(主経路)が失敗した
/// 場合のみ `src/ipc/clipboard.ts` から呼ばれる。`arboard` はPNG/ICO等のデコードを
/// 行わず生のRGBA8ピクセル列(`width * height * 4` バイト)を要求するため、
/// フロントエンドはCanvasの `getImageData()` 由来のRGBAをそのまま渡す設計にした
/// (PNGバイト列をデコードするクレート(`image`/`png`等)を追加しないための判断。
/// ARCH §2・§15決定#3は `arboard` のみをフォールバックの追加依存として承認して
/// いる)。
///
/// # 生ボディでの受け渡し(IPC転送コスト対応、T12指示)
///
/// 画像バイト列は通常の(JSONシリアライズされる)`Vec<u8>` 引数ではなく、
/// `tauri::ipc::Request` の生ボディ(公式ドキュメント
/// <https://v2.tauri.app/develop/calling-rust/#accessing-raw-request>「Tauri
/// commands can also access the full `tauri::ipc::Request` object ... This
/// allows commands to accept raw bytes」)で受け取る。`Vec<u8>` 引数はフロント→
/// バックエンドの送信時に要素ごとにカンマ区切りの10進数文字列(JSON配列)へ展開
/// されるため、5K Retina全画面キャプチャ相当(数千万バイトのRGBA)では数十MBの
/// 文字列に膨らみうる。生ボディ(`ArrayBuffer`/`Uint8Array`)はこの膨張を避けられる
/// ため、フォールバック(頻度は低いが1回のペイロードが大きくなりうる経路)にこそ
/// 適していると判断した。`width`/`height` はボディに混在させず、`invoke()` の
/// 第三引数 `headers` で渡す([`IMAGE_WIDTH_HEADER`]/[`IMAGE_HEIGHT_HEADER`])。
///
/// # メインスレッドを塞がない
///
/// `capture_screen`(T06)・`check_screen_recording_permission`(T08)と同じ方針
/// (project-config.md §2「Rustコマンドの非同期化」)で `async fn` にし、実際の
/// クリップボード書込(`clipboard::write_image_fallback`)は
/// `tauri::async_runtime::spawn_blocking` へ退避する。`arboard` のOSクリップボード
/// APIはユーザー操作の完了を待つものではないが、既存タスクの一貫した方針として
/// 踏襲する(T12指示)。
#[tauri::command]
pub async fn write_image_fallback(request: Request<'_>) -> Result<(), AppError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Internal(
            "画像データはバイナリ形式(生ボディ)で渡す必要があります".to_string(),
        ));
    };
    let width_header = request
        .headers()
        .get(IMAGE_WIDTH_HEADER)
        .and_then(|value| value.to_str().ok());
    let height_header = request
        .headers()
        .get(IMAGE_HEIGHT_HEADER)
        .and_then(|value| value.to_str().ok());
    let (width, height) =
        parse_image_dimensions(width_header, height_header).map_err(AppError::Internal)?;
    let bytes = bytes.clone();

    tauri::async_runtime::spawn_blocking(move || {
        clipboard::write_image_fallback(width, height, bytes)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
    .map_err(app_error_from_clipboard_error)
}

/// `IMAGE_WIDTH_HEADER`/`IMAGE_HEIGHT_HEADER` の値(文字列)を `(width, height)` へ
/// パースする純粋関数(cargo testで検証可能)。
///
/// `tauri::ipc::Request` はTauriランタイムに依存するため直接構築してテストできない
/// (`commands.rs` の既存方針、`app_error_from_run_error` 等と同じ)。ヘッダー値の
/// 有無・数値変換の可否だけを切り出してユニットテストする(T12指示「Rust側の
/// 入力検証」)。
///
/// # 上限チェック(セキュリティHIGH対応、Phase5指摘)
///
/// ヘッダー値は外部(フロントエンド、あるいは細工されたIPC呼び出し)から渡される
/// 数値文字列であり、`usize::parse` 自体は巨大な値(例: 2^32)でも成功しうる。
/// 後段の `clipboard::validate_rgba` が `width * height * 4` を計算する前に、
/// ここでも同じ上限([`clipboard::MAX_IMAGE_DIMENSION`]、定数は1か所にのみ定義)を
/// 早期に検査し、不正な値をできるだけ早く弾く(防御多層化)。
fn parse_image_dimensions(
    width: Option<&str>,
    height: Option<&str>,
) -> Result<(usize, usize), String> {
    let width = width
        .ok_or_else(|| format!("ヘッダー {IMAGE_WIDTH_HEADER} がありません"))?
        .parse::<usize>()
        .map_err(|_| format!("ヘッダー {IMAGE_WIDTH_HEADER} の値が不正です"))?;
    let height = height
        .ok_or_else(|| format!("ヘッダー {IMAGE_HEIGHT_HEADER} がありません"))?
        .parse::<usize>()
        .map_err(|_| format!("ヘッダー {IMAGE_HEIGHT_HEADER} の値が不正です"))?;
    if width > clipboard::MAX_IMAGE_DIMENSION || height > clipboard::MAX_IMAGE_DIMENSION {
        return Err(format!(
            "画像サイズが上限を超えています(width={width}, height={height}, 上限={}px)",
            clipboard::MAX_IMAGE_DIMENSION
        ));
    }
    Ok((width, height))
}

/// [`clipboard::ClipboardFallbackError`] を [`AppError`] へ変換する純粋関数。
///
/// フロントエンドはフォールバック失敗の種別を判別する必要が無い(短い失敗
/// フィードバック表示のみ、T12仕様)ため専用バリアントは追加せず `Internal` に
/// 集約する(YAGNI、`error.rs` のバリアント追加方針と同じ)。
fn app_error_from_clipboard_error(err: clipboard::ClipboardFallbackError) -> AppError {
    AppError::Internal(err.to_string())
}


/// テキスト入力欄がフォーカスを得たときに、アプリが非アクティブならアクティブ化を要求する
/// (v0.2.2、実機不具合「テキスト入力で全角文字が入らない」)。
///
/// macOSの入力メソッド(日本語IME)はアクティブなアプリの入力にだけ働く。Dock非表示の本アプリは
/// 撮影後に非アクティブのまま前面化されうる(`window_front.rs`、B2)。既にアクティブ・
/// ウィンドウ非表示なら何もしない(`window_front::should_request_activation`)。要求はOSに
/// 拒否されうるが失敗扱いにはしない(フロントが短い遅延で1回だけ再試行する、`src/ipc/app.ts`)。
#[tauri::command]
pub async fn activate_app(app: AppHandle) -> Result<(), AppError> {
    window_front::ensure_app_active(&app, ActivationOrigin::TextInput);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{CaptureKind, CaptureOutcome, RunError};
    use std::path::PathBuf;

    #[test]
    fn app_error_from_run_error_はpermission_deniedを専用バリアントへ変換する() {
        let err = app_error_from_run_error(RunError::PermissionDenied);
        assert!(matches!(err, AppError::PermissionDenied));
    }

    #[test]
    fn app_error_from_run_error_はioエラーをinternalへ変換する() {
        let io_err = std::io::Error::other("boom");
        let err = app_error_from_run_error(RunError::Io(io_err));
        match err {
            AppError::Internal(msg) => assert_eq!(msg, "boom"),
            _ => panic!("Internalへ変換されるべき"),
        }
    }

    #[test]
    fn capture_result_for_はcancelled時にnoneを返す() {
        let result = capture_result_for(CaptureOutcome::Cancelled, PathBuf::from("/tmp/x.png"));
        assert!(result.is_none());
    }

    #[test]
    fn capture_result_for_はcompleted時に結果を構築する() {
        let path = PathBuf::from("/tmp/tadcap-captures/capture-1-0-2.png");
        let result = capture_result_for(CaptureOutcome::Completed, path.clone())
            .expect("Completedならcapture_resultを返すはず");

        assert_eq!(result.source_path, path);
        assert_eq!(result.kind, CaptureKind::Range);
        assert_eq!(result.id, "capture-1-0-2");
        assert!(
            !result.created_at.is_empty(),
            "created_atが空であってはならない"
        );
    }

    #[test]
    fn id_from_path_はファイル名から拡張子を除いた文字列を返す() {
        let path = PathBuf::from("/tmp/tadcap-captures/capture-123-4-5.png");
        assert_eq!(id_from_path(&path), "capture-123-4-5");
    }

    #[test]
    fn id_from_path_は拡張子がない場合はファイル名全体を返す() {
        let path = PathBuf::from("/tmp/tadcap-captures/no-extension");
        assert_eq!(id_from_path(&path), "no-extension");
    }

    #[test]
    fn iso8601_utc_from_unix_millis_はepoch起点を正しく変換する() {
        assert_eq!(
            iso8601_utc_from_unix_millis(0),
            "1970-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn iso8601_utc_from_unix_millis_は西暦2000年1月1日を正しく変換する() {
        assert_eq!(
            iso8601_utc_from_unix_millis(946_684_800_000),
            "2000-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn iso8601_utc_from_unix_millis_は西暦2024年1月1日を正しく変換する() {
        assert_eq!(
            iso8601_utc_from_unix_millis(1_704_067_200_000),
            "2024-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn iso8601_utc_from_unix_millis_はうるう年の2月29日を正しく変換する() {
        // 2020-02-29T00:00:00Z(うるう日)。日付計算アルゴリズムの分岐カバレッジ。
        assert_eq!(
            iso8601_utc_from_unix_millis(1_582_934_400_000),
            "2020-02-29T00:00:00.000Z"
        );
    }

    #[test]
    fn iso8601_utc_from_unix_millis_は時分秒とミリ秒を正しくフォーマットする() {
        // 2024-01-01T00:00:00Z + 12h34m56.789s
        let millis = 1_704_067_200_000 + (12 * 3600 + 34 * 60 + 56) * 1000 + 789;
        assert_eq!(
            iso8601_utc_from_unix_millis(millis),
            "2024-01-01T12:34:56.789Z"
        );
    }

    /// 3起点(ボタン・トレイ・ショートカット)共有の実行中排他フラグ
    /// ([`try_begin_capture`]/[`end_capture`])のテスト(T16、PJM指摘対応)。
    ///
    /// `CAPTURE_IN_PROGRESS` はモジュール単位の `static` であり本テストのみが
    /// 触るため、1つのテスト関数内で開始→多重呼び出し→解放→再開始の一連の
    /// 遷移を検証する(他のテストと並行実行されても干渉しない)。
    #[test]
    fn try_begin_capture_は実行中でなければtrueを返し多重起動を防ぐ() {
        // 前提: 他のテストはこのフラグを触らないため、テスト開始時点はfalseのはず。
        // 念のため既知の状態から始める。
        end_capture();

        assert!(
            try_begin_capture(),
            "実行中でなければ最初の呼び出しはtrueを返すはず"
        );
        assert!(
            !try_begin_capture(),
            "既に実行中の2回目の呼び出しはfalseを返し多重起動を防ぐはず"
        );
        assert!(
            !try_begin_capture(),
            "実行中である限り何度呼んでもfalseのはず(押しっぱなし等の多重発火を想定)"
        );

        end_capture();

        assert!(
            try_begin_capture(),
            "end_capture後は再度trueを返し、次のキャプチャを開始できるはず"
        );

        end_capture(); // 後続テストのためフラグをリセットしておく
    }

    /// `open_screen_recording_settings`(T08)が渡す固定URLの回帰テスト(NFR-002)。
    ///
    /// `AppHandle` を要する実際のコマンド呼び出し(`opener`プラグイン経由でOSの
    /// システム設定アプリを開く部分)はTauriランタイム・OSネイティブ導線に依存する
    /// ため自動テスト対象外とし、手動確認チェックリスト#2へ回す。この定数だけを
    /// 独立してテストし、タイプミス等による不正なURL送出を防ぐ。
    #[test]
    fn screen_recording_settings_urlは画面収録設定を指す固定文字列である() {
        assert_eq!(
            SCREEN_RECORDING_SETTINGS_URL,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        );
    }

    /// [`parse_image_dimensions`](T12)のテスト。`write_image_fallback` が受け取る
    /// ヘッダー値(width/height)の検証ロジックを、Tauriランタイムに依存せず検証する
    /// (T12指示「Rust側の入力検証(空・不正バイト列)」の一部)。
    #[test]
    fn parse_image_dimensions_は正しい入力をusizeのタプルとして返す() {
        assert_eq!(
            parse_image_dimensions(Some("1920"), Some("1080")),
            Ok((1920, 1080))
        );
    }

    #[test]
    fn parse_image_dimensions_はwidthヘッダーが無ければエラーを返す() {
        assert!(parse_image_dimensions(None, Some("1080")).is_err());
    }

    #[test]
    fn parse_image_dimensions_はheightヘッダーが無ければエラーを返す() {
        assert!(parse_image_dimensions(Some("1920"), None).is_err());
    }

    #[test]
    fn parse_image_dimensions_は数値に変換できない値を拒否する() {
        assert!(parse_image_dimensions(Some("abc"), Some("1080")).is_err());
        assert!(parse_image_dimensions(Some("1920"), Some("abc")).is_err());
    }

    #[test]
    fn parse_image_dimensions_は空文字列を拒否する() {
        assert!(parse_image_dimensions(Some(""), Some("1080")).is_err());
    }

    #[test]
    fn parse_image_dimensions_は負の数を拒否する() {
        // usizeへのparseのため負数はそのままエラーになる(境界値)。
        assert!(parse_image_dimensions(Some("-1"), Some("1080")).is_err());
    }

    /// [`parse_image_dimensions`] の上限チェック(セキュリティHIGH対応、Phase5指摘)。
    #[test]
    fn parse_image_dimensions_は各辺上限ちょうどの値を受理する() {
        let max = clipboard::MAX_IMAGE_DIMENSION;
        assert_eq!(
            parse_image_dimensions(Some(&max.to_string()), Some("10")),
            Ok((max, 10))
        );
    }

    #[test]
    fn parse_image_dimensions_は上限を超えるwidthを拒否する() {
        let huge = clipboard::MAX_IMAGE_DIMENSION + 1;
        assert!(parse_image_dimensions(Some(&huge.to_string()), Some("10")).is_err());
    }

    #[test]
    fn parse_image_dimensions_は上限を超えるheightを拒否する() {
        let huge = clipboard::MAX_IMAGE_DIMENSION + 1;
        assert!(parse_image_dimensions(Some("10"), Some(&huge.to_string())).is_err());
    }

    #[test]
    fn parse_image_dimensions_は極端に大きい数値文字列2の32乗を上限超過として拒否する() {
        assert!(parse_image_dimensions(Some("4294967296"), Some("10")).is_err());
    }

    /// [`app_error_from_clipboard_error`](T12)のテスト。`app_error_from_run_error`
    /// と同じ構成(`ClipboardFallbackError → AppError::Internal` 変換)。
    #[test]
    fn app_error_from_clipboard_error_はメッセージをinternalへ変換する() {
        let err = app_error_from_clipboard_error(
            crate::clipboard::ClipboardFallbackError::InvalidDimensions,
        );
        match err {
            AppError::Internal(msg) => assert!(msg.contains("width")),
            _ => panic!("Internalへ変換されるべき"),
        }
    }
}
