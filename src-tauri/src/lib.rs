mod app_menu;
mod capture;
mod clipboard;
mod commands;
mod error;
// 機密情報の自動マスキング(ARCH_auto-masking)。呼び出し口の `commands::scan_sensitive_text` は
// AM-T18 で入るため、それまでは本番ビルドで未使用の警告(clippy `-D warnings` で SMOKE が落ちる)を
// 下の属性で抑える。AM-T18 で属性ごと必ず外す(テストビルドでは抑えない)。
#[cfg_attr(not(test), allow(dead_code))]
mod masking;
mod settings;
mod shortcuts;
mod tray;
mod window_front;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
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
            commands::set_shortcut_recording
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
