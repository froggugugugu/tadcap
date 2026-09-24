//! OS一時ディレクトリ配下に、キャプチャ画像専用の一意なファイルパスを生成する。
//!
//! `screencapture -i <path>` に渡すパスを毎回一意にすることで、固定パスへの
//! 上書きを防ぐ(ARCH §7.2、PRD FR-001)。生成されるパスは常に
//! `<OS一時ディレクトリ>/tadcap-captures/` 配下に限定する。フロントエンドは
//! このディレクトリ直下の画像だけを `commands::read_capture_image` 経由で読める
//! ([`read_capture_file`]。asset protocolは実機不具合②〜⑤の修正で撤去した)。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// キャプチャ用一時ファイルを置くサブディレクトリ名。
pub const CAPTURE_SUBDIR: &str = "tadcap-captures";

/// 呼び出しごとに増加するカウンタ。同一ナノ秒内での衝突を避けるための補助
/// (高速な連続呼び出しでも一意性を保証する)。
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// キャプチャ用一時ディレクトリのパス(`<OS一時ディレクトリ>/tadcap-captures/`)。
pub fn capture_dir() -> PathBuf {
    std::env::temp_dir().join(CAPTURE_SUBDIR)
}

/// OS一時ディレクトリ配下の専用サブディレクトリに、一意なキャプチャ用ファイル
/// パス(PNG)を生成する。サブディレクトリが存在しない場合は作成する。
///
/// `screencapture -i <path>` はディレクトリを自動作成しないため、ここで
/// `create_dir_all` を行う。
pub fn generate_capture_path() -> std::io::Result<PathBuf> {
    let dir = capture_dir();
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(unique_filename()))
}

/// プロセスID・ナノ秒タイムスタンプ・連番を組み合わせた一意なファイル名を返す
/// (`uuid` 等の追加クレートは導入せず、標準ライブラリのみで一意性を担保する)。
fn unique_filename() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("capture-{nanos}-{seq}-{}.png", std::process::id())
}

/// 一時キャプチャファイル自動削除の対象判定に使う、ファイルシステムから独立した
/// 情報(起動時・終了時のクリーンアップ、PJM追加指示)。
///
/// `std::fs::DirEntry` から直接この型を作ることで、判定ロジック
/// ([`is_deletable_capture_file`])を実ファイルシステムに依存せずユニットテスト
/// できるようにする(既存コードのpure/impure分離パターンを踏襲。例:
/// `tray.rs` の `tray_menu_action_from_id`)。
#[derive(Debug, Clone, PartialEq, Eq)]
struct CaptureFileEntry {
    file_name: String,
    is_file: bool,
    is_symlink: bool,
}

/// [`CaptureFileEntry`] が削除対象(拡張子が`.png`〈大小無視〉の通常ファイル)か
/// どうかを判定する純粋関数(PJM追加指示)。
///
/// シンボリックリンクは無条件に対象外とする。`DirEntry::file_type()` は
/// (readdirが型情報を提供しない場合のフォールバックも含め)シンボリックリンクを
/// 辿らない(`lstat`相当)ため、ここで`is_symlink`を除外すれば「ディレクトリ外の
/// ファイルを辿って誤削除する」経路を作らずに済む。
fn is_deletable_capture_file(entry: &CaptureFileEntry) -> bool {
    entry.is_file
        && !entry.is_symlink
        && entry
            .file_name
            .rsplit_once('.')
            .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("png"))
}

/// `dir` 直下(非再帰)の削除対象ファイルパスを列挙する。
///
/// `dir` が存在しない場合は空を返す(初回起動等でキャプチャが一度も行われて
/// いないケース)。実ファイルシステムを読むため厳密な純粋関数ではないが、任意の
/// `dir` を受け取れるようにしてあるため、共有される [`capture_dir`] とは無関係な
/// 専用の一時ディレクトリを使ってテストできる(並行実行される他テストが
/// `capture_dir()` に生成するファイルと干渉しない)。
fn deletable_capture_file_paths(dir: &Path) -> Vec<PathBuf> {
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    read_dir
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let Ok(file_type) = entry.file_type() else {
                return false;
            };
            is_deletable_capture_file(&CaptureFileEntry {
                file_name: entry.file_name().to_string_lossy().into_owned(),
                is_file: file_type.is_file(),
                is_symlink: file_type.is_symlink(),
            })
        })
        .map(|entry| entry.path())
        .collect()
}

/// `dir` 直下の削除対象ファイルを実際に削除する。
///
/// 削除失敗(権限・競合等)はログのみ出力して処理を継続する(PJM追加指示
/// 「失敗はログのみで起動・終了を妨げない」)。
fn remove_capture_files_in(dir: &Path) {
    for path in deletable_capture_file_paths(dir) {
        if let Err(err) = std::fs::remove_file(&path) {
            eprintln!(
                "一時キャプチャファイルの削除に失敗しました({}): {err}",
                path.display()
            );
        }
    }
}

/// 起動時・終了時に一時キャプチャファイル([`capture_dir`] 配下の `*.png`)を
/// 削除する(PJM追加指示)。
///
/// `lib.rs::run()` から起動時(`setup`)・終了時(`RunEvent::Exit`)の両方で呼ぶ。
/// 表示中の画像はcanvas/履歴がメモリに保持しているため、ここでの削除はUIに
/// 影響しない(PJM追加指示の前提)。実削除ロジックは [`remove_capture_files_in`]
/// (テスト可能)を [`capture_dir`] に適用するだけの薄いラッパー。
pub fn cleanup_capture_files() {
    remove_capture_files_in(&capture_dir());
}

/// キャプチャ画像ファイルの読み出し要求を拒否した理由(実機不具合②〜⑤の修正)。
#[derive(Debug, thiserror::Error)]
pub enum CaptureFileAccessError {
    /// 正規化後のパスがキャプチャ専用ディレクトリ直下ではない(パストラバーサル・
    /// ディレクトリ外を指すシンボリックリンク・サブディレクトリ)。
    #[error("キャプチャ用ディレクトリ外のファイルは読み込めません")]
    OutsideCaptureDir,
    /// 拡張子が`.png`(大小無視)の通常ファイルではない。
    #[error("PNGファイル以外は読み込めません")]
    NotPng,
    /// ファイル・ディレクトリが存在しない等のI/Oエラー。
    #[error("キャプチャ画像を読み込めません: {0}")]
    Io(#[from] std::io::Error),
}

/// `requested`を正規化(`canonicalize`: シンボリックリンク・`..`を解決)し、`dir`
/// (同じく正規化)直下の`.png`通常ファイルである場合のみ正規化後のパスを返す。
///
/// フロントエンドから渡されたパスでファイルを読むため(`commands::read_capture_image`)、
/// 読み出し可能な範囲を自アプリのキャプチャ専用ディレクトリ直下に限定する。
/// `/var` → `/private/var` のようなシンボリックリンク差も、両辺を正規化してから
/// 比較するため問題にならない。任意の`dir`を受け取れるようにしてあるのは、共有される
/// [`capture_dir`]と無関係な一時ディレクトリでテストするため。
fn resolve_capture_file_in(
    dir: &Path,
    requested: &Path,
) -> Result<PathBuf, CaptureFileAccessError> {
    let canonical_dir = dir.canonicalize()?;
    let canonical = requested.canonicalize()?;
    if canonical.parent() != Some(canonical_dir.as_path()) {
        return Err(CaptureFileAccessError::OutsideCaptureDir);
    }
    let is_png = canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"));
    if !is_png || !canonical.is_file() {
        return Err(CaptureFileAccessError::NotPng);
    }
    Ok(canonical)
}

/// [`capture_dir`]直下のキャプチャ画像(PNG)のバイト列を読み込む。
///
/// パス検証は [`resolve_capture_file_in`] に委ねる。
pub fn read_capture_file(requested: &Path) -> Result<Vec<u8>, CaptureFileAccessError> {
    let path = resolve_capture_file_in(&capture_dir(), requested)?;
    Ok(std::fs::read(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn generate_capture_path_は連続n回呼び出しても重複しない() {
        let paths: Vec<PathBuf> = (0..500)
            .map(|_| generate_capture_path().expect("一時ディレクトリの作成に失敗した"))
            .collect();
        let unique: HashSet<&PathBuf> = paths.iter().collect();
        assert_eq!(unique.len(), paths.len(), "生成されたパスに重複がある");
    }

    #[test]
    fn generate_capture_path_は常に専用サブディレクトリ配下を返す() {
        let path = generate_capture_path().expect("一時ディレクトリの作成に失敗した");
        assert_eq!(path.parent(), Some(capture_dir().as_path()));
    }

    #[test]
    fn generate_capture_path_はpng拡張子を持つ() {
        let path = generate_capture_path().expect("一時ディレクトリの作成に失敗した");
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));
    }

    /// `capture_dir()` はcanonicalizeできる(`resolve_capture_file_in` が両辺を
    /// canonicalizeして比較する前提。T17のasset protocol scope動的登録は撤去済み)。
    ///
    /// macOSでは`$TMPDIR`(`capture_dir()`の実体)が`/var/folders/...`だが`/var`は
    /// `/private/var`へのシンボリックリンクであるため、canonicalizeすると
    /// `/private/var/folders/...`に変わりうる(実機確認済み)。この差の有無自体は
    /// 環境依存(Linux等では`/tmp`がシンボリックリンクでないことが多い)のため
    /// アサーションの対象にしないが、「ディレクトリを作成すれば必ずcanonicalizeでき、
    /// 末尾セグメントが保たれる」ことは全環境共通の前提として検証する。
    #[test]
    fn capture_dirは作成すればcanonicalizeできる() {
        let dir = capture_dir();
        std::fs::create_dir_all(&dir).expect("一時ディレクトリの作成に失敗した");
        let canonical = dir.canonicalize().expect("canonicalizeに失敗した");
        assert_eq!(canonical.file_name(), dir.file_name());
        assert_eq!(canonical.file_name().and_then(|n| n.to_str()), Some(CAPTURE_SUBDIR));
    }

    /// テスト専用の一意な一時ディレクトリパスを返す(`capture_dir()` とは別物にし、
    /// 並行実行される他テストとの干渉を避ける)。
    fn unique_test_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "tadcap-cleanup-test-{label}-{nanos}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn is_deletable_capture_file_はpng拡張子の通常ファイルを削除対象とする() {
        let entry = CaptureFileEntry {
            file_name: "capture-1-2-3.png".to_string(),
            is_file: true,
            is_symlink: false,
        };
        assert!(is_deletable_capture_file(&entry));
    }

    #[test]
    fn is_deletable_capture_file_は大文字拡張子のpngも対象とする() {
        let entry = CaptureFileEntry {
            file_name: "CAPTURE.PNG".to_string(),
            is_file: true,
            is_symlink: false,
        };
        assert!(is_deletable_capture_file(&entry));
    }

    #[test]
    fn is_deletable_capture_file_はpng以外の拡張子を対象外とする() {
        let entry = CaptureFileEntry {
            file_name: "note.txt".to_string(),
            is_file: true,
            is_symlink: false,
        };
        assert!(!is_deletable_capture_file(&entry));
    }

    #[test]
    fn is_deletable_capture_file_は拡張子なしのファイルを対象外とする() {
        let entry = CaptureFileEntry {
            file_name: "no-extension".to_string(),
            is_file: true,
            is_symlink: false,
        };
        assert!(!is_deletable_capture_file(&entry));
    }

    #[test]
    fn is_deletable_capture_file_はディレクトリを対象外とする() {
        let entry = CaptureFileEntry {
            file_name: "subdir.png".to_string(),
            is_file: false,
            is_symlink: false,
        };
        assert!(!is_deletable_capture_file(&entry));
    }

    #[test]
    fn is_deletable_capture_file_はシンボリックリンクを対象外とする() {
        // ディレクトリ外のファイルを指すリンクを辿って誤削除しないための安全策。
        let entry = CaptureFileEntry {
            file_name: "linked.png".to_string(),
            is_file: true,
            is_symlink: true,
        };
        assert!(!is_deletable_capture_file(&entry));
    }

    #[test]
    fn deletable_capture_file_pathsは存在しないディレクトリで空配列を返す() {
        let dir = unique_test_dir("missing");
        assert_eq!(deletable_capture_file_paths(&dir), Vec::<PathBuf>::new());
    }

    #[test]
    fn deletable_capture_file_pathsはpngファイルのみを列挙する() {
        let dir = unique_test_dir("list");
        std::fs::create_dir_all(&dir).expect("テスト用ディレクトリの作成に失敗した");

        let png_path = dir.join("capture-1.png");
        let txt_path = dir.join("note.txt");
        std::fs::write(&png_path, b"dummy").expect("pngの書き込みに失敗した");
        std::fs::write(&txt_path, b"dummy").expect("txtの書き込みに失敗した");

        assert_eq!(deletable_capture_file_paths(&dir), vec![png_path]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remove_capture_files_inは存在しないディレクトリでもパニックしない() {
        let dir = unique_test_dir("missing-remove");
        remove_capture_files_in(&dir);
    }

    #[test]
    fn remove_capture_files_inはpngファイルを削除しそれ以外は残す() {
        let dir = unique_test_dir("remove");
        std::fs::create_dir_all(&dir).expect("テスト用ディレクトリの作成に失敗した");

        let png_path = dir.join("capture-1.png");
        let txt_path = dir.join("note.txt");
        std::fs::write(&png_path, b"dummy").expect("pngの書き込みに失敗した");
        std::fs::write(&txt_path, b"dummy").expect("txtの書き込みに失敗した");

        remove_capture_files_in(&dir);

        assert!(!png_path.exists(), "pngは削除されるはず");
        assert!(txt_path.exists(), "png以外は残るはず");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// [`resolve_capture_file_in`](実機不具合②〜⑤の修正、画像バイトをIPCで返す経路)の
    /// パス検証テスト。専用ディレクトリ直下の`.png`通常ファイルだけを許可する。
    #[test]
    fn resolve_capture_file_in_は直下のpngファイルを許可し正規化パスを返す() {
        let dir = unique_test_dir("resolve-ok");
        std::fs::create_dir_all(&dir).expect("テスト用ディレクトリの作成に失敗した");
        let file = dir.join("capture-1-2-3.png");
        std::fs::write(&file, b"png").expect("ファイル作成に失敗した");

        let resolved = resolve_capture_file_in(&dir, &file).expect("許可されるはず");
        assert_eq!(resolved, file.canonicalize().expect("canonicalizeに失敗した"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_capture_file_in_は大文字拡張子のpngも許可する() {
        let dir = unique_test_dir("resolve-upper");
        std::fs::create_dir_all(&dir).expect("テスト用ディレクトリの作成に失敗した");
        let file = dir.join("capture.PNG");
        std::fs::write(&file, b"png").expect("ファイル作成に失敗した");

        assert!(resolve_capture_file_in(&dir, &file).is_ok());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_capture_file_in_は親ディレクトリへの相対指定を拒否する() {
        let base = unique_test_dir("resolve-traversal");
        let dir = base.join("captures");
        std::fs::create_dir_all(&dir).expect("テスト用ディレクトリの作成に失敗した");
        let outside = base.join("secret.png");
        std::fs::write(&outside, b"png").expect("ファイル作成に失敗した");

        let err = resolve_capture_file_in(&dir, &dir.join("../secret.png"))
            .expect_err("ディレクトリ外は拒否されるはず");
        assert!(matches!(err, CaptureFileAccessError::OutsideCaptureDir));

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn resolve_capture_file_in_はサブディレクトリ配下を拒否する() {
        let dir = unique_test_dir("resolve-subdir");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).expect("テスト用ディレクトリの作成に失敗した");
        let file = sub.join("x.png");
        std::fs::write(&file, b"png").expect("ファイル作成に失敗した");

        let err = resolve_capture_file_in(&dir, &file).expect_err("直下以外は拒否されるはず");
        assert!(matches!(err, CaptureFileAccessError::OutsideCaptureDir));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_capture_file_in_はpng以外の拡張子を拒否する() {
        let dir = unique_test_dir("resolve-ext");
        std::fs::create_dir_all(&dir).expect("テスト用ディレクトリの作成に失敗した");
        let file = dir.join("note.txt");
        std::fs::write(&file, b"text").expect("ファイル作成に失敗した");

        let err = resolve_capture_file_in(&dir, &file).expect_err("png以外は拒否されるはず");
        assert!(matches!(err, CaptureFileAccessError::NotPng));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_capture_file_in_は存在しないファイルをioエラーにする() {
        let dir = unique_test_dir("resolve-missing");
        std::fs::create_dir_all(&dir).expect("テスト用ディレクトリの作成に失敗した");

        let err = resolve_capture_file_in(&dir, &dir.join("missing.png"))
            .expect_err("存在しないファイルは拒否されるはず");
        assert!(matches!(err, CaptureFileAccessError::Io(_)));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_capture_file_in_はpng名のディレクトリを拒否する() {
        let dir = unique_test_dir("resolve-dir");
        let fake = dir.join("fake.png");
        std::fs::create_dir_all(&fake).expect("テスト用ディレクトリの作成に失敗した");

        let err = resolve_capture_file_in(&dir, &fake).expect_err("ディレクトリは拒否されるはず");
        assert!(matches!(err, CaptureFileAccessError::NotPng));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn resolve_capture_file_in_はディレクトリ外を指すシンボリックリンクを拒否する() {
        let dir = unique_test_dir("resolve-symlink");
        std::fs::create_dir_all(&dir).expect("テスト用ディレクトリの作成に失敗した");
        let outside_target = unique_test_dir("resolve-symlink-target");
        std::fs::write(&outside_target, b"secret").expect("リンク先の作成に失敗した");
        let link_path = dir.join("linked.png");
        std::os::unix::fs::symlink(&outside_target, &link_path)
            .expect("シンボリックリンクの作成に失敗した");

        let err = resolve_capture_file_in(&dir, &link_path)
            .expect_err("リンク先がディレクトリ外なら拒否されるはず");
        assert!(matches!(err, CaptureFileAccessError::OutsideCaptureDir));

        std::fs::remove_file(&outside_target).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn remove_capture_files_inはシンボリックリンクを辿らず残す() {
        let dir = unique_test_dir("symlink");
        std::fs::create_dir_all(&dir).expect("テスト用ディレクトリの作成に失敗した");

        // ディレクトリ外の実ファイル(誤って消えると困る想定)を指すシンボリックリンク。
        let outside_target = unique_test_dir("symlink-target");
        std::fs::write(&outside_target, b"dummy").expect("リンク先の作成に失敗した");
        let link_path = dir.join("linked.png");
        std::os::unix::fs::symlink(&outside_target, &link_path)
            .expect("シンボリックリンクの作成に失敗した");

        remove_capture_files_in(&dir);

        assert!(link_path.exists(), "シンボリックリンク自体は削除しない");
        assert!(outside_target.exists(), "リンク先の実ファイルは削除しない");

        std::fs::remove_file(&link_path).ok();
        std::fs::remove_file(&outside_target).ok();
        std::fs::remove_dir_all(&dir).ok();
    }
}
