//! アプリ設定ファイルの読み書き(キャプチャのショートカット変更、KS-T1)。
//!
//! 場所は `app_config_dir()/settings.json`(macOS では
//! `~/Library/Application Support/dev.tadcap.app/settings.json`)。形式は
//! `{ "version": 1, "captureShortcut": "shift+super+KeyK", "shrinkCopy": true }` で、
//! `captureShortcut` が無ければ既定キー、`shrinkCopy` が無ければオフ(QE-T05)。
//!
//! - 読込: ファイルが無い・壊れている場合は既定値で起動する(ログのみ。次の保存で上書きされる)
//! - 書込: 同じディレクトリの一時ファイルへ書いてから `rename` する(書きかけのファイルを残さない)。
//!   ディレクトリが無ければ作る
//! - 書くのは [`SettingsStore`] だけ(QE-T05)。今の設定を読んで 1 項目だけ変えて書くので、
//!   ある項目の保存で別の項目が消えない。知らない項目(新しい版が書いたもの)も残して書き戻す
//!
//! store プラグインは使わず、導入済みの `serde_json` で保存する(依存を増やさない)。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
    /// コピーするとき画面の倍率ぶん縮めるか(QE-T05、FR-011)。オフのときはキーを書かない。
    #[serde(default, skip_serializing_if = "is_false")]
    pub shrink_copy: bool,
    /// このアプリが知らない項目(新しい版が書いたもの)。保存し直しても消さないように持っておく。
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn is_false(value: &bool) -> bool {
    !*value
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

/// 設定ファイルの読み書きを 1 か所にまとめる(`app.manage()`、QE-T05)。
///
/// 今の設定をメモリに持ち、[`SettingsStore::update`] で 1 項目だけ変えて保存する。
/// 更新は `Mutex` を握ったまま保存まで行うので、別々の箇所からの書き込みが直列になる。
pub(crate) struct SettingsStore {
    /// 保存先(`app_config_dir()` が取れない環境では `None`。そのとき保存は失敗する)。
    path: Option<PathBuf>,
    settings: Mutex<AppSettings>,
}

impl SettingsStore {
    /// 保存先から設定を読む(無い・壊れているときは既定値。[`load_settings`] の方針どおり)。
    pub(crate) fn load(path: Option<PathBuf>) -> Self {
        let settings = path.as_deref().map(load_settings).unwrap_or_default();
        Self {
            path,
            settings: Mutex::new(settings),
        }
    }

    /// 今の設定の写しを返す。
    pub(crate) fn get(&self) -> AppSettings {
        self.lock().clone()
    }

    /// 今の設定に `f` を当てて保存し、保存後の設定を返す。保存に失敗したらメモリの値は変えない。
    pub(crate) fn update(&self, f: impl FnOnce(&mut AppSettings)) -> io::Result<AppSettings> {
        let mut current = self.lock();
        let mut next = current.clone();
        f(&mut next);
        let path = self
            .path
            .as_deref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "設定の保存先がありません"))?;
        save_settings(path, &next)?;
        *current = next.clone();
        Ok(next)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AppSettings> {
        self.settings.lock().unwrap_or_else(|e| e.into_inner())
    }
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
            ..Default::default()
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
                ..Default::default()
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
    fn 知らないフィールドは読込を妨げず_版番号が無くても読める() {
        let dir = temp_dir("unknown");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, r#"{ "captureShortcut": "control+super+KeyP", "future": true }"#).unwrap();

        let loaded = load_settings(&path);
        assert_eq!(loaded.capture_shortcut.as_deref(), Some("control+super+KeyP"));
        assert!(!loaded.shrink_copy);
        // 知らない項目は保存し直すときのために持つ(QE-T05)。版番号は項目に混ぜない
        assert_eq!(loaded.extra.get("future"), Some(&serde_json::Value::Bool(true)));
        assert!(loaded.extra.get("version").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- QE-T05: shrinkCopy と SettingsStore ----

    fn read_json(path: &Path) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn shrink_copyの無い古いファイルはオフとして読む() {
        let dir = temp_dir("legacy");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, r#"{ "version": 1, "captureShortcut": "alt+super+KeyK" }"#).unwrap();

        let store = SettingsStore::load(Some(path));
        assert!(!store.get().shrink_copy);
        assert_eq!(store.get().capture_shortcut.as_deref(), Some("alt+super+KeyK"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn shrink_copyがオフのときはキーを書かず_オンでtrueを書く() {
        let dir = temp_dir("shrink-key");
        let path = dir.join("settings.json");
        let store = SettingsStore::load(Some(path.clone()));

        store.update(|s| s.shrink_copy = true).unwrap();
        assert_eq!(read_json(&path)["shrinkCopy"], true);

        store.update(|s| s.shrink_copy = false).unwrap();
        assert!(read_json(&path).get("shrinkCopy").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ショートカットを変えてもshrink_copyが消えない_逆も同じ() {
        let dir = temp_dir("keep-other");
        let path = dir.join("settings.json");
        let store = SettingsStore::load(Some(path.clone()));

        store.update(|s| s.shrink_copy = true).unwrap();
        store
            .update(|s| s.capture_shortcut = Some("alt+super+KeyK".to_string()))
            .unwrap();
        let reloaded = load_settings(&path);
        assert!(reloaded.shrink_copy, "ショートカットの保存で shrinkCopy が消えた");
        assert_eq!(reloaded.capture_shortcut.as_deref(), Some("alt+super+KeyK"));

        store.update(|s| s.shrink_copy = false).unwrap();
        assert_eq!(
            load_settings(&path).capture_shortcut.as_deref(),
            Some("alt+super+KeyK"),
            "shrinkCopy の保存でショートカットが消えた"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 保存に失敗したらメモリの値を戻してエラーを返す() {
        let dir = temp_dir("save-fail");
        fs::create_dir_all(&dir).unwrap();
        // 親が「ファイル」なのでディレクトリを作れず保存に失敗する
        let blocker = dir.join("blocker");
        fs::write(&blocker, "x").unwrap();
        let store = SettingsStore::load(Some(blocker.join("settings.json")));

        assert!(store.update(|s| s.shrink_copy = true).is_err());
        assert!(!store.get().shrink_copy, "失敗したのにメモリの値が変わった");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 保存先が無いときは保存に失敗しメモリの値を戻す() {
        let store = SettingsStore::load(None);
        assert_eq!(store.get(), AppSettings::default());
        assert!(store.update(|s| s.shrink_copy = true).is_err());
        assert!(!store.get().shrink_copy);
    }

    #[test]
    fn 更新は保存後の設定を返す() {
        let dir = temp_dir("update-returns");
        let store = SettingsStore::load(Some(dir.join("settings.json")));
        let saved = store.update(|s| s.shrink_copy = true).unwrap();
        assert!(saved.shrink_copy);
        assert_eq!(saved, store.get());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 知らない項目は保存し直しても残す() {
        let dir = temp_dir("keep-unknown");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(
            &path,
            r#"{ "version": 1, "captureShortcut": "alt+super+KeyK", "future": { "a": [1, 2] } }"#,
        )
        .unwrap();
        let store = SettingsStore::load(Some(path.clone()));

        store.update(|s| s.shrink_copy = true).unwrap();
        let value = read_json(&path);
        assert_eq!(value["future"], serde_json::json!({ "a": [1, 2] }));
        assert_eq!(value["captureShortcut"], "alt+super+KeyK");
        assert_eq!(value["shrinkCopy"], true);
        assert_eq!(value["version"], 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 壊れたファイルのストアは既定値で始まり次の保存で上書きする() {
        let dir = temp_dir("broken-store");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        let store = SettingsStore::load(Some(path.clone()));
        assert_eq!(store.get(), AppSettings::default());

        store.update(|s| s.shrink_copy = true).unwrap();
        assert!(load_settings(&path).shrink_copy);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 並行した更新は直列化され_どの項目も失われない() {
        let dir = temp_dir("concurrent");
        let path = dir.join("settings.json");
        let store = std::sync::Arc::new(SettingsStore::load(Some(path.clone())));
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let store = store.clone();
                std::thread::spawn(move || {
                    if i % 2 == 0 {
                        store.update(|s| s.shrink_copy = true).unwrap();
                    } else {
                        store
                            .update(|s| s.capture_shortcut = Some("alt+super+KeyK".to_string()))
                            .unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let reloaded = load_settings(&path);
        assert!(reloaded.shrink_copy);
        assert_eq!(reloaded.capture_shortcut.as_deref(), Some("alt+super+KeyK"));
        assert_eq!(reloaded, store.get());
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
                ..Default::default()
            },
        )
        .unwrap();
        save_settings(&path, &AppSettings::default()).unwrap();

        assert_eq!(load_settings(&path), AppSettings::default());
        let _ = fs::remove_dir_all(&dir);
    }
}
