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

use std::time::Instant;

use tauri::App;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::tray;

/// 既定のグローバルショートカット(PRD FR-004)。表示用の説明文字列。
///
/// キー変更UIは提供しないため(MVP外、PRD FR-004受け入れ基準)、既定値は
/// この定数と [`default_capture_shortcut`] の1箇所にのみ定義する(T16指示)。
const DEFAULT_SHORTCUT_DESCRIPTION: &str = "Cmd+Shift+2";

/// 既定のグローバルショートカットキーを構築する純粋関数(cargo testで検証可能)。
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

/// グローバルショートカットプラグインを登録し、既定キーを登録する
/// (ARCH §11 (c)、`lib.rs::run()` の `setup()` から `tray::build_tray(app)?` の
/// 直後に呼ばれる)。
///
/// 他アプリが既にキーを使用している等でキー登録(`register`)自体が失敗しても、
/// アプリ全体の起動を失敗させない(PJM指摘)。ログを出力したうえで `Ok(())` を
/// 返して起動を継続する。プラグイン自体の初期化(`plugin()`)が失敗した場合も
/// 同様に起動を継続する(ショートカットが使えないだけで、アプリの他機能は
/// 問題なく使えるべきと判断したため)。
pub(crate) fn register_capture_shortcut(app: &App) -> tauri::Result<()> {
    let shortcut = default_capture_shortcut();

    let plugin_result = app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, event_shortcut, event| {
                if *event_shortcut != shortcut {
                    return;
                }
                if !should_handle_shortcut_event(event.state()) {
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

    if let Err(err) = app.global_shortcut().register(shortcut) {
        eprintln!(
            "グローバルショートカット({DEFAULT_SHORTCUT_DESCRIPTION})の登録に失敗しました。\
             他アプリが既に同じキーを使用している可能性があります。ショートカットは\
             無効のままアプリを継続します: {err}"
        );
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
}
