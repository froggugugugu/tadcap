//! メニューバー常駐(トレイ)を構築するモジュール(ARCH §1.1・§11、T15、FR-009)。
//!
//! 「キャプチャ」「エディタを開く」「終了」の3項目メニューを持つトレイアイコンを
//! 構築する。メニューIDからアクションを判定する純粋ロジック
//! ([`tray_menu_action_from_id`])と、実際の副作用(ウィンドウ操作・キャプチャ実行)
//! を分離し、前者のみ `cargo test` で検証する。トレイ・ウィンドウ・Dockアイコンの
//! 実際の挙動はOSネイティブ導線のため自動化せず、手動確認チェックリスト#4・#7へ回す
//! (T15指示、`output/tasks/TASK_tadcap_mvp.md`)。

use std::time::Instant;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter,
};

use crate::commands;
use crate::window_front::{self, FrontTrigger};

/// トレイメニュー項目のID(`MenuItem::with_id` に渡す固定文字列)。
const MENU_ID_CAPTURE: &str = "capture";
const MENU_ID_OPEN_EDITOR: &str = "open_editor";
const MENU_ID_QUIT: &str = "quit";

/// `run_capture_and_show_editor` がキャプチャ失敗時にフロントエンドへ送出する
/// Tauri イベント名。
///
/// トレイ・グローバルショートカット起点のキャプチャは(コマンドの `invoke` と違い)
/// 呼び出し元に戻り値を返せない(ARCH §1.3 決定#4: OS起点の通知はイベントを使う)。
/// `capture://completed` と対になる失敗通知イベントだが、ARCHに明記が無いため、
/// 既存の `capture://` 名前空間に揃えた最小のイベント名をT15で新設する(案内UI自体は
/// T08が実装。ペイロードは `AppError` の `Display` 文字列で、`commands.rs` の
/// コマンド戻り値と同じ形式)。
pub(crate) const CAPTURE_ERROR_EVENT: &str = "capture://error";

/// トレイメニューのID文字列が表すアクション(純粋な列挙)。
///
/// `tray_menu_action_from_id` の戻り値としてのみ使う。実際の副作用(ウィンドウ操作・
/// キャプチャ実行・終了)は `on_menu_event` ハンドラ側で行う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrayMenuAction {
    Capture,
    OpenEditor,
    Quit,
}

/// メニューID文字列から対応するアクションを判定する純粋関数(cargo testで検証)。
///
/// 未知のIDは `None`(将来メニュー項目が増減してもここでガードされる)。
pub(crate) fn tray_menu_action_from_id(id: &str) -> Option<TrayMenuAction> {
    match id {
        MENU_ID_CAPTURE => Some(TrayMenuAction::Capture),
        MENU_ID_OPEN_EDITOR => Some(TrayMenuAction::OpenEditor),
        MENU_ID_QUIT => Some(TrayMenuAction::Quit),
        _ => None,
    }
}

/// キャプチャ結果に応じた後続処理(純粋な列挙、実機不具合①の再発防止テスト用)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CaptureFollowUp {
    /// 撮影成功: エディタを前面表示する。
    ShowEditor,
    /// 失敗(権限未許可等): `capture://error` を送出してからエディタを前面表示する。
    NotifyErrorAndShowEditor,
    /// Escキャンセル・他起点が実行中: 何もしない。
    Nothing,
}

/// `commands::run_capture` の結果から後続処理を決める純粋関数。
pub(crate) fn capture_follow_up<T, E>(result: &Result<Option<T>, E>) -> CaptureFollowUp {
    match result {
        Ok(Some(_)) => CaptureFollowUp::ShowEditor,
        Ok(None) => CaptureFollowUp::Nothing,
        Err(_) => CaptureFollowUp::NotifyErrorAndShowEditor,
    }
}

/// キャプチャを実行し、結果に応じてエディタウィンドウを前面表示する共通処理。
///
/// トレイ「キャプチャ」・グローバルショートカット(`shortcuts.rs`、T16)の両方が
/// 呼ぶ(T15指示により切り出し、重複実装回避)。
///
/// - 成功時: `commands::run_capture` が送出済みの `capture://completed` をフロントが
///   受信できるよう、エディタウィンドウを前面表示する
/// - 失敗時(画面収録権限未許可 等): `CAPTURE_ERROR_EVENT` でエラー種別をフロントへ
///   伝えたうえで、エディタウィンドウを前面表示する(案内UI自体はT08)
/// - Escキャンセル・他起点が実行中(`Ok(None)`): 画像が生成されていないため、
///   ウィンドウ前面表示・イベント送出のいずれも行わない
///
/// # メインスレッドを塞がない(T16、PJM指摘対応)
///
/// トレイの `on_menu_event`・グローバルショートカットの `with_handler` は
/// いずれもTauriのメインイベントループ上で同期的に呼ばれる(Tauri公式の
/// プロセスモデル・トレイ/ショートカットのイベント配送は他のOSイベントと同じ
/// メインスレッド上で行われる)。`commands::run_capture` 内部の
/// `screencapture -i` 実行はブロッキングなので、ここで同期的に待ち受けると
/// メインスレッド(UI含む)が固まる。そのため本関数は
/// `tauri::async_runtime::spawn` で非同期タスクへ切り出し、即座に呼び出し元
/// (メインスレッド上のイベントハンドラ)へ制御を返す。タスク完了後のウィンドウ操作は
/// [`window_front::bring_main_window_to_front`] が
/// [`AppHandle::run_on_main_thread`](https://docs.rs/tauri/latest/tauri/struct.AppHandle.html#method.run_on_main_thread)
/// (公式ドキュメント「Runs the given closure on the main thread.」)でメインスレッドへ
/// 戻して行う(再試行の待ち時間は専用スレッドで待つ。B2)。`emit()` はスレッドに依存しない(async コマンドの中から呼ぶのが通常の
/// 使い方であり、公式ドキュメントのチャンネル例でも非メインスレッド相当のタスクから
/// 呼ばれている)ため、そのまま呼んでよい。
///
/// `origin`(呼び出し元。トレイなら`"tray"`、グローバルショートカットなら
/// `"shortcut"`)・`start`(押下を受け取った時刻)は NFR-001 中間計測(T11)のために
/// `commands::run_capture` へそのまま引き渡す。
pub(crate) fn run_capture_and_show_editor(app: &AppHandle, origin: &'static str, start: Instant) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = commands::run_capture(&app, origin, start).await;
        let follow_up = capture_follow_up(&result);
        // B2 診断: 撮影後にエディタ前面化の経路へ入ったかを記録する(Nothing = Esc/実行中)。
        window_front::log_route(origin, "follow_up", &format!("{follow_up:?}"));
        match (follow_up, result) {
            (CaptureFollowUp::ShowEditor, _) => {
                window_front::bring_main_window_to_front(&app, origin, FrontTrigger::AfterCapture)
            }
            (CaptureFollowUp::NotifyErrorAndShowEditor, Err(err)) => {
                if let Err(emit_err) = app.emit(CAPTURE_ERROR_EVENT, err.to_string()) {
                    eprintln!("capture://error の送出に失敗しました: {emit_err}");
                }
                window_front::bring_main_window_to_front(&app, origin, FrontTrigger::AfterCapture);
            }
            _ => {}
        }
    });
}

/// トレイアイコン・メニューを構築する(ARCH §11 (b)、FR-009)。
///
/// 「キャプチャ」「エディタを開く」「終了」の3項目。いずれも `commands.rs`
/// の既存処理・本モジュールの共通関数を呼ぶだけで、トレイ固有の実装は持たない
/// (ARCH §3.2 依存方向ルール)。`lib.rs::run()` の `setup()` から呼ばれる。
pub(crate) fn build_tray(app: &App) -> tauri::Result<()> {
    let capture_i = MenuItem::with_id(app, MENU_ID_CAPTURE, "キャプチャ", true, None::<&str>)?;
    let open_editor_i = MenuItem::with_id(
        app,
        MENU_ID_OPEN_EDITOR,
        "エディタを開く",
        true,
        None::<&str>,
    )?;
    let quit_i = MenuItem::with_id(app, MENU_ID_QUIT, "終了", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&capture_i, &open_editor_i, &quit_i])?;

    // メニューバー常駐アイコン: モノクロのオタマジャクシ(人間の要望)。
    //
    // アプリアイコン(Dock用、カラー)を流用していた従来実装をやめ、専用のテンプレート画像を
    // 使う。macOSのメニューバーでは黒+透明のみのテンプレート画像が標準で、`icon_as_template`
    // を立てるとOSがライト/ダークモードに応じて自動で色反転する
    // (公式ドキュメント: <https://developer.apple.com/documentation/appkit/nsimage/1520017-template?language=objc>、
    // Tauri側APIは `tauri::tray::TrayIconBuilder::icon_as_template`)。
    //
    // `Image::from_bytes` はPNGデコードに `image-png` feature を要求する(`Cargo.toml`)。
    // tray-icon crate(Tauriの内部実装)はアイコンをメニューバー上で18pt高へスケールしてから
    // 描画するため(1xソースをそのまま渡すよりも)@2x相当(46x36px)の高解像度ソースを
    // 埋め込んだ方がRetinaできれいに表示される。ソースSVG・1x版PNGは
    // `src-tauri/icons/tray/` に同梱している(将来デザイン調整時の参照用)。
    let tray_icon = Image::from_bytes(include_bytes!("../icons/tray/tadpole@2x.png"))?;

    let builder = TrayIconBuilder::new()
        .menu(&menu)
        .icon(tray_icon)
        .icon_as_template(true);

    builder
        .on_menu_event(
            |app, event| match tray_menu_action_from_id(event.id.as_ref()) {
                // 押下(メニュー選択)を受けた時刻を起点として記録する(NFR-001中間計測、
                // T11、origin="tray")。
                Some(TrayMenuAction::Capture) => {
                    run_capture_and_show_editor(app, "tray", Instant::now())
                }
                Some(TrayMenuAction::OpenEditor) => window_front::bring_main_window_to_front(
                    app,
                    "tray_open",
                    FrontTrigger::UserMenu,
                ),
                Some(TrayMenuAction::Quit) => app.exit(0),
                None => {}
            },
        )
        .build(app)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 実機不具合①(ショートカット起点で編集ウィンドウが前面に来ない)の再発防止。
    #[test]
    fn capture_follow_up_は撮影成功時にエディタを前面表示する() {
        let result: Result<Option<()>, ()> = Ok(Some(()));
        assert_eq!(capture_follow_up(&result), CaptureFollowUp::ShowEditor);
    }

    #[test]
    fn capture_follow_up_は失敗時にエラー通知してからエディタを前面表示する() {
        let result: Result<Option<()>, ()> = Err(());
        assert_eq!(
            capture_follow_up(&result),
            CaptureFollowUp::NotifyErrorAndShowEditor
        );
    }

    #[test]
    fn capture_follow_up_はescキャンセル時に何もしない() {
        let result: Result<Option<()>, ()> = Ok(None);
        assert_eq!(capture_follow_up(&result), CaptureFollowUp::Nothing);
    }

    #[test]
    fn tray_menu_action_from_id_はcaptureをcapture_バリアントへ変換する() {
        assert_eq!(
            tray_menu_action_from_id(MENU_ID_CAPTURE),
            Some(TrayMenuAction::Capture)
        );
    }

    #[test]
    fn tray_menu_action_from_id_はopen_editorをopen_editor_バリアントへ変換する() {
        assert_eq!(
            tray_menu_action_from_id(MENU_ID_OPEN_EDITOR),
            Some(TrayMenuAction::OpenEditor)
        );
    }

    #[test]
    fn tray_menu_action_from_id_はquitをquit_バリアントへ変換する() {
        assert_eq!(
            tray_menu_action_from_id(MENU_ID_QUIT),
            Some(TrayMenuAction::Quit)
        );
    }

    #[test]
    fn tray_menu_action_from_id_は未知のidにnoneを返す() {
        assert_eq!(tray_menu_action_from_id("unknown"), None);
    }

    #[test]
    fn tray_menu_action_from_id_は空文字にnoneを返す() {
        assert_eq!(tray_menu_action_from_id(""), None);
    }
}
