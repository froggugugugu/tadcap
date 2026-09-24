//! キャプチャ機能を閉じ込めるモジュール(ARCH §3.1・§4)。
//!
//! `screencapture -i` の実行方式を `CaptureProvider` trait の背後に隠し、将来
//! ScreenCaptureKit 等の別実装へ差し替え可能にする(PRD §7 決定ログ#2、
//! ARCH §1.3 決定#2)。`run()` が権限事前確認・一時ファイル生成・
//! `ScreenCaptureCli` 起動までを結線し、`commands::capture_screen`(T06)から
//! 呼び出される。

mod tempfile;

pub use tempfile::{cleanup_capture_files, generate_capture_path, read_capture_file};

mod permission;

pub use permission::{
    preflight_screen_recording_access, request_screen_recording_access, ScreenRecordingPermission,
};

mod screencapture;

pub use screencapture::ScreenCaptureCli;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

/// `CaptureProvider::capture` の実行結果。
///
/// 権限未許可やプロセス起動失敗は `Result::Err` 側(呼び出し元のエラー型)で
/// 表現するため、この型は「screencaptureが正常終了したか(`Completed`)、
/// Escでキャンセルされ、ファイルが生成されなかったか(`Cancelled`)」の
/// 2分岐のみを表す(ARCH §7.1)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureOutcome {
    /// 撮影成功。ファイルは `dest` に書き出し済み。
    Completed,
    /// Escキー等でユーザーがキャンセルし、ファイルが生成されなかった。
    Cancelled,
}

/// キャプチャの実行方式を抽象化する trait(ARCH §1.3 決定#2、§5.1)。
///
/// MVP では `screencapture -i` を呼ぶ実装(T05 `ScreenCaptureCli`)のみを登録する。
/// 将来 ScreenCaptureKit 実装を追加する場合はこの trait を実装するだけでよく、
/// `commands.rs` 以降は変更不要な設計にしてある(ARCH §16)。過剰な抽象化を避け、
/// メソッドは1つのみに絞る。
pub trait CaptureProvider {
    /// `dest` へ画像を書き出す。キャンセル時はファイルを生成しない。
    ///
    /// `on_spawn` はキャプチャ用プロセスの起動(`Command::spawn()` 等)が完了した
    /// 直後に必ず1回呼ぶこと(NFR-001 中間計測用フック、T11)。「OS の選択 UI が
    /// 実際に画面へ表示された瞬間」そのものではなく、その近似値であることに注意
    /// (PRD NFR-001 計測方法参照。`screencapture` プロセスの起動完了を選択UI表示の
    /// 近似として扱う)。
    fn capture(&self, dest: &Path, on_spawn: &mut dyn FnMut()) -> std::io::Result<CaptureOutcome>;
}

/// PRD §5 `Capture.kind`(`"range"` | `"window"`)。
///
/// ARCH §15 要確認#2 決定(A案)により MVP では常に `Range` のみを構築する。
/// `screencapture -i` はユーザーがスペースキーでウィンドウ選択に切り替えても
/// 呼び出し元に通知しないため、`Window` は MVP では発生しない(YAGNI により
/// バリアント自体を追加しない。必要になった時点で追加する)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureKind {
    Range,
}

/// PRD §5 の `Capture` モデルに対応するキャプチャ結果。
///
/// ARCH §7.1 の Tauriイベント `capture://completed` で送出する値の元になる
/// (実際の構築・送出は `commands::capture_screen`、T06 で行う)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub id: String,
    pub source_path: PathBuf,
    pub kind: CaptureKind,
    /// ISO8601 形式の文字列(PRD §5)。生成は T06 で行う。
    pub created_at: String,
}

/// [`run`] の失敗系(ARCH §7.1 手順2-3)。
///
/// Escキャンセルでファイルが生成されなかった場合は `Err` ではなく
/// `Ok(CaptureOutcome::Cancelled)` で表現する(エラー扱いしない、T05 受け入れ
/// 条件)。ここに含むのは「そもそも `screencapture` を起動できなかった/
/// 起動しなかった」ケースのみ。
#[derive(Debug)]
pub enum RunError {
    /// 画面収録権限が未許可のため `screencapture` を起動しなかった(NFR-002)。
    PermissionDenied,
    /// 一時ファイルパスの生成、またはプロセス起動自体に伴うI/Oエラー。
    Io(std::io::Error),
}

/// キャプチャを1回実行する(ARCH §7.1 手順2-3)。
///
/// 画面収録権限を事前確認([`preflight_screen_recording_access`])し、未許可
/// なら `screencapture` を起動せず `Err(RunError::PermissionDenied)` を返す
/// (NFR-002)。許可済みなら一時ファイルパスを生成し [`ScreenCaptureCli`] で
/// キャプチャを実行する。戻り値の `PathBuf` は今回生成した一時ファイルパスで、
/// `CaptureOutcome::Completed` の場合のみ実際に画像が書き出されている
/// (`commands::capture_screen` が `CaptureResult.source_path` の構築に使う)。
///
/// 権限確認・プロセス起動(`CaptureProvider`)の両方をモック可能にするため、
/// 実処理は [`run_with`] に切り出してある。`commands::capture_screen`(T06)は
/// この関数を呼ぶ。
///
/// `origin` は呼び出し元(`"button"`/`"tray"`/`"shortcut"`、T11・NFR-001中間計測)、
/// `start` はその入口で押下を受け取った時刻。プロセス起動完了までの経過を
/// [`format_latency_log`] の形式で標準エラーへ記録する(実際のI/Oは
/// [`emit_latency_log`] が行う)。
pub fn run(origin: &str, start: Instant) -> Result<(CaptureOutcome, PathBuf), RunError> {
    run_with(&ScreenCaptureCli, preflight_screen_recording_access, origin, start)
}

/// [`run`] の実処理。権限確認・キャプチャ実行の両方を注入可能にすることで、
/// 実際に `screencapture` を起動せず・実OS権限に依存せずテストできる
/// (T05 受け入れ条件: 過剰な抽象化を避けるため新規traitは追加せず、
/// 権限確認は関数注入、プロセス起動は既存の `CaptureProvider` trait を使う)。
fn run_with<P: CaptureProvider>(
    provider: &P,
    check_permission: impl FnOnce() -> ScreenRecordingPermission,
    origin: &str,
    start: Instant,
) -> Result<(CaptureOutcome, PathBuf), RunError> {
    if check_permission() != ScreenRecordingPermission::Granted {
        return Err(RunError::PermissionDenied);
    }
    let dest = generate_capture_path().map_err(RunError::Io)?;
    let outcome = provider
        .capture(&dest, &mut || emit_latency_log(origin, start.elapsed()))
        .map_err(RunError::Io)?;
    Ok((outcome, dest))
}

/// `Duration` をミリ秒の浮動小数点へ変換する純粋関数(T11)。
pub(crate) fn duration_to_ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// NFR-001中間計測ログの1行分を整形する純粋関数(cargo testで検証、T11)。
///
/// 機械可読な形式(`[tadcap:latency] origin=<origin> spawn_ms=<経過ms>`)にし、
/// 人間の目視・集計スクリプト(`scripts/latency-summary.mjs`)の両方から
/// 扱えるようにする。`origin` は `"button"`/`"tray"`/`"shortcut"` の3種。
pub(crate) fn format_latency_log(origin: &str, spawn_ms: f64) -> String {
    format!("[tadcap:latency] origin={origin} spawn_ms={spawn_ms:.1}")
}

/// 起点からの経過時間をNFR-001中間計測ログとして標準エラーへ出力する(T11)。
///
/// 実際のI/O(`eprintln!`)を含むためcargo testの対象外とし、整形のみ
/// [`format_latency_log`] に切り出してテストする(既存コードのpure/impure分離
/// パターンを踏襲。例: `tray.rs` の `tray_menu_action_from_id` と
/// `on_menu_event` ハンドラの関係)。
fn emit_latency_log(origin: &str, elapsed: Duration) {
    eprintln!("{}", format_latency_log(origin, duration_to_ms(elapsed)));
}

/// 画面収録権限を確認し、未許可なら [`request_screen_recording_access`] を1回呼ぶ
/// (NFR-002、PJM決定 2026-09-23)。
///
/// [`request_screen_recording_access`](`CGRequestScreenCaptureAccess`の安全な
/// ラッパー)はOSの許可ダイアログを表示するとともに、システム設定
/// 「プライバシーとセキュリティ→画面収録」の一覧にアプリを登録する副作用を持つ。
/// これを呼ばないと一覧に現れず、ユーザーが許可を与える手段自体が無くなる恐れが
/// あるため、[`preflight_screen_recording_access`] が `NotGranted` を返した時点で
/// 必ず1回呼ぶ。既に許可済みの場合はダイアログを表示しない(`request` を呼ばない)。
///
/// `commands::check_screen_recording_permission`(T08)から
/// `tauri::async_runtime::spawn_blocking` 経由で呼ばれる想定(FFI呼び出しを
/// メインスレッド・非同期ワーカーから退避させるため、`commands::capture_screen`
/// と同じ方針)。
pub fn ensure_screen_recording_access() -> ScreenRecordingPermission {
    ensure_screen_recording_access_with(
        preflight_screen_recording_access,
        request_screen_recording_access,
    )
}

/// [`ensure_screen_recording_access`] の実処理。権限確認・要求の両方を注入可能に
/// することで、実OS権限・実ダイアログに依存せずテストできる([`run_with`] と
/// 同じ設計方針)。
fn ensure_screen_recording_access_with(
    preflight: impl FnOnce() -> ScreenRecordingPermission,
    request: impl FnOnce() -> ScreenRecordingPermission,
) -> ScreenRecordingPermission {
    match preflight() {
        ScreenRecordingPermission::Granted => ScreenRecordingPermission::Granted,
        ScreenRecordingPermission::NotGranted => request(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::time::Duration;

    /// NFR-001計測ログ整形の純粋関数テスト(T11)。
    #[test]
    fn duration_to_ms_はミリ秒の浮動小数点に変換する() {
        assert_eq!(duration_to_ms(Duration::from_millis(1234)), 1234.0);
    }

    #[test]
    fn duration_to_ms_はマイクロ秒精度を保持する() {
        let d = Duration::from_micros(1_500); // 1.5ms
        assert!((duration_to_ms(d) - 1.5).abs() < 1e-9);
    }

    #[test]
    fn format_latency_log_は起点と経過msを機械可読な1行に整形する() {
        assert_eq!(
            format_latency_log("shortcut", 12.3),
            "[tadcap:latency] origin=shortcut spawn_ms=12.3"
        );
    }

    #[test]
    fn format_latency_log_は起点ごとに出し分ける() {
        assert_eq!(
            format_latency_log("tray", 0.0),
            "[tadcap:latency] origin=tray spawn_ms=0.0"
        );
        assert_eq!(
            format_latency_log("button", 5.0),
            "[tadcap:latency] origin=button spawn_ms=5.0"
        );
    }

    #[test]
    fn format_latency_log_は小数第1位に丸める() {
        assert_eq!(
            format_latency_log("shortcut", 12.34),
            "[tadcap:latency] origin=shortcut spawn_ms=12.3"
        );
        assert_eq!(
            format_latency_log("shortcut", 12.36),
            "[tadcap:latency] origin=shortcut spawn_ms=12.4"
        );
    }

    /// `.capture()` が呼ばれたかを記録し、任意の `CaptureOutcome` を返す
    /// モック実装(実プロセスは一切起動しない)。`on_spawn` は実装契約どおり
    /// 1回呼ぶ(T11、`CaptureProvider::capture` のdocコメント参照)。
    struct MockProvider {
        called: Cell<bool>,
        outcome: CaptureOutcome,
    }

    impl CaptureProvider for MockProvider {
        fn capture(
            &self,
            _dest: &Path,
            on_spawn: &mut dyn FnMut(),
        ) -> std::io::Result<CaptureOutcome> {
            self.called.set(true);
            on_spawn();
            Ok(self.outcome)
        }
    }

    /// テスト用の固定 origin(NFR-001中間計測の呼び出し元識別子。実際の値は
    /// `"button"`/`"tray"`/`"shortcut"` だが、これらのテストは計測ロジック自体
    /// ではなく権限確認・多重起動防止のロジックを検証するため任意の値でよい)。
    const TEST_ORIGIN: &str = "test";

    #[test]
    fn run_with_は権限未許可ならscreencaptureを起動しない() {
        let provider = MockProvider {
            called: Cell::new(false),
            outcome: CaptureOutcome::Completed,
        };

        let result = run_with(
            &provider,
            || ScreenRecordingPermission::NotGranted,
            TEST_ORIGIN,
            Instant::now(),
        );

        assert!(matches!(result, Err(RunError::PermissionDenied)));
        assert!(
            !provider.called.get(),
            "権限未許可なのにプロセスが起動された"
        );
    }

    #[test]
    fn run_with_はファイル未生成時にcancelledをエラー扱いしない() {
        let provider = MockProvider {
            called: Cell::new(false),
            outcome: CaptureOutcome::Cancelled,
        };

        let result = run_with(
            &provider,
            || ScreenRecordingPermission::Granted,
            TEST_ORIGIN,
            Instant::now(),
        );

        assert!(
            provider.called.get(),
            "権限許可時はプロセスが起動されるべき"
        );
        let (outcome, _dest) = result.expect("Cancelledはエラー扱いされないはず");
        assert_eq!(outcome, CaptureOutcome::Cancelled);
    }

    #[test]
    fn run_with_は権限許可かつファイル生成時はcompletedを返す() {
        let provider = MockProvider {
            called: Cell::new(false),
            outcome: CaptureOutcome::Completed,
        };

        let result = run_with(
            &provider,
            || ScreenRecordingPermission::Granted,
            TEST_ORIGIN,
            Instant::now(),
        );

        let (outcome, _dest) = result.expect("成功するはず");
        assert_eq!(outcome, CaptureOutcome::Completed);
    }

    #[test]
    fn run_with_は生成した一時ファイルパスを結果とともに返す() {
        let provider = MockProvider {
            called: Cell::new(false),
            outcome: CaptureOutcome::Completed,
        };

        let (_, dest) = run_with(
            &provider,
            || ScreenRecordingPermission::Granted,
            TEST_ORIGIN,
            Instant::now(),
        )
        .expect("成功するはず");

        assert_eq!(dest.parent(), Some(super::tempfile::capture_dir().as_path()));
    }

    /// [`ensure_screen_recording_access_with`]([`ensure_screen_recording_access`]の
    /// 実処理、T08)のテスト(NFR-002、PJM決定 2026-09-23)。
    #[test]
    fn ensure_screen_recording_access_with_は許可済みならrequestを呼ばない() {
        let request_called = Cell::new(false);

        let result = ensure_screen_recording_access_with(
            || ScreenRecordingPermission::Granted,
            || {
                request_called.set(true);
                ScreenRecordingPermission::Granted
            },
        );

        assert_eq!(result, ScreenRecordingPermission::Granted);
        assert!(
            !request_called.get(),
            "許可済みならOSダイアログ(request)を呼ぶべきではない"
        );
    }

    #[test]
    fn ensure_screen_recording_access_with_は未許可ならrequestを1回呼ぶ() {
        let request_called = Cell::new(false);

        let result = ensure_screen_recording_access_with(
            || ScreenRecordingPermission::NotGranted,
            || {
                request_called.set(true);
                ScreenRecordingPermission::NotGranted
            },
        );

        assert_eq!(result, ScreenRecordingPermission::NotGranted);
        assert!(
            request_called.get(),
            "未許可を検知した時点でrequestを呼び、システム設定の一覧にアプリを登録すべき"
        );
    }

    #[test]
    fn ensure_screen_recording_access_with_はrequestの戻り値をそのまま返す() {
        let result = ensure_screen_recording_access_with(
            || ScreenRecordingPermission::NotGranted,
            || ScreenRecordingPermission::Granted,
        );

        assert_eq!(
            result,
            ScreenRecordingPermission::Granted,
            "requestが返した状態(ダイアログ表示直後にユーザーが即座に許可した場合等)を\
             そのまま呼び出し元へ伝えるべき"
        );
    }
}
