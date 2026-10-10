mod app_menu;
mod capture;
mod clipboard;
mod commands;
mod error;
// 機密情報の自動マスキング(ARCH_auto-masking)。呼び出し口は `commands::scan_sensitive_text`。
mod masking;
mod settings;
mod shortcuts;
mod tray;
mod window_front;

use tauri::Manager;

/// パニックの報告の 1 行。パニックの文言(payload)は出さず、発生場所(ファイル:行:列)だけにする
/// (AM-T25-F2。文字列の切り出しの標準パニックは、読み取った文字列の一部を文言に含むため。CWE-209/532)。
fn panic_report(info: &std::panic::PanicHookInfo<'_>) -> String {
    match info.location() {
        Some(location) => format!("[tadcap:panic] at {}:{}:{}", location.file(), location.line(), location.column()),
        None => "[tadcap:panic] at <unknown>".to_string(),
    }
}

/// 標準のパニックの表示(文言を含む)を、発生場所だけを標準エラーに出すフックに置き換える。
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| eprintln!("{}", panic_report(info))));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 何より先に入れる(以降のどのスレッドのパニックにも効く)
    install_panic_hook();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // 設定ファイルの読み書きの窓口(QE-T05)。ショートカットの登録が保存値を読むので最初に置く。
            app.manage(settings::SettingsStore::load(settings::settings_path(app.handle())));
            // 起動時に前回セッションの一時キャプチャファイルを削除する(PJM追加指示)。
            // 表示中の画像はcanvas/履歴側がメモリに保持しているためUIには影響しない。
            // 削除失敗はログのみで起動を妨げない(`cleanup_capture_files` 内部の方針)。
            capture::cleanup_capture_files();

            // v0.3.1(人間の決定 2026-10-07): Dockにも表示する通常のアプリにする(以前のAccessory=Dock
            // 非表示をやめた)。メニューバーのアイコンが多くて隠れても、Dockからエディタを開け、⌘Tabで
            // 切り替え、⌘Q(既定のアプリメニュー)で終了できるように。メニューバー常駐は続ける。
            // メニューバー常駐トレイ(「キャプチャ」「エディタを開く」「終了」、FR-009、T15)。
            tray::build_tray(app)?;
            // アプリメニュー(画面上部)に「設定…」(⌘,)を足す(KS-T6)。
            app_menu::install_app_menu(app)?;
            // グローバルショートカット登録(既定 Cmd+Shift+2、FR-004、T16)。
            // ARCH §11 の順序どおりトレイの直後に登録する(トレイの「キャプチャ」と
            // 同じ内部関数を呼ぶため、先にコマンド一式が使える状態にしておく)。
            // モバイルではグローバルショートカットプラグイン非対応のため
            // `#[cfg(desktop)]` でガードする(公式ドキュメント記載のパターン)。
            #[cfg(desktop)]
            shortcuts::register_capture_shortcut(app)?;
            Ok(())
        })
        // アプリメニューの「設定…」(KS-T6)。トレイのメニューは`tray.rs`が別のIDで処理する。
        .on_menu_event(|app, event| app_menu::handle_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| match event {
            // ウィンドウを閉じてもプロセスは継続する(終了はトレイメニューの「終了」と⌘Q・Dockの「終了」、
            // FR-009。閉じたエディタはDockのアイコン・トレイの「エディタを開く」で再表示する)。
            tauri::WindowEvent::CloseRequested { api, .. } => {
                window.hide().ok();
                api.prevent_close();
            }
            // v0.2.2: エディタがキーになったとき、アプリが非アクティブならアクティブ化を要求する
            // (日本語IMEはアクティブなアプリにだけ働くため。既にアクティブなら何もしない)。
            tauri::WindowEvent::Focused(true) => {
                window_front::ensure_app_active(window.app_handle(), window_front::ActivationOrigin::WindowFocused);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::capture_screen,
            commands::check_screen_recording_permission,
            commands::open_screen_recording_settings,
            commands::write_image_fallback,
            commands::read_capture_image,
            commands::activate_app,
            commands::get_capture_shortcut,
            commands::set_capture_shortcut,
            commands::reset_capture_shortcut,
            commands::set_shortcut_recording,
            commands::scan_sensitive_text,
            commands::get_shrink_copy,
            commands::set_shrink_copy
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| match event {
            // Dockのアイコンを押したら、閉じて隠したエディタも含めて前面に出す(v0.3.1)。
            // ユーザーがこのアプリを直接操作した直後なので、トレイの「エディタを開く」と同じ手順。
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                window_front::bring_main_window_to_front(
                    app_handle,
                    "dock_reopen",
                    window_front::FrontTrigger::UserMenu,
                );
            }
            // 終了時に一時キャプチャファイルを削除する(PJM追加指示)。
            // `RunEvent::Exit`は「イベントループが終了する直前」に1回だけ発火する
            // (tauri 2.11.6 `app.rs` の doc「Event loop is exiting.」、確認済み)。
            // トレイメニュー「終了」(`tray.rs` の `app.exit(0)`)・⌘Q経由の終了も、
            // 最終的にここへ到達する。
            tauri::RunEvent::Exit => {
                capture::cleanup_capture_files();
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use std::panic;
    use std::sync::Mutex;

    use super::panic_report;

    /// テストのパニックのフックが受け取った報告。
    static REPORTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

    #[test]
    fn パニックの報告は文言を含まず発生場所だけを含む() {
        const SECRET: &str = "架空の機密 taro@example.com 03-1234-5678";
        let previous = panic::take_hook();
        panic::set_hook(Box::new(|info| {
            if let Ok(mut reports) = REPORTS.lock() {
                reports.push(panic_report(info));
            }
        }));
        let line = line!() + 1;
        let result = panic::catch_unwind(|| panic!("{}", SECRET));
        panic::set_hook(previous);
        assert!(result.is_err());

        let reports = REPORTS.lock().map(|r| r.clone()).unwrap_or_default();
        let expected = format!("src/lib.rs:{line}:");
        let report = reports.iter().find(|r| r.contains(&expected)).expect("このテストのパニックの報告が無い");
        assert!(report.starts_with("[tadcap:panic] at "), "形式: {} 文字", report.len());
        for part in [SECRET, "架空の機密", "taro@example.com", "03-1234-5678"] {
            assert!(reports.iter().all(|r| !r.contains(part)), "報告に文言が入っている");
        }
    }
}
