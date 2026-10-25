//! `screencapture -i <dest>` を起動する [`CaptureProvider`] 実装(T05)。
//!
//! MVP で唯一有効化するキャプチャ方式(PRD §7 決定ログ#2 B案、ARCH §1.3 決定#2)。
//! `screencapture -i` はEscキャンセル時も終了コード0で終わり、かつファイルを
//! 生成しないため、`Completed` / `Cancelled` は `dest` の存在有無で判定する(ARCH §7.1)。
//! 終了コードは「非 0 かつファイル無し」を撮影の失敗(`io::Error`)として区別するためだけに使う
//! (権限確認は通ったのに撮影に失敗したケースを「何も起きない」と見せないため。
//! エラーには終了コードだけを載せ、stderr の内容は含めない)。

use std::path::Path;
use std::process::{Command, ExitStatus};

use super::{CaptureOutcome, CaptureProvider};

/// `screencapture` の絶対パス。PATH 検索にすると端末から起動したとき PATH 先頭の同名ファイルに
/// 差し替えられうるため、固定パスで起動する(PRD FR-001 の固定パス上書き防止と同じ方針)。
const SCREENCAPTURE_PATH: &str = "/usr/sbin/screencapture";

/// `screencapture -i` を起動する [`CaptureProvider`] 実装(ARCH §5.1)。
pub struct ScreenCaptureCli;

impl CaptureProvider for ScreenCaptureCli {
    fn capture(&self, dest: &Path, on_spawn: &mut dyn FnMut()) -> std::io::Result<CaptureOutcome> {
        // プロセス起動自体が失敗した場合(コマンド未検出等)は `?` でエラーを伝播する。
        // 終了後の判定(Esc キャンセル / 成功 / 撮影失敗)は `outcome_for` に任せる。
        //
        // `spawn()` でプロセスを起動した直後(ユーザーの選択操作が終わるのを
        // 待つ前)に `on_spawn()` を呼ぶ(NFR-001中間計測、T11)。OS標準の選択UI
        // が実際に画面へ表示された瞬間そのものではなく近似値である(`capture`
        // モジュールの `CaptureProvider::capture` docコメント参照)。
        let mut child = Command::new(SCREENCAPTURE_PATH).arg("-i").arg(dest).spawn()?;
        on_spawn();
        let status = child.wait()?;
        outcome_for(status, dest)
    }
}

/// `screencapture` プロセス終了後、終了コードと `dest` の存在有無から結果を判定する純粋関数。
/// 実プロセスを起動せずにテストできるよう `ScreenCaptureCli::capture` から切り出した。
///
/// | 終了コード | `dest` | 結果 |
/// | --- | --- | --- |
/// | 0 | 有り | `Completed` |
/// | 0 | 無し | `Cancelled`(Esc キャンセル、ARCH §7.1) |
/// | 非 0 | 有り | `Completed`(ファイルがあるなら使う) |
/// | 非 0 | 無し | `Err`(撮影の失敗。終了コードだけを載せる) |
fn outcome_for(status: ExitStatus, dest: &Path) -> std::io::Result<CaptureOutcome> {
    if dest.exists() {
        return Ok(CaptureOutcome::Completed);
    }
    if status.success() {
        return Ok(CaptureOutcome::Cancelled);
    }
    // シグナルで終了したときは `code()` が `None`
    let code = status.code().map_or_else(|| "なし".to_string(), |c| c.to_string());
    Err(std::io::Error::other(format!("screencapture が失敗しました(終了コード: {code})")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::process::ExitStatusExt;

    fn unique_test_path(name: &str) -> std::path::PathBuf {
        // 各テストで衝突しないよう呼び出しごとに専用のファイル名にする。
        std::env::temp_dir().join(format!(
            "tadcap-screencapture-test-{}-{}.png",
            std::process::id(),
            name
        ))
    }

    /// `wait(2)` の生の終了ステータス(終了コードは上位バイト)から `ExitStatus` を作る。
    fn exit_status(code: i32) -> ExitStatus {
        ExitStatus::from_raw(code << 8)
    }

    #[test]
    fn outcome_for_は終了コード0でファイルが生成されていればcompletedを返す() {
        let path = unique_test_path("completed");
        fs::write(&path, b"fake-png-bytes").expect("テスト用ファイルの書き込みに失敗した");

        let outcome = outcome_for(exit_status(0), &path);

        let _ = fs::remove_file(&path);
        assert_eq!(outcome.expect("成功のはず"), CaptureOutcome::Completed);
    }

    #[test]
    fn outcome_for_は終了コード0でファイル未生成ならcancelledを返す() {
        let path = unique_test_path("cancelled");
        let _ = fs::remove_file(&path); // 念のため存在しないことを保証する

        let outcome = outcome_for(exit_status(0), &path);

        assert_eq!(outcome.expect("Esc キャンセルは失敗ではないはず"), CaptureOutcome::Cancelled);
    }

    #[test]
    fn outcome_for_は終了コード非0でファイル未生成なら終了コードだけを載せたioエラーにする() {
        let path = unique_test_path("failed");
        let _ = fs::remove_file(&path);

        let err = outcome_for(exit_status(1), &path).expect_err("撮影の失敗はエラーのはず");

        assert_eq!(err.kind(), std::io::ErrorKind::Other);
        assert_eq!(err.to_string(), "screencapture が失敗しました(終了コード: 1)");
    }

    #[test]
    fn outcome_for_はシグナルで終了しファイル未生成なら終了コードなしのioエラーにする() {
        let path = unique_test_path("killed");
        let _ = fs::remove_file(&path);

        // 下位バイトがシグナル番号(9 = SIGKILL)。`code()` は `None` になる
        let err = outcome_for(ExitStatus::from_raw(9), &path).expect_err("シグナル終了はエラーのはず");

        assert_eq!(err.to_string(), "screencapture が失敗しました(終了コード: なし)");
    }

    #[test]
    fn outcome_for_は終了コード非0でもファイルがあればcompletedを返す() {
        let path = unique_test_path("completed-nonzero");
        fs::write(&path, b"fake-png-bytes").expect("テスト用ファイルの書き込みに失敗した");

        let outcome = outcome_for(exit_status(1), &path);

        let _ = fs::remove_file(&path);
        assert_eq!(outcome.expect("ファイルがあるなら使うはず"), CaptureOutcome::Completed);
    }

    #[test]
    fn screencaptureは絶対パスで起動する() {
        assert_eq!(SCREENCAPTURE_PATH, "/usr/sbin/screencapture");
        assert!(Path::new(SCREENCAPTURE_PATH).is_absolute());
    }
}
