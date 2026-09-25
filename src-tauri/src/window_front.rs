//! エディタ(メイン)ウィンドウを前面に出す処理(実機不具合①・B2)。
//!
//! 手順・再試行ポリシー・診断ログの整形は純粋ロジックとして切り出し `cargo test` で
//! 検証する。AppKit を実際に呼ぶ部分は OS ネイティブ導線のため手動確認(実機)。
//!
//! # B2: なぜ B1(activate → orderFrontRegardless → set_focus を1回)で直らなかったか
//!
//! 以下は公式ドキュメント・依存ソースから導いた【推定】。実機ログ(`[tadcap:front]`)で
//! 確定させる。
//!
//! 1. **activate は拒否される**: macOS 14 以降のアプリの activate は協調的で、
//!    `NSApplication::activate` のドキュメントに「The framework also does not guarantee
//!    that the app will be activated at all」とある。tao の `set_focus` が呼ぶ
//!    `activateIgnoringOtherApps:` も同じ扱い(objc2-app-kit 0.3.2 のdocで deprecated)。
//!    トレイメニュー操作はこのアプリへの直接操作なので許可されるが、ショートカット起点は
//!    `screencapture -i` 終了後(前面は別アプリ)の要求なので許可されない。
//! 2. **set_focus が orderFrontRegardless を打ち消しうる**: B1 は orderFrontRegardless の
//!    *後に* `set_focus` を呼んでいた。tao 0.35.3 の `set_focus` は
//!    `makeKeyAndOrderFront:`(`platform_impl/macos/util/async.rs`)で、AppKit のドキュメントは
//!    orderFrontRegardless を「アプリがアクティブでなくても前面へ出す」と説明しており、
//!    裏返せば通常の orderFront 系は非アクティブアプリでは他アプリの前に出ることを保証しない。
//!    非アクティブのまま最後に `makeKeyAndOrderFront:` を呼ぶと並び順が戻りうる。
//! 3. **screencapture 終了直後の再アクティブ化と競合する**: `screencapture -i` 終了後に
//!    OS が直前のアプリを前面へ戻す処理と、こちらの前面化要求(終了検知から数ms)の順序は
//!    保証されない。アクティブ化されたアプリは key/main ウィンドウを前面に出すため、
//!    同じ通常レベルにある本アプリのウィンドウはその背後に回りうる。
//!
//! 対策: (a) `orderFrontRegardless` を手順の最後に置く、(b) 前面化の間だけウィンドウの
//! レベルを `NSFloatingWindowLevel` に上げ(通常レベルの他アプリのウィンドウより常に前)、
//! (c) 短い間隔で再試行したのち通常レベルへ戻す。tauri の `set_always_on_top` は
//! tao 内部で `DispatchQueue::main().exec_async`(非同期)になり手順の順序が崩れるため、
//! `NSWindow::setLevel` をメインスレッドで同期的に呼ぶ。

use std::sync::mpsc;
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewWindow};

/// メインウィンドウのラベル(`tauri.conf.json` の既定ウィンドウ設定)。
const MAIN_WINDOW_LABEL: &str = "main";

/// メインスレッドでの前面化処理の完了を待つ上限(診断用。超過時はログを出して打ち切る)。
const MAIN_THREAD_WAIT: Duration = Duration::from_secs(2);

/// 前面化のきっかけ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrontTrigger {
    /// トレイメニュー「エディタを開く」: ユーザーがこのアプリを直接操作した直後なので
    /// activate が許可される(実機で前面化できていることを確認済み)。
    UserMenu,
    /// トレイ「キャプチャ」・グローバルショートカットでの撮影完了後: 前面は別アプリで、
    /// activate は許可されない前提で前面化する。
    AfterCapture,
}

/// 前面化の1手順。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BringToFrontStep {
    /// 最小化を解除する(taoの`set_focus`は最小化中だと何もしないため)。
    Unminimize,
    /// ウィンドウを表示する(閉じる操作で`hide()`されている場合がある)。
    Show,
    /// アプリ自体のactivateを要求する(`NSApplication::activate`。拒否されうる)。
    ActivateApp,
    /// キーウィンドウにする(tauri `set_focus` = `makeKeyAndOrderFront:` + activate要求)。
    SetFocus,
    /// ウィンドウレベルを `NSFloatingWindowLevel` に上げる。
    RaiseLevel,
    /// ウィンドウレベルを `NSNormalWindowLevel` に戻す。
    RestoreLevel,
    /// アプリが非アクティブでもウィンドウをレベル内の最前面に並べる
    /// (`NSWindow::orderFrontRegardless`)。
    OrderFrontRegardless,
    /// 何も操作せず状態だけをログに出す(診断用)。
    Probe,
}

/// 前面化の1回分(待ち時間 + 手順列)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FrontAttempt {
    /// 直前の試行(初回は撮影完了)からの待ち時間。
    pub(crate) delay_ms: u64,
    pub(crate) steps: &'static [BringToFrontStep],
}

/// 1回の試行の結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AttemptOutcome {
    /// アプリがアクティブかつウィンドウがキー(前面化が確実に成功した)。
    Reached,
    /// まだ確証が無い(activateが拒否されている等)。
    NotYet,
    /// ウィンドウが存在しない。
    NoWindow,
}

use BringToFrontStep as S;

/// トレイ「エディタを開く」の手順(activateが許可される前提)。
const USER_MENU_STEPS: &[BringToFrontStep] = &[
    S::Unminimize,
    S::Show,
    S::ActivateApp,
    S::SetFocus,
    S::OrderFrontRegardless,
];

/// 撮影完了後の手順(activateが拒否される前提でレベルを上げる)。
const RAISED_STEPS: &[BringToFrontStep] = &[
    S::Unminimize,
    S::Show,
    S::ActivateApp,
    S::SetFocus,
    S::RaiseLevel,
    S::OrderFrontRegardless,
];

/// レベルを通常へ戻す手順(戻した後も前面に残るよう並べ直す)。
const SETTLE_STEPS: &[BringToFrontStep] = &[S::RestoreLevel, S::OrderFrontRegardless];

/// 診断用の最終確認(操作しない)。
const PROBE_STEPS: &[BringToFrontStep] = &[S::Probe];

const USER_MENU_PLAN: &[FrontAttempt] = &[FrontAttempt {
    delay_ms: 0,
    steps: USER_MENU_STEPS,
}];

/// 撮影完了後の計画。即時・150ms後・さらに350ms後にレベルを上げて前面化し、
/// さらに500ms後に通常レベルへ戻す(フローティングは合計約1秒だけ)。最後に状態を記録する。
const AFTER_CAPTURE_PLAN: &[FrontAttempt] = &[
    FrontAttempt {
        delay_ms: 0,
        steps: RAISED_STEPS,
    },
    FrontAttempt {
        delay_ms: 150,
        steps: RAISED_STEPS,
    },
    FrontAttempt {
        delay_ms: 350,
        steps: RAISED_STEPS,
    },
    FrontAttempt {
        delay_ms: 500,
        steps: SETTLE_STEPS,
    },
    FrontAttempt {
        delay_ms: 1000,
        steps: PROBE_STEPS,
    },
];

/// きっかけごとの前面化計画(純粋関数)。
pub(crate) fn front_plan(trigger: FrontTrigger) -> &'static [FrontAttempt] {
    match trigger {
        FrontTrigger::UserMenu => USER_MENU_PLAN,
        FrontTrigger::AfterCapture => AFTER_CAPTURE_PLAN,
    }
}

/// 次に実行する試行のインデックスを決める(純粋関数)。
///
/// - `NoWindow`: 打ち切る
/// - `Reached`: 残りの再試行を飛ばし、レベルを戻す試行へ進む(既に戻す試行以降なら通常どおり次へ)
/// - `NotYet`: 次へ
pub(crate) fn next_attempt_index(
    plan: &[FrontAttempt],
    current: usize,
    outcome: AttemptOutcome,
) -> Option<usize> {
    let next = current + 1;
    let following = (next < plan.len()).then_some(next);
    match outcome {
        AttemptOutcome::NoWindow => None,
        AttemptOutcome::NotYet => following,
        AttemptOutcome::Reached => {
            match plan.iter().position(|a| a.steps.contains(&S::RestoreLevel)) {
                Some(restore) if restore > current => Some(restore),
                _ => following,
            }
        }
    }
}

/// 前面化判断に使うウィンドウ・アプリの状態(診断ログ用)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FrontSnapshot {
    pub(crate) main_thread: bool,
    pub(crate) app_active: bool,
    pub(crate) win_visible: bool,
    pub(crate) win_minimized: bool,
    pub(crate) win_key: bool,
    pub(crate) on_active_space: bool,
    pub(crate) level: isize,
    pub(crate) occlusion_visible: bool,
    /// 現在のSpaceの全アプリの可視ウィンドウ(前→後ろ順)における本ウィンドウの位置。
    /// メニューバー等のシステムのウィンドウも数えるため0にはならないことがある。
    pub(crate) z_index: Option<usize>,
    pub(crate) z_total: usize,
    /// 最前面アプリのバンドルID。
    pub(crate) frontmost: String,
}

/// 診断ログ1行を整形する(純粋関数)。`[tadcap:latency]` と同じく `key=value` の空白区切り。
pub(crate) fn format_front_log(
    origin: &str,
    attempt: &str,
    step: &str,
    result: &str,
    snapshot: Option<&FrontSnapshot>,
) -> String {
    let mut line = format!(
        "[tadcap:front] origin={} attempt={} step={} result={}",
        sanitize(origin),
        sanitize(attempt),
        sanitize(step),
        sanitize(result)
    );
    if let Some(s) = snapshot {
        let z_index = s
            .z_index
            .map_or_else(|| "none".to_string(), |i| i.to_string());
        line.push_str(&format!(
            " main_thread={} app_active={} win_visible={} win_minimized={} win_key={} \
             on_active_space={} level={} occlusion_visible={} z_index={}/{} frontmost={}",
            s.main_thread,
            s.app_active,
            s.win_visible,
            s.win_minimized,
            s.win_key,
            s.on_active_space,
            s.level,
            s.occlusion_visible,
            z_index,
            s.z_total,
            sanitize(&s.frontmost)
        ));
    }
    line
}

/// `key=value` の区切りを壊さないよう値の空白を `_` に置き換える。
fn sanitize(value: &str) -> String {
    value.replace(char::is_whitespace, "_")
}

fn log_front(
    origin: &str,
    attempt: &str,
    step: &str,
    result: &str,
    snapshot: Option<&FrontSnapshot>,
) {
    eprintln!(
        "{}",
        format_front_log(origin, attempt, step, result, snapshot)
    );
}

/// 経路確認用のログ(ウィンドウ状態を伴わない行)。`tray.rs` からも使う。
pub(crate) fn log_route(origin: &str, step: &str, result: &str) {
    log_front(origin, "-", step, result, None);
}

/// メインウィンドウを前面に出す。
///
/// - `UserMenu`: メインスレッド上のメニューイベントから呼ばれるため、その場で実行する
/// - `AfterCapture`: 非同期タスクから呼ばれる。待ち時間を挟む再試行のため専用スレッドで
///   計画を進め、各試行のウィンドウ操作だけを `AppHandle::run_on_main_thread` で
///   メインスレッドへ戻す(AppKit はメインスレッド必須)
pub(crate) fn bring_main_window_to_front(
    app: &AppHandle,
    origin: &'static str,
    trigger: FrontTrigger,
) {
    let plan = front_plan(trigger);
    match trigger {
        FrontTrigger::UserMenu => {
            let total = plan.len();
            for (i, attempt) in plan.iter().enumerate() {
                run_attempt(app, origin, i, total, attempt.steps);
            }
        }
        FrontTrigger::AfterCapture => {
            let app = app.clone();
            let spawned = std::thread::Builder::new()
                .name("tadcap-front".into())
                .spawn(move || run_plan_off_main_thread(&app, origin, plan));
            if let Err(err) = spawned {
                log_route(origin, "spawn_thread", &format!("err:{err}"));
            }
        }
    }
}

fn run_plan_off_main_thread(app: &AppHandle, origin: &'static str, plan: &'static [FrontAttempt]) {
    let total = plan.len();
    let mut next = if plan.is_empty() { None } else { Some(0) };
    while let Some(i) = next {
        let attempt = plan[i];
        if attempt.delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(attempt.delay_ms));
        }
        let (tx, rx) = mpsc::channel();
        let app_for_main = app.clone();
        let label = attempt_label(i, total);
        let scheduled = app.run_on_main_thread(move || {
            let outcome = run_attempt(&app_for_main, origin, i, total, attempt.steps);
            let _ = tx.send(outcome);
        });
        if let Err(err) = scheduled {
            log_front(
                origin,
                &label,
                "run_on_main_thread",
                &format!("err:{err}"),
                None,
            );
            return;
        }
        let outcome = match rx.recv_timeout(MAIN_THREAD_WAIT) {
            Ok(outcome) => outcome,
            Err(err) => {
                // クロージャがメインスレッドで実行されなかった(または2秒以上かかった)。
                log_front(
                    origin,
                    &label,
                    "main_thread_wait",
                    &format!("err:{err}"),
                    None,
                );
                return;
            }
        };
        next = next_attempt_index(plan, i, outcome);
    }
}

fn attempt_label(index: usize, total: usize) -> String {
    format!("{}/{}", index + 1, total)
}

/// 1回分の手順をメインスレッドで実行し、各手順の前後の状態をログに出す。
fn run_attempt(
    app: &AppHandle,
    origin: &str,
    index: usize,
    total: usize,
    steps: &[BringToFrontStep],
) -> AttemptOutcome {
    let label = attempt_label(index, total);
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        log_front(origin, &label, "get_window", "not_found", None);
        return AttemptOutcome::NoWindow;
    };
    log_front(
        origin,
        &label,
        "begin",
        "-",
        native::snapshot(&window).as_ref(),
    );
    for &step in steps {
        let result = match execute_step(&window, step) {
            Ok(()) => "ok".to_string(),
            Err(err) => format!("err:{err}"),
        };
        log_front(
            origin,
            &label,
            &format!("{step:?}"),
            &result,
            native::snapshot(&window).as_ref(),
        );
    }
    match native::snapshot(&window) {
        Some(s) if s.app_active && s.win_key => AttemptOutcome::Reached,
        _ => AttemptOutcome::NotYet,
    }
}

/// エディタのアクティブ化要求のきっかけ(v0.2.2、実機不具合「テキスト入力で全角文字が入らない」)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActivationOrigin {
    /// エディタウィンドウがキーになった(`WindowEvent::Focused(true)`)。
    WindowFocused,
    /// テキスト入力欄がフォーカスを得た(フロントの `activate_app` コマンド)。
    TextInput,
}

impl ActivationOrigin {
    fn label(self) -> &'static str {
        match self {
            ActivationOrigin::WindowFocused => "window_focused",
            ActivationOrigin::TextInput => "text_input",
        }
    }
}

/// アプリのアクティブ化を要求すべきか(純粋関数)。
///
/// macOSの入力メソッド(日本語IME)はアクティブなアプリの入力にだけ働く。Dock非表示
/// (Accessory)の本アプリは撮影後に非アクティブのまま前面化されうる(B2)ため、エディタを
/// 使い始めた時点で非アクティブなら要求する。既にアクティブなら何もしない(他アプリの
/// 操作を邪魔しない・二重要求しない)。ウィンドウが見えていない(閉じて`hide()`済み・
/// 最小化中)ときは、ユーザーがエディタを使っていないので要求しない。
pub(crate) fn should_request_activation(
    app_active: bool,
    win_visible: bool,
    win_minimized: bool,
) -> bool {
    !app_active && win_visible && !win_minimized
}

/// 非アクティブならアプリのアクティブ化を要求する(どのスレッドからでも呼べる。
/// AppKit呼び出しは `run_on_main_thread` でメインスレッドへ戻す)。
///
/// 要求したときだけ `[tadcap:front]` ログを出す(フォーカスのたびにログが出ないように)。
pub(crate) fn ensure_app_active(app: &AppHandle, origin: ActivationOrigin) {
    let handle = app.clone();
    let scheduled = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) else {
            return;
        };
        let Some(before) = native::snapshot(&window) else {
            return;
        };
        if !should_request_activation(before.app_active, before.win_visible, before.win_minimized) {
            return;
        }
        let result = match native::activate_app() {
            Ok(()) => "ok".to_string(),
            Err(err) => format!("err:{err}"),
        };
        log_front(
            origin.label(),
            "-",
            "ActivateForInput",
            &result,
            native::snapshot(&window).as_ref(),
        );
    });
    if let Err(err) = scheduled {
        log_route(origin.label(), "run_on_main_thread", &format!("err:{err}"));
    }
}

fn execute_step(window: &WebviewWindow, step: BringToFrontStep) -> Result<(), String> {
    match step {
        S::Unminimize => window.unminimize().map_err(|e| e.to_string()),
        S::Show => window.show().map_err(|e| e.to_string()),
        S::SetFocus => window.set_focus().map_err(|e| e.to_string()),
        S::ActivateApp => native::activate_app(),
        S::RaiseLevel => native::set_floating(window, true),
        S::RestoreLevel => native::set_floating(window, false),
        S::OrderFrontRegardless => native::order_front_regardless(window),
        S::Probe => Ok(()),
    }
}

/// AppKit 呼び出し(macOSのみ)。
#[cfg(target_os = "macos")]
mod native {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSFloatingWindowLevel, NSNormalWindowLevel, NSWindow,
        NSWindowNumberListOptions, NSWindowOcclusionState, NSWorkspace,
    };
    use tauri::WebviewWindow;

    use super::FrontSnapshot;

    fn main_thread() -> Result<MainThreadMarker, String> {
        MainThreadMarker::new().ok_or_else(|| "not_main_thread".to_string())
    }

    /// `ns_window()` の生ポインタを借用して処理する。
    fn with_ns_window<R>(
        window: &WebviewWindow,
        f: impl FnOnce(&NSWindow, MainThreadMarker) -> R,
    ) -> Result<R, String> {
        let mtm = main_thread()?;
        let ptr = window.ns_window().map_err(|e| format!("ns_window:{e}"))?;
        if ptr.is_null() {
            return Err("ns_window_null".to_string());
        }
        // SAFETY: `ns_window()` はこのウィンドウが保持する有効な `NSWindow` への
        // ポインタを返す(tauri `WebviewWindow::ns_window`)。メインスレッド上で
        // (MainThreadMarkerで確認済み)、借用はこのスコープ内に限る。
        let ns_window: &NSWindow = unsafe { &*ptr.cast() };
        Ok(f(ns_window, mtm))
    }

    /// `minimumSystemVersion` が 14.0 のため、14で追加された `activate` を呼べる。
    /// OSが拒否しても例外にはならない(結果は `app_active` で確認する)。
    pub(super) fn activate_app() -> Result<(), String> {
        let mtm = main_thread()?;
        NSApplication::sharedApplication(mtm).activate();
        Ok(())
    }

    pub(super) fn set_floating(window: &WebviewWindow, floating: bool) -> Result<(), String> {
        let level = if floating {
            NSFloatingWindowLevel
        } else {
            NSNormalWindowLevel
        };
        with_ns_window(window, |w, _| w.setLevel(level))
    }

    pub(super) fn order_front_regardless(window: &WebviewWindow) -> Result<(), String> {
        with_ns_window(window, |w, _| w.orderFrontRegardless())
    }

    pub(super) fn snapshot(window: &WebviewWindow) -> Option<FrontSnapshot> {
        with_ns_window(window, |w, mtm| {
            let app = NSApplication::sharedApplication(mtm);
            let own_number = w.windowNumber();
            let numbers =
                NSWindow::windowNumbersWithOptions(NSWindowNumberListOptions::AllApplications, mtm);
            let (z_index, z_total) = match numbers {
                Some(list) => {
                    let values: Vec<isize> = list.iter().map(|n| n.integerValue()).collect();
                    (values.iter().position(|n| *n == own_number), values.len())
                }
                None => (None, 0),
            };
            let frontmost = NSWorkspace::sharedWorkspace()
                .frontmostApplication()
                .and_then(|a| a.bundleIdentifier())
                .map(|id| id.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            FrontSnapshot {
                main_thread: true,
                app_active: app.isActive(),
                win_visible: w.isVisible(),
                win_minimized: w.isMiniaturized(),
                win_key: w.isKeyWindow(),
                on_active_space: w.isOnActiveSpace(),
                level: w.level(),
                occlusion_visible: w.occlusionState().contains(NSWindowOcclusionState::Visible),
                z_index,
                z_total,
                frontmost,
            }
        })
        .ok()
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use tauri::WebviewWindow;

    use super::FrontSnapshot;

    pub(super) fn activate_app() -> Result<(), String> {
        Ok(())
    }
    pub(super) fn set_floating(_window: &WebviewWindow, _floating: bool) -> Result<(), String> {
        Ok(())
    }
    pub(super) fn order_front_regardless(_window: &WebviewWindow) -> Result<(), String> {
        Ok(())
    }
    pub(super) fn snapshot(_window: &WebviewWindow) -> Option<FrontSnapshot> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position(steps: &[BringToFrontStep], step: BringToFrontStep) -> usize {
        steps
            .iter()
            .position(|s| *s == step)
            .unwrap_or_else(|| panic!("{step:?} が手順に含まれていない: {steps:?}"))
    }

    fn all_steps(trigger: FrontTrigger) -> Vec<&'static [BringToFrontStep]> {
        front_plan(trigger).iter().map(|a| a.steps).collect()
    }

    #[test]
    fn 全計画で最小化解除と表示をフォーカスより先に行う() {
        // tao(macOS)の`set_focus`は「最小化されておらず可視」のときだけ動作する
        // (tao-0.35.3 `platform_impl/macos/window.rs::set_focus`)。
        for trigger in [FrontTrigger::UserMenu, FrontTrigger::AfterCapture] {
            for steps in all_steps(trigger) {
                if !steps.contains(&S::SetFocus) {
                    continue;
                }
                let focus = position(steps, S::SetFocus);
                assert!(position(steps, S::Unminimize) < focus);
                assert!(position(steps, S::Show) < focus);
            }
        }
    }

    #[test]
    fn 全計画でorder_front_regardlessをmake_key_and_order_front系の後に置く() {
        // B2: 非アクティブのまま最後に`makeKeyAndOrderFront:`(Show/SetFocus)を呼ぶと
        // orderFrontRegardlessの並び順が打ち消されうるため、最後の並べ替えはRegardless。
        for trigger in [FrontTrigger::UserMenu, FrontTrigger::AfterCapture] {
            for steps in all_steps(trigger) {
                let Some(regardless) = steps.iter().rposition(|s| *s == S::OrderFrontRegardless)
                else {
                    continue;
                };
                for (i, s) in steps.iter().enumerate() {
                    if matches!(s, S::Show | S::SetFocus | S::RaiseLevel | S::RestoreLevel) {
                        assert!(i < regardless, "{s:?} が OrderFrontRegardless より後にある");
                    }
                }
            }
        }
    }

    #[test]
    fn トレイのエディタを開くは待たずに1回だけactivateを含めて前面化する() {
        let plan = front_plan(FrontTrigger::UserMenu);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].delay_ms, 0);
        position(plan[0].steps, S::ActivateApp);
        position(plan[0].steps, S::OrderFrontRegardless);
        assert!(!plan[0].steps.contains(&S::RaiseLevel), "レベル変更は不要");
    }

    #[test]
    fn 撮影後は即時に始め複数回レベルを上げて前面化する() {
        let plan = front_plan(FrontTrigger::AfterCapture);
        assert_eq!(plan[0].delay_ms, 0, "初回は即時");
        let raised = plan
            .iter()
            .filter(|a| a.steps.contains(&S::RaiseLevel))
            .count();
        assert!(
            raised >= 2,
            "再試行が必要(screencapture終了直後の再アクティブ化と競合するため)"
        );
        for a in plan.iter().filter(|a| a.steps.contains(&S::RaiseLevel)) {
            assert!(position(a.steps, S::RaiseLevel) < position(a.steps, S::OrderFrontRegardless));
        }
    }

    #[test]
    fn 撮影後の計画は最後に上げたレベルを必ず通常へ戻す() {
        let plan = front_plan(FrontTrigger::AfterCapture);
        let last_raise = plan
            .iter()
            .rposition(|a| a.steps.contains(&S::RaiseLevel))
            .expect("RaiseLevelがある");
        let restore = plan
            .iter()
            .rposition(|a| a.steps.contains(&S::RestoreLevel))
            .expect("RestoreLevelがある");
        assert!(last_raise < restore);
        // 戻した後にもう一度前面へ並べ直す
        let steps = plan[restore].steps;
        assert!(position(steps, S::RestoreLevel) < position(steps, S::OrderFrontRegardless));
    }

    #[test]
    fn 撮影後のフローティング表示は合計2秒未満に収める() {
        let plan = front_plan(FrontTrigger::AfterCapture);
        let restore = plan
            .iter()
            .position(|a| a.steps.contains(&S::RestoreLevel))
            .unwrap();
        let floating_ms: u64 = plan[1..=restore].iter().map(|a| a.delay_ms).sum();
        assert!(floating_ms < 2000, "floating_ms={floating_ms}");
    }

    #[test]
    fn next_attempt_indexは未達なら次の試行へ進む() {
        let plan = front_plan(FrontTrigger::AfterCapture);
        assert_eq!(next_attempt_index(plan, 0, AttemptOutcome::NotYet), Some(1));
    }

    #[test]
    fn next_attempt_indexは最後の試行の後は終了する() {
        let plan = front_plan(FrontTrigger::AfterCapture);
        let last = plan.len() - 1;
        assert_eq!(next_attempt_index(plan, last, AttemptOutcome::NotYet), None);
        assert_eq!(
            next_attempt_index(plan, last, AttemptOutcome::Reached),
            None
        );
    }

    #[test]
    fn next_attempt_indexは前面化に成功したら残りの再試行を飛ばしてレベルを戻す() {
        let plan = front_plan(FrontTrigger::AfterCapture);
        let restore = plan
            .iter()
            .position(|a| a.steps.contains(&S::RestoreLevel))
            .unwrap();
        assert_eq!(
            next_attempt_index(plan, 0, AttemptOutcome::Reached),
            Some(restore)
        );
        // レベルを戻した後の成功は通常どおり次(診断)へ
        assert_eq!(
            next_attempt_index(plan, restore, AttemptOutcome::Reached),
            Some(restore + 1)
        );
    }

    #[test]
    fn next_attempt_indexはウィンドウが無ければ打ち切る() {
        let plan = front_plan(FrontTrigger::AfterCapture);
        assert_eq!(next_attempt_index(plan, 0, AttemptOutcome::NoWindow), None);
    }

    #[test]
    fn next_attempt_indexはレベル変更の無い計画で成功したら次へ進む() {
        let plan = front_plan(FrontTrigger::UserMenu);
        assert_eq!(next_attempt_index(plan, 0, AttemptOutcome::Reached), None);
    }

    #[test]
    fn format_front_logは状態なしの経路ログを整形する() {
        assert_eq!(
            format_front_log("shortcut", "-", "follow_up", "ShowEditor", None),
            "[tadcap:front] origin=shortcut attempt=- step=follow_up result=ShowEditor"
        );
    }

    #[test]
    fn format_front_logは状態つきのログを整形する() {
        let s = FrontSnapshot {
            main_thread: true,
            app_active: false,
            win_visible: true,
            win_minimized: false,
            win_key: true,
            on_active_space: true,
            level: 3,
            occlusion_visible: false,
            z_index: Some(4),
            z_total: 12,
            frontmost: "com.apple.Terminal".into(),
        };
        assert_eq!(
            format_front_log("shortcut", "1/5", "OrderFrontRegardless", "ok", Some(&s)),
            "[tadcap:front] origin=shortcut attempt=1/5 step=OrderFrontRegardless result=ok \
             main_thread=true app_active=false win_visible=true win_minimized=false win_key=true \
             on_active_space=true level=3 occlusion_visible=false z_index=4/12 \
             frontmost=com.apple.Terminal"
        );
    }

    #[test]
    fn format_front_logはz_index不明と値の空白を扱う() {
        let s = FrontSnapshot {
            main_thread: true,
            app_active: true,
            win_visible: false,
            win_minimized: false,
            win_key: false,
            on_active_space: false,
            level: 0,
            occlusion_visible: false,
            z_index: None,
            z_total: 0,
            frontmost: "My App".into(),
        };
        let line = format_front_log("tray", "2/5", "Show", "err:not found", Some(&s));
        assert!(line.contains(" z_index=none/0 "), "{line}");
        assert!(line.contains(" result=err:not_found "), "{line}");
        assert!(line.ends_with(" frontmost=My_App"), "{line}");
    }

    #[test]
    fn 非アクティブで見えているときだけアクティブ化を要求する() {
        assert!(should_request_activation(false, true, false));
    }

    #[test]
    fn 既にアクティブなら要求しない() {
        assert!(!should_request_activation(true, true, false));
    }

    #[test]
    fn ウィンドウが見えていない_最小化中なら要求しない() {
        assert!(!should_request_activation(false, false, false));
        assert!(!should_request_activation(false, true, true));
        assert!(!should_request_activation(false, false, true));
    }

    #[test]
    fn アクティブ化のきっかけはログで区別できる() {
        assert_eq!(ActivationOrigin::WindowFocused.label(), "window_focused");
        assert_eq!(ActivationOrigin::TextInput.label(), "text_input");
    }
}
