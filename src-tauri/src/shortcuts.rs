//! グローバルショートカット登録(ARCH §11 (c)、T16、FR-004)。
//!
//! OS全体で有効なショートカット(既定 `Cmd+Shift+2`)を登録し、押下時は
//! `tray::run_capture_and_show_editor`(T15で切り出した共通処理)を呼ぶ
//! (トレイ「キャプチャ」・アプリ内ボタンと処理を共有、重複実装回避)。
//!
//! # 公式ドキュメントで確認した設計根拠(PJM指摘対応)
//!
//! - **登録方法**: 公式ドキュメント(<https://v2.tauri.app/plugin/global-shortcut/>)の
//!   Rust利用例どおり、`setup()` 内で `#[cfg(desktop)]` ガードのうえ
//!   `app.handle().plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(...).build())`
//!   でプラグインを登録し、`GlobalShortcutExt::global_shortcut().register(shortcut)` で
//!   実際のキー登録を行う
//! - **JS側パッケージ・capabilities**: フロントエンドから `@tauri-apps/plugin-global-shortcut`
//!   を呼ばない(ショートカット押下時の処理はRust側の `with_handler` で完結する)ため、
//!   npm パッケージは追加しない。`capabilities/default.json` の
//!   `global-shortcut:allow-register` 等は Tauri公式ドキュメント
//!   (<https://v2.tauri.app/reference/config/#capability>)が明記するとおり
//!   「webview からの IPC 層(`invoke()`)へのアクセス制御」であり、
//!   `app.global_shortcut().register()` のようなRustネイティブ呼び出しはIPC層を
//!   経由しないためcapabilitiesの対象外(T15の `tray.rs` 同様の判断、
//!   `project-config.md` §2 T15行を参照)。よって capabilities への追加は不要と判断した
//! - **既定キー**: `Cmd+Shift+3/4/5` はmacOS標準のスクリーンショット機能で予約済み
//!   (Apple公式サポート文書 <https://support.apple.com/en-us/102650> に明記)。
//!   `Cmd+Shift+2` は同文書に記載が無く、macOS標準機能との衝突は確認されなかった
//!   (実機での主要アプリとの衝突確認は手動確認チェックリスト#3へ委譲、PRD FR-004)
//! - **メインスレッド問題**: `screencapture -i` はユーザーの範囲選択が終わるまで
//!   戻らないブロッキング処理であり、`with_handler` のコールバックはTauriのメイン
//!   イベントループ上で同期的に実行される(トレイの `on_menu_event` と同じ実行モデル)。
//!   そのままブロッキング処理を呼ぶとUIとイベントループ全体が固まる(PJM指摘)ため、
//!   本モジュールは直接キャプチャを実行せず `tray::run_capture_and_show_editor` を
//!   呼ぶだけに留める。実際のスレッド退避(`spawn_blocking`)は `commands::run_capture`
//!   (呼び出し先)側で行う(詳細は `commands.rs` のdocコメント参照)
//!
//! # キーの変更(KS-T4、2026-10-08 人間の決定)
//!
//! 設定画面からキャプチャのキーを変えられる。現在のキーは管理状態
//! ([`CaptureShortcutManager`])に持ち、押下のハンドラは固定値ではなくこの現在キーと比較する。
//! 変更は [`change_shortcut`] の手順(旧キーを外す → 新キーを登録 → 設定ファイルへ保存)で行い、
//! 途中で失敗したら元のキーを登録し直す(キャプチャできない状態を作らない)。登録処理は
//! [`ShortcutRegistrar`] 越しに呼ぶので、巻き戻しは偽の登録器で `cargo test` する。
//! 起動時は設定ファイルのキーを登録し、登録できなくても保存値は変えない(設定画面で知らせる)。
//! 設定の読み書きは [`SettingsStore`] 経由で、保存はキーの 1 項目だけを変える(QE-T05。他の項目を消さない)。

use std::str::FromStr;
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::{App, AppHandle, Manager};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcut, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

use crate::error::AppError;
use crate::settings::SettingsStore;
use crate::tray;

/// 既定のグローバルショートカットキーを構築する純粋関数(cargo testで検証可能)。設定画面の
/// 「既定に戻す」もこのキーに戻す(KS-T4。フロントの既定値は `src/ipc/settings.ts`)。
///
/// `Cmd+Shift+3`/`4`/`5` はmacOS標準のスクリーンショット機能で予約されているため
/// 使用不可(PRD FR-004)。`Cmd+Shift+2` は Apple公式のMacキーボードショートカット
/// 一覧(<https://support.apple.com/en-us/102650>)に記載が無く、OS標準機能との
/// 衝突は確認されなかった(実機での主要アプリとの最終確認は手動確認チェックリスト#3)。
pub(crate) fn default_capture_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Digit2)
}

/// ショートカットイベントを処理すべきかを判定する純粋関数(cargo testで検証)。
///
/// `ShortcutState::Pressed` のみ処理し、`Released` は無視する(押しっぱなし・
/// 多重発火時に `screencapture` が多重起動しないようにするための最小実装、
/// T16指示)。3起点(トレイ・ショートカット・ボタン)共有の実行中排他フラグ本体は
/// `commands::run_capture`(呼び出し先)側にある。
pub(crate) fn should_handle_shortcut_event(state: ShortcutState) -> bool {
    matches!(state, ShortcutState::Pressed)
}

/// 使えないキーの理由(フロントの `shortcutFormat.ts::validateShortcut` と同じ規則)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShortcutRejection {
    /// 解釈できない、修飾キーそのもの、または ⌘・⌥・⌃ のどれも含まない(⇧ だけも含む)。
    Invalid,
    /// ⌘ と 1 キーだけ(⌘C・⌘Q など)。
    CmdOnly,
    /// ⌘⇧3/4/5(macOS のスクリーンショット。⌃ を足したクリップボード版も含む)。
    Reserved,
}

impl From<ShortcutRejection> for AppError {
    fn from(rejection: ShortcutRejection) -> Self {
        match rejection {
            ShortcutRejection::Invalid => AppError::ShortcutInvalid,
            ShortcutRejection::CmdOnly => AppError::ShortcutCmdOnly,
            ShortcutRejection::Reserved => AppError::ShortcutReserved,
        }
    }
}

/// キャプチャのキーとして使えるかを検査する純粋関数。
pub(crate) fn validate_shortcut(shortcut: &Shortcut) -> Result<(), ShortcutRejection> {
    let mods = shortcut.mods;
    if matches!(
        shortcut.key,
        Code::MetaLeft
            | Code::MetaRight
            | Code::AltLeft
            | Code::AltRight
            | Code::ControlLeft
            | Code::ControlRight
            | Code::ShiftLeft
            | Code::ShiftRight
            | Code::CapsLock
            | Code::Fn
            | Code::FnLock
    ) {
        return Err(ShortcutRejection::Invalid);
    }
    if !mods.intersects(Modifiers::SUPER | Modifiers::ALT | Modifiers::CONTROL) {
        return Err(ShortcutRejection::Invalid);
    }
    if mods.contains(Modifiers::SUPER | Modifiers::SHIFT)
        && matches!(shortcut.key, Code::Digit3 | Code::Digit4 | Code::Digit5)
    {
        return Err(ShortcutRejection::Reserved);
    }
    if mods == Modifiers::SUPER {
        return Err(ShortcutRejection::CmdOnly);
    }
    Ok(())
}

/// `global-hotkey` の文字列(例 `"shift+super+KeyK"`)を解釈し、使えるキーか検査する。
pub(crate) fn parse_capture_shortcut(accelerator: &str) -> Result<Shortcut, ShortcutRejection> {
    let shortcut = Shortcut::from_str(accelerator).map_err(|_| ShortcutRejection::Invalid)?;
    validate_shortcut(&shortcut)?;
    Ok(shortcut)
}

/// 設定ファイルの値から起動時のキーを決める。無い・解釈できない・使えないキーなら既定キー。
pub(crate) fn initial_capture_shortcut(saved: Option<&str>) -> Shortcut {
    match saved.map(parse_capture_shortcut) {
        Some(Ok(shortcut)) => shortcut,
        Some(Err(rejection)) => {
            eprintln!("保存されていたキャプチャのキーを使えません({rejection:?})。既定キーで起動します");
            default_capture_shortcut()
        }
        None => default_capture_shortcut(),
    }
}

/// キャプチャのショートカットの状態(管理状態の中身)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CaptureShortcutState {
    /// 現在のキー。
    pub current: Shortcut,
    /// OS への登録に成功しているか。
    pub registered: bool,
    /// 設定画面でキーを記録している最中か(この間は押してもキャプチャしない)。
    pub recording: bool,
}

/// 押されたショートカットでキャプチャを始めるかを決める純粋関数。現在のキーの押下(Pressed)で、
/// 記録中でないときだけ始める。
pub(crate) fn should_trigger_capture(
    state: &CaptureShortcutState,
    pressed: &Shortcut,
    event_state: ShortcutState,
) -> bool {
    *pressed == state.current && !state.recording && should_handle_shortcut_event(event_state)
}

/// フロントへ返す現在の状態(`src/ipc/settings.ts::CaptureShortcutInfo`)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureShortcutInfo {
    pub accelerator: String,
    pub is_default: bool,
    pub registered: bool,
}

impl From<&CaptureShortcutState> for CaptureShortcutInfo {
    fn from(state: &CaptureShortcutState) -> Self {
        Self {
            accelerator: state.current.into_string(),
            is_default: state.current == default_capture_shortcut(),
            registered: state.registered,
        }
    }
}

/// OS へのキー登録(本番はグローバルショートカットプラグイン、テストは偽物)。
pub(crate) trait ShortcutRegistrar {
    fn register(&mut self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String>;
}

/// [`change_shortcut`] の失敗。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ChangeFailure {
    pub error: ChangeError,
    /// 巻き戻した後、元のキーが登録されているか(再登録にも失敗したら`false`)。
    pub current_registered: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChangeError {
    /// 新しいキーを登録できなかった。
    Register,
    /// 設定ファイルへ保存できなかった。
    Save,
}

impl From<ChangeError> for AppError {
    fn from(error: ChangeError) -> Self {
        match error {
            ChangeError::Register => AppError::ShortcutRegisterFailed,
            ChangeError::Save => AppError::SettingsSaveFailed,
        }
    }
}

/// キーを `current` から `next` へ変える(決定論的な手順、巻き戻し付き)。
///
/// 1. `next` が現在のキーで登録済みなら何もしない
/// 2. 登録済みなら `current` を外す → `next` を登録。失敗したら `current` を登録し直す
/// 3. `save` で保存。失敗したら `next` を外して `current` を登録し直す
///
/// 成功したら呼び出し側は現在キーを `next`・登録済みにする。
pub(crate) fn change_shortcut<R: ShortcutRegistrar>(
    registrar: &mut R,
    current: Shortcut,
    registered: bool,
    next: Shortcut,
    save: impl FnOnce(&Shortcut) -> Result<(), String>,
) -> Result<(), ChangeFailure> {
    if next == current && registered {
        return Ok(());
    }
    let restore = |registrar: &mut R| -> bool { registered && registrar.register(current).is_ok() };
    if registered {
        if let Err(err) = registrar.unregister(current) {
            eprintln!("キャプチャの元のキーを外せませんでした: {err}");
        }
    }
    if let Err(err) = registrar.register(next) {
        eprintln!("キャプチャの新しいキーを登録できませんでした: {err}");
        let current_registered = restore(registrar);
        return Err(ChangeFailure {
            error: ChangeError::Register,
            current_registered,
        });
    }
    if let Err(err) = save(&next) {
        eprintln!("設定ファイルへ保存できませんでした: {err}");
        if let Err(err) = registrar.unregister(next) {
            eprintln!("保存に失敗した新しいキーを外せませんでした: {err}");
        }
        let current_registered = restore(registrar);
        return Err(ChangeFailure {
            error: ChangeError::Save,
            current_registered,
        });
    }
    Ok(())
}

/// キャプチャのショートカットの管理状態(`app.manage()`)。
pub(crate) struct CaptureShortcutManager {
    state: Mutex<CaptureShortcutState>,
    /// 変更を1つずつ行うためのロック(登録処理の間は`state`をロックしない。押下のハンドラが
    /// メインスレッドで`state`を読むため、登録待ちの間に握ると固まる)。
    change_lock: tauri::async_runtime::Mutex<()>,
}

impl CaptureShortcutManager {
    fn snapshot(&self) -> CaptureShortcutState {
        *self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn update(&self, f: impl FnOnce(&mut CaptureShortcutState)) {
        f(&mut self.state.lock().unwrap_or_else(|e| e.into_inner()));
    }
}

/// 本番の登録器(グローバルショートカットプラグイン)。
struct PluginRegistrar<'a>(&'a AppHandle);

impl PluginRegistrar<'_> {
    /// プラグインの初期化に失敗していると状態が無い(`global_shortcut()`は panic する)ので、
    /// 登録の失敗として扱う(レビュー 2026-10-08)。
    fn plugin(&self) -> Result<&GlobalShortcut<tauri::Wry>, String> {
        self.0
            .try_state::<GlobalShortcut<tauri::Wry>>()
            .map(|state| state.inner())
            .ok_or_else(|| "グローバルショートカットのプラグインが使えません".to_string())
    }
}

impl ShortcutRegistrar for PluginRegistrar<'_> {
    fn register(&mut self, shortcut: Shortcut) -> Result<(), String> {
        self.plugin()?.register(shortcut).map_err(|e| e.to_string())
    }

    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String> {
        self.plugin()?.unregister(shortcut).map_err(|e| e.to_string())
    }
}

/// 現在のキャプチャのショートカットの状態を返す(`get_capture_shortcut`)。
pub(crate) fn capture_shortcut_info(app: &AppHandle) -> CaptureShortcutInfo {
    CaptureShortcutInfo::from(&app.state::<CaptureShortcutManager>().snapshot())
}

/// キーを記録している最中かを設定する(`set_shortcut_recording`)。
pub(crate) fn set_recording(app: &AppHandle, recording: bool) {
    app.state::<CaptureShortcutManager>()
        .update(|state| state.recording = recording);
}

/// キャプチャのキーを保存する(既定キーなら項目を書かない)。[`SettingsStore`] で
/// この 1 項目だけを変えるので、他の項目(縮めてコピーなど)は消えない(QE-T05)。
fn save_capture_shortcut(store: &SettingsStore, shortcut: &Shortcut) -> Result<(), String> {
    let capture_shortcut = (*shortcut != default_capture_shortcut()).then(|| shortcut.into_string());
    store
        .update(|settings| settings.capture_shortcut = capture_shortcut)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// キャプチャのキーを `next` に変えて保存する(`set_capture_shortcut` / `reset_capture_shortcut`)。
/// 失敗したら元のキーに戻し、エラーの固定文字列を返す。
pub(crate) async fn apply_capture_shortcut(
    app: &AppHandle,
    next: Shortcut,
) -> Result<CaptureShortcutInfo, AppError> {
    let manager = app.state::<CaptureShortcutManager>();
    let _guard = manager.change_lock.lock().await;
    let before = manager.snapshot();
    let handle = app.clone();
    // 登録はメインスレッドでの処理を待つブロッキング呼び出しなので、専用スレッドで行う。
    let result = tauri::async_runtime::spawn_blocking(move || {
        let save = |shortcut: &Shortcut| save_capture_shortcut(&handle.state::<SettingsStore>(), shortcut);
        change_shortcut(
            &mut PluginRegistrar(&handle),
            before.current,
            before.registered,
            next,
            save,
        )
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    match result {
        Ok(()) => {
            manager.update(|state| {
                state.current = next;
                state.registered = true;
            });
            Ok(CaptureShortcutInfo::from(&manager.snapshot()))
        }
        Err(failure) => {
            manager.update(|state| state.registered = failure.current_registered);
            Err(failure.error.into())
        }
    }
}

/// グローバルショートカットプラグインを登録し、設定ファイルのキー(無ければ既定キー)を登録する
/// (ARCH §11 (c)、`lib.rs::run()` の `setup()` から `tray::build_tray(app)?` の
/// 直後に呼ばれる)。
///
/// 他アプリが既にキーを使用している等でキー登録(`register`)自体が失敗しても、
/// アプリ全体の起動を失敗させない(PJM指摘)。ログを出力したうえで `Ok(())` を
/// 返して起動を継続する。プラグイン自体の初期化(`plugin()`)が失敗した場合も
/// 同様に起動を継続する(ショートカットが使えないだけで、アプリの他機能は
/// 問題なく使えるべきと判断したため)。
pub(crate) fn register_capture_shortcut(app: &App) -> tauri::Result<()> {
    // KS-T4: 設定ファイルのキーで起動する。管理状態はプラグインの初期化より先に置く
    // (初期化に失敗してもコマンドが状態を読めるように)。
    // 設定は `lib.rs` の `setup()` の最初に `manage()` した `SettingsStore` から読む(QE-T05)。
    let saved = app.state::<SettingsStore>().get();
    let shortcut = initial_capture_shortcut(saved.capture_shortcut.as_deref());
    app.manage(CaptureShortcutManager {
        state: Mutex::new(CaptureShortcutState {
            current: shortcut,
            registered: false,
            recording: false,
        }),
        change_lock: tauri::async_runtime::Mutex::new(()),
    });

    let plugin_result = app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, event_shortcut, event| {
                let state = app.state::<CaptureShortcutManager>().snapshot();
                if !should_trigger_capture(&state, event_shortcut, event.state()) {
                    return;
                }
                // 押下(keydown相当。プラグインがOSから配送するイベント)を受けた
                // 時刻を起点として記録する(NFR-001中間計測、T11、origin="shortcut")。
                tray::run_capture_and_show_editor(app, "shortcut", Instant::now());
            })
            .build(),
    );

    if let Err(err) = plugin_result {
        eprintln!(
            "グローバルショートカットプラグインの初期化に失敗しました。ショートカットは無効のままアプリを継続します: {err}"
        );
        return Ok(());
    }

    // 登録できなくても保存値は変えない(設定画面に「登録できていません」と出す、2026-10-08 人間の決定)。
    match app.global_shortcut().register(shortcut) {
        Ok(()) => app
            .state::<CaptureShortcutManager>()
            .update(|state| state.registered = true),
        Err(err) => eprintln!(
            "グローバルショートカット({})の登録に失敗しました。\
             他アプリが既に同じキーを使用している可能性があります。ショートカットは\
             無効のままアプリを継続します: {err}",
            shortcut.into_string()
        ),
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_capture_shortcut_はcmd_shift_2で構成される() {
        let shortcut = default_capture_shortcut();
        assert!(
            shortcut.matches(Modifiers::SUPER | Modifiers::SHIFT, Code::Digit2),
            "既定ショートカットはCmd+Shift+2であるべき"
        );
    }

    #[test]
    fn default_capture_shortcut_は他のキー組み合わせにマッチしない() {
        let shortcut = default_capture_shortcut();
        assert!(
            !shortcut.matches(Modifiers::SUPER | Modifiers::SHIFT, Code::Digit4),
            "Cmd+Shift+4はOS予約キーであり、既定ショートカットと異なるべき"
        );
        assert!(
            !shortcut.matches(Modifiers::SUPER, Code::Digit2),
            "Shift修飾キー無しではマッチしないべき"
        );
    }

    #[test]
    fn should_handle_shortcut_event_はpressedのみtrueを返す() {
        assert!(
            should_handle_shortcut_event(ShortcutState::Pressed),
            "Pressedは処理対象であるべき"
        );
    }

    #[test]
    fn should_handle_shortcut_event_はreleasedをfalseにする() {
        assert!(
            !should_handle_shortcut_event(ShortcutState::Released),
            "Releasedは無視すべき(押しっぱなし・多重発火時の多重起動防止)"
        );
    }

    fn sc(accelerator: &str) -> Shortcut {
        Shortcut::from_str(accelerator).expect("テスト用のキーを解釈できない")
    }

    #[test]
    fn validate_shortcut_は修飾キーの規則で受け付けと拒否を分ける() {
        assert_eq!(validate_shortcut(&sc("KeyK")), Err(ShortcutRejection::Invalid));
        assert_eq!(validate_shortcut(&sc("shift+KeyK")), Err(ShortcutRejection::Invalid));
        assert_eq!(validate_shortcut(&sc("super+KeyC")), Err(ShortcutRejection::CmdOnly));
        for key in ["Digit3", "Digit4", "Digit5"] {
            assert_eq!(validate_shortcut(&sc(&format!("shift+super+{key}"))), Err(ShortcutRejection::Reserved));
            assert_eq!(
                validate_shortcut(&sc(&format!("shift+control+super+{key}"))),
                Err(ShortcutRejection::Reserved)
            );
        }
        assert_eq!(validate_shortcut(&sc("alt+KeyK")), Ok(()));
        assert_eq!(validate_shortcut(&sc("control+super+KeyP")), Ok(()));
        assert_eq!(validate_shortcut(&default_capture_shortcut()), Ok(()));
    }

    #[test]
    fn validate_shortcut_は修飾キーそのものをキーにできない() {
        assert_eq!(
            validate_shortcut(&Shortcut::new(Some(Modifiers::SUPER), Code::ShiftLeft)),
            Err(ShortcutRejection::Invalid)
        );
    }

    #[test]
    fn parse_capture_shortcut_は文字列を解釈して検査する() {
        assert_eq!(parse_capture_shortcut("shift+super+Digit2"), Ok(default_capture_shortcut()));
        assert_eq!(parse_capture_shortcut("not a key"), Err(ShortcutRejection::Invalid));
        assert_eq!(parse_capture_shortcut("super+KeyQ"), Err(ShortcutRejection::CmdOnly));
    }

    #[test]
    fn 文字列表記はフロントと同じ_shift_control_alt_super_の順で往復する() {
        let shortcut = sc("super+alt+control+shift+KeyK");
        assert_eq!(shortcut.into_string(), "shift+control+alt+super+KeyK");
        assert_eq!(default_capture_shortcut().into_string(), "shift+super+Digit2");
        assert_eq!(sc(&shortcut.into_string()), shortcut);
    }

    #[test]
    fn initial_capture_shortcut_は保存値を使い_無い_使えないときは既定キー() {
        assert_eq!(initial_capture_shortcut(Some("alt+super+KeyK")), sc("alt+super+KeyK"));
        assert_eq!(initial_capture_shortcut(None), default_capture_shortcut());
        assert_eq!(initial_capture_shortcut(Some("garbage")), default_capture_shortcut());
        assert_eq!(initial_capture_shortcut(Some("super+KeyC")), default_capture_shortcut());
    }

    #[test]
    fn should_trigger_capture_は現在のキーの押下で_記録中でなければtrue() {
        let state = CaptureShortcutState {
            current: sc("alt+super+KeyK"),
            registered: true,
            recording: false,
        };
        assert!(should_trigger_capture(&state, &sc("alt+super+KeyK"), ShortcutState::Pressed));
        assert!(!should_trigger_capture(&state, &sc("alt+super+KeyK"), ShortcutState::Released));
        assert!(!should_trigger_capture(&state, &default_capture_shortcut(), ShortcutState::Pressed));
        let recording = CaptureShortcutState { recording: true, ..state };
        assert!(!should_trigger_capture(&recording, &sc("alt+super+KeyK"), ShortcutState::Pressed));
    }

    #[test]
    fn capture_shortcut_info_は表記_既定かどうか_登録状態を返す() {
        let info = CaptureShortcutInfo::from(&CaptureShortcutState {
            current: default_capture_shortcut(),
            registered: false,
            recording: false,
        });
        assert_eq!(
            info,
            CaptureShortcutInfo {
                accelerator: "shift+super+Digit2".to_string(),
                is_default: true,
                registered: false,
            }
        );
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({ "accelerator": "shift+super+Digit2", "isDefault": true, "registered": false })
        );
    }

    /// 偽の登録器: 呼び出しを記録し、`fail_register` に入っているキーの登録だけ失敗させる。
    #[derive(Default)]
    struct FakeRegistrar {
        calls: Vec<String>,
        fail_register: Vec<Shortcut>,
    }

    impl ShortcutRegistrar for FakeRegistrar {
        fn register(&mut self, shortcut: Shortcut) -> Result<(), String> {
            self.calls.push(format!("register:{}", shortcut.into_string()));
            if self.fail_register.contains(&shortcut) {
                Err("in use".to_string())
            } else {
                Ok(())
            }
        }

        fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String> {
            self.calls.push(format!("unregister:{}", shortcut.into_string()));
            Ok(())
        }
    }

    #[test]
    fn change_shortcut_は旧キーを外して新キーを登録し保存する() {
        let mut registrar = FakeRegistrar::default();
        let mut saved = None;
        let result = change_shortcut(
            &mut registrar,
            default_capture_shortcut(),
            true,
            sc("alt+super+KeyK"),
            |s| {
                saved = Some(s.into_string());
                Ok(())
            },
        );

        assert_eq!(result, Ok(()));
        assert_eq!(registrar.calls, ["unregister:shift+super+Digit2", "register:alt+super+KeyK"]);
        assert_eq!(saved.as_deref(), Some("alt+super+KeyK"));
    }

    #[test]
    fn change_shortcut_は同じキーで登録済みなら何もしない() {
        let mut registrar = FakeRegistrar::default();
        let result = change_shortcut(&mut registrar, default_capture_shortcut(), true, default_capture_shortcut(), |_| {
            panic!("保存しないはず")
        });

        assert_eq!(result, Ok(()));
        assert!(registrar.calls.is_empty());
    }

    #[test]
    fn change_shortcut_は新キーを登録できなければ元のキーを登録し直す() {
        let next = sc("alt+super+KeyK");
        let mut registrar = FakeRegistrar {
            fail_register: vec![next],
            ..Default::default()
        };
        let result = change_shortcut(&mut registrar, default_capture_shortcut(), true, next, |_| {
            panic!("保存しないはず")
        });

        assert_eq!(
            result,
            Err(ChangeFailure {
                error: ChangeError::Register,
                current_registered: true
            })
        );
        assert_eq!(
            registrar.calls,
            ["unregister:shift+super+Digit2", "register:alt+super+KeyK", "register:shift+super+Digit2"]
        );
    }

    #[test]
    fn change_shortcut_は保存に失敗したら新キーを外して元のキーに戻す() {
        let mut registrar = FakeRegistrar::default();
        let result = change_shortcut(
            &mut registrar,
            default_capture_shortcut(),
            true,
            sc("alt+super+KeyK"),
            |_| Err("disk full".to_string()),
        );

        assert_eq!(
            result,
            Err(ChangeFailure {
                error: ChangeError::Save,
                current_registered: true
            })
        );
        assert_eq!(
            registrar.calls,
            [
                "unregister:shift+super+Digit2",
                "register:alt+super+KeyK",
                "unregister:alt+super+KeyK",
                "register:shift+super+Digit2"
            ]
        );
    }

    #[test]
    fn change_shortcut_は元のキーが未登録なら外さず_失敗しても登録し直さない() {
        let next = sc("alt+super+KeyK");
        let mut registrar = FakeRegistrar {
            fail_register: vec![next],
            ..Default::default()
        };
        let result = change_shortcut(&mut registrar, default_capture_shortcut(), false, next, |_| Ok(()));

        assert_eq!(
            result,
            Err(ChangeFailure {
                error: ChangeError::Register,
                current_registered: false
            })
        );
        assert_eq!(registrar.calls, ["register:alt+super+KeyK"]);
    }

    #[test]
    fn change_shortcut_は未登録の同じキーなら登録し直す() {
        let mut registrar = FakeRegistrar::default();
        let result = change_shortcut(&mut registrar, default_capture_shortcut(), false, default_capture_shortcut(), |_| Ok(()));

        assert_eq!(result, Ok(()));
        assert_eq!(registrar.calls, ["register:shift+super+Digit2"]);
    }

    #[test]
    fn change_shortcut_は元のキーの再登録にも失敗したら未登録と伝える() {
        let next = sc("alt+super+KeyK");
        let mut registrar = FakeRegistrar {
            fail_register: vec![next, default_capture_shortcut()],
            ..Default::default()
        };
        let result = change_shortcut(&mut registrar, default_capture_shortcut(), true, next, |_| Ok(()));

        assert_eq!(
            result,
            Err(ChangeFailure {
                error: ChangeError::Register,
                current_registered: false
            })
        );
    }

    #[test]
    fn キーの保存は縮めてコピーの設定を消さない() {
        let dir = std::env::temp_dir().join(format!("tadcap-shortcuts-test-{}-keep", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{ "version": 1, "shrinkCopy": true }"#).unwrap();
        let store = SettingsStore::load(Some(path.clone()));

        save_capture_shortcut(&store, &sc("alt+super+KeyK")).unwrap();

        let saved = crate::settings::load_settings(&path);
        assert_eq!(saved.capture_shortcut.as_deref(), Some("alt+super+KeyK"));
        assert!(saved.shrink_copy, "キーの保存で shrinkCopy が消えた");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
