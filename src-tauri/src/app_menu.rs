//! アプリメニュー(画面上部の Tadcap メニュー)に「設定…」(⌘,)を足す(KS-T6)。
//!
//! v0.3.1 で Dock に表示する通常のアプリにしたため、Tauri の既定のアプリメニューが出る。その先頭
//! (Tadcap)サブメニューの「Tadcap について」の後ろに「設定…」を差し込み、選ばれたらトレイの
//! 「設定…」と同じ [`tray::open_settings`] を呼ぶ。メニュー ID の判定だけを純粋関数にして
//! `cargo test` し、メニューの見た目・操作は手動確認に回す。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{App, AppHandle};

use crate::tray;

/// アプリメニューの「設定…」の ID(トレイの ID と分け、二重に処理しないようにする)。
const MENU_ID_APP_SETTINGS: &str = "app_settings";

/// アプリメニューの項目が表すアクション。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppMenuAction {
    OpenSettings,
}

/// メニュー ID からアクションを判定する純粋関数。既定メニューの項目(コピー・終了など)は`None`。
pub(crate) fn app_menu_action_from_id(id: &str) -> Option<AppMenuAction> {
    match id {
        MENU_ID_APP_SETTINGS => Some(AppMenuAction::OpenSettings),
        _ => None,
    }
}

/// 既定のアプリメニューを作り、先頭サブメニューの「Tadcap について」と区切り線の後ろに
/// 「設定…」(⌘,)と区切り線を差し込んで設定する(`lib.rs` の `setup()` から呼ぶ)。
pub(crate) fn install_app_menu(app: &App) -> tauri::Result<()> {
    let handle = app.handle();
    let menu = Menu::default(handle)?;
    if let Some(app_submenu) = menu.items()?.first().and_then(|item| item.as_submenu().cloned()) {
        let settings = MenuItem::with_id(handle, MENU_ID_APP_SETTINGS, "設定…", true, Some("CmdOrCtrl+,"))?;
        let separator = PredefinedMenuItem::separator(handle)?;
        app_submenu.insert(&settings, 2)?;
        app_submenu.insert(&separator, 3)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

/// アプリ全体のメニューイベント(`Builder::on_menu_event`)を処理する。
pub(crate) fn handle_menu_event(app: &AppHandle, id: &str) {
    if let Some(AppMenuAction::OpenSettings) = app_menu_action_from_id(id) {
        tray::open_settings(app, "app_menu_settings");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_menu_action_from_id_は設定のidだけをアクションにする() {
        assert_eq!(app_menu_action_from_id(MENU_ID_APP_SETTINGS), Some(AppMenuAction::OpenSettings));
        assert_eq!(app_menu_action_from_id("settings"), None, "トレイの「設定…」はトレイ側で処理する");
        assert_eq!(app_menu_action_from_id("quit"), None);
        assert_eq!(app_menu_action_from_id(""), None);
    }
}
