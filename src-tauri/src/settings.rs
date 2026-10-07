//! アプリ設定ファイルの読み書き(キャプチャのショートカット変更、KS-T1)。
//!
//! 場所は `app_config_dir()/settings.json`(macOS では
//! `~/Library/Application Support/dev.tadcap.app/settings.json`)。形式は
//! `{ "version": 1, "captureShortcut": "shift+super+KeyK" }` で、`captureShortcut` が無ければ既定キー。
//!
//! - 読込: ファイルが無い・壊れている場合は既定値で起動する(ログのみ。次の保存で上書きされる)
//! - 書込: 同じディレクトリの一時ファイルへ書いてから `rename` する(書きかけのファイルを残さない)。
//!   ディレクトリが無ければ作る
//!
//! store プラグインは使わず、導入済みの `serde_json` で保存する(依存を増やさない)。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 設定ファイルの名前(`app_config_dir()` 直下)。
const SETTINGS_FILE_NAME: &str = "settings.json";

/// 現在の設定ファイルの形式の版。
const SETTINGS_VERSION: u32 = 1;

/// アプリ設定(永続化する値)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettings {
    /// キャプチャのショートカット(`global-hotkey` の文字列形式。例 `"shift+super+KeyK"`)。
    /// `None` は既定キー(⌘⇧2)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_shortcut: Option<String>,
}

/// ファイル上の形(版番号を付ける)。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(flatten)]
    settings: AppSettings,
}

fn default_version() -> u32 {
    SETTINGS_VERSION
}

/// 設定ファイルのパス(`app_config_dir()` が取れない環境では `None`)。
pub(crate) fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE_NAME))
}

/// 設定を読む。ファイルが無い・読めない・壊れている場合は既定値を返す(壊れているときはログを出す)。
pub(crate) fn load_settings(path: &Path) -> AppSettings {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return AppSettings::default(),
        Err(err) => {
            eprintln!("設定ファイルを読めませんでした。既定の設定で起動します: {err}");
            return AppSettings::default();
        }
    };
    match serde_json::from_str::<SettingsFile>(&text) {
        Ok(file) => file.settings,
        Err(err) => {
            eprintln!("設定ファイルが壊れています。既定の設定で起動します: {err}");
            AppSettings::default()
        }
    }
}

/// 設定を保存する。一時ファイルに書いてから置き換える(書きかけのファイルを残さない)。
pub(crate) fn save_settings(path: &Path, settings: &AppSettings) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "設定ファイルの親ディレクトリがありません"))?;
    fs::create_dir_all(dir)?;
    let file = SettingsFile {
        version: SETTINGS_VERSION,
        settings: settings.clone(),
    };
    let json = serde_json::to_string_pretty(&file).map_err(io::Error::other)?;

    let tmp = path.with_extension("json.tmp");
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(json.as_bytes())?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// テストごとに別の一時ディレクトリを使う(並列実行で干渉しないように)。
    fn temp_dir(name: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "tadcap-settings-test-{}-{name}-{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn ファイルが無ければ既定値を返す() {
        let dir = temp_dir("missing");
        assert_eq!(load_settings(&dir.join("settings.json")), AppSettings::default());
    }

    #[test]
    fn 保存した値を読み戻せる_ディレクトリが無くても作る() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("nested").join("settings.json");
        let settings = AppSettings {
            capture_shortcut: Some("alt+super+KeyK".to_string()),
        };

        save_settings(&path, &settings).expect("保存に失敗した");

        assert_eq!(load_settings(&path), settings);
        assert!(!path.with_extension("json.tmp").exists(), "一時ファイルが残っている");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ファイルには版番号とcamel_caseのキーで書く() {
        let dir = temp_dir("format");
        let path = dir.join("settings.json");
        save_settings(
            &path,
            &AppSettings {
                capture_shortcut: Some("shift+super+KeyK".to_string()),
            },
        )
        .unwrap();

        let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["captureShortcut"], "shift+super+KeyK");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 既定値はキーを書かない() {
        let dir = temp_dir("default");
        let path = dir.join("settings.json");
        save_settings(&path, &AppSettings::default()).unwrap();

        let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(value.get("captureShortcut").is_none());
        assert_eq!(load_settings(&path), AppSettings::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 壊れたファイルは既定値として読む() {
        let dir = temp_dir("broken");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, "{ not json").unwrap();

        assert_eq!(load_settings(&path), AppSettings::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 知らないフィールドは無視し_版番号が無くても読める() {
        let dir = temp_dir("unknown");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, r#"{ "captureShortcut": "control+super+KeyP", "future": true }"#).unwrap();

        assert_eq!(
            load_settings(&path),
            AppSettings {
                capture_shortcut: Some("control+super+KeyP".to_string()),
            }
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 上書き保存で前の値を置き換える() {
        let dir = temp_dir("overwrite");
        let path = dir.join("settings.json");
        save_settings(
            &path,
            &AppSettings {
                capture_shortcut: Some("alt+super+KeyA".to_string()),
            },
        )
        .unwrap();
        save_settings(&path, &AppSettings::default()).unwrap();

        assert_eq!(load_settings(&path), AppSettings::default());
        let _ = fs::remove_dir_all(&dir);
    }
}
