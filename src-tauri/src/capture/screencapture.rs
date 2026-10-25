//! `screencapture -i <dest>` を起動する [`CaptureProvider`] 実装(T05)。
//!
//! MVP で唯一有効化するキャプチャ方式(PRD §7 決定ログ#2 B案、ARCH §1.3 決定#2)。
//! `screencapture -i` は Esc キャンセル時にファイルを生成しないため、`Completed` / `Cancelled` は
//! `dest` の存在有無で判定する(ARCH §7.1)。撮影の失敗(権限確認は通ったのに撮影できなかった)を
//! 「何も起きない」と見せないよう、「ファイル無し + 非 0 終了 + stderr に出力あり」だけを
//! `io::Error` にする(エラーには終了コードだけを載せ、stderr の内容は含めない・ログにも出さない)。
//!
//! 【仮定】Esc キャンセル時の終了コードは実機未確認(ARCH §7.1 の「0 で終わる」は記述のみ)。
//! 0 でも非 0 でも、stderr に何も出ていなければキャンセルと扱う(終了コードに依存しない判定)。

use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};

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
        // stderr だけをパイプで回収する(判定に「何か出ているか」を使う。stdout は従来どおり継承)。
        //
        // `spawn()` でプロセスを起動した直後(ユーザーの選択操作が終わるのを
        // 待つ前)に `on_spawn()` を呼ぶ(NFR-001中間計測、T11)。OS標準の選択UI
        // が実際に画面へ表示された瞬間そのものではなく近似値である(`capture`
        // モジュールの `CaptureProvider::capture` docコメント参照)。
        let child = Command::new(SCREENCAPTURE_PATH)
            .arg("-i")
            .arg(dest)
            .stderr(Stdio::piped())
            .spawn()?;
        on_spawn();
        let output = child.wait_with_output()?;
        // stderr は親に継承しなくなったので、デバッグビルドだけ行数(内容ではない)を知らせる
        if cfg!(debug_assertions) && !output.stderr.is_empty() {
            eprintln!(
                "[tadcap:capture] screencapture stderr_lines={}",
                stderr_line_count(&output.stderr)
            );
        }
        outcome_for(output.status, stderr_is_blank(&output.stderr), dest)
    }
}

/// stderr が空か、空白(改行含む)だけかを判定する純粋関数。
fn stderr_is_blank(stderr: &[u8]) -> bool {
    stderr.iter().all(u8::is_ascii_whitespace)
}

/// stderr の空でない行数を数える純粋関数(デバッグビルドのログ用。内容は扱わない)。
fn stderr_line_count(stderr: &[u8]) -> usize {
    stderr
        .split(|b| *b == b'\n')
        .filter(|line| !stderr_is_blank(line))
        .count()
}

/// `screencapture` プロセス終了後、`dest` の存在有無・終了コード・stderr の有無から結果を判定する
/// 純粋関数。実プロセスを起動せずにテストできるよう `ScreenCaptureCli::capture` から切り出した。
///
/// | `dest` | 終了コード | stderr | 結果 |
/// | --- | --- | --- | --- |
/// | 有り | 問わない | 問わない | `Completed`(ファイルがあるなら使う) |
/// | 無し | 0 | 問わない | `Cancelled`(Esc キャンセル、ARCH §7.1) |
/// | 無し | 非 0 | 空(空白だけ) | `Cancelled`(Esc が非 0 を返す環境でも失敗にしない) |
/// | 無し | 非 0 | 出力あり | `Err`(撮影の失敗。終了コードだけを載せる) |
///
/// 【仮定】Esc の終了コードは実機未確認。0 でも非 0 でも、stderr が無ければキャンセルと扱う。
fn outcome_for(status: ExitStatus, stderr_is_blank: bool, dest: &Path) -> std::io::Result<CaptureOutcome> {
    if dest.exists() {
        return Ok(CaptureOutcome::Completed);
    }
    if status.success() || stderr_is_blank {
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

    /// stderr に出力がある(= `stderr_is_blank` が false)。
    const STDERR_OUTPUT: bool = false;
    /// stderr が空(空白だけ)。
    const STDERR_BLANK: bool = true;

    #[test]
    fn outcome_for_は終了コード0でファイルが生成されていればcompletedを返す() {
        let path = unique_test_path("completed");
        fs::write(&path, b"fake-png-bytes").expect("テスト用ファイルの書き込みに失敗した");

        let outcome = outcome_for(exit_status(0), STDERR_BLANK, &path);

        let _ = fs::remove_file(&path);
        assert_eq!(outcome.expect("成功のはず"), CaptureOutcome::Completed);
    }

    #[test]
    fn outcome_for_は終了コード0でファイル未生成ならstderrの有無を問わずcancelledを返す() {
        let path = unique_test_path("cancelled");
        let _ = fs::remove_file(&path); // 念のため存在しないことを保証する

        for stderr_is_blank in [STDERR_BLANK, STDERR_OUTPUT] {
            let outcome = outcome_for(exit_status(0), stderr_is_blank, &path);
            assert_eq!(outcome.expect("Esc キャンセルは失敗ではないはず"), CaptureOutcome::Cancelled);
        }
    }

    /// 【仮定】Esc の終了コードが非 0 の macOS があっても、stderr に何も出ていなければキャンセル。
    #[test]
    fn outcome_for_は終了コード非0でもstderrが空でファイル未生成ならcancelledを返す() {
        let path = unique_test_path("cancelled-nonzero");
        let _ = fs::remove_file(&path);

        let outcome = outcome_for(exit_status(1), STDERR_BLANK, &path);

        assert_eq!(outcome.expect("stderr が空なら失敗にしないはず"), CaptureOutcome::Cancelled);
    }

    #[test]
    fn outcome_for_は終了コード非0でstderrに出力がありファイル未生成なら終了コードだけを載せたioエラーにする() {
        let path = unique_test_path("failed");
        let _ = fs::remove_file(&path);

        let err = outcome_for(exit_status(1), STDERR_OUTPUT, &path).expect_err("撮影の失敗はエラーのはず");

        assert_eq!(err.kind(), std::io::ErrorKind::Other);
        assert_eq!(err.to_string(), "screencapture が失敗しました(終了コード: 1)");
    }

    #[test]
    fn outcome_for_はシグナルで終了しstderrに出力がありファイル未生成なら終了コードなしのioエラーにする() {
        let path = unique_test_path("killed");
        let _ = fs::remove_file(&path);

        // 下位バイトがシグナル番号(9 = SIGKILL)。`code()` は `None` になる
        let err = outcome_for(ExitStatus::from_raw(9), STDERR_OUTPUT, &path)
            .expect_err("シグナル終了はエラーのはず");

        assert_eq!(err.to_string(), "screencapture が失敗しました(終了コード: なし)");
    }

    #[test]
    fn outcome_for_は終了コード非0でstderrに出力があってもファイルがあればcompletedを返す() {
        let path = unique_test_path("completed-nonzero");
        fs::write(&path, b"fake-png-bytes").expect("テスト用ファイルの書き込みに失敗した");

        let outcome = outcome_for(exit_status(1), STDERR_OUTPUT, &path);

        let _ = fs::remove_file(&path);
        assert_eq!(outcome.expect("ファイルがあるなら使うはず"), CaptureOutcome::Completed);
    }

    #[test]
    fn stderr_is_blank_は空と空白だけをtrueにし出力があればfalseにする() {
        assert!(stderr_is_blank(b""));
        assert!(stderr_is_blank(b"\n"));
        assert!(stderr_is_blank(b" \t\r\n"));
        assert!(!stderr_is_blank(b"could not create image from display\n"));
    }

    #[test]
    fn stderr_line_count_は空でない行だけを数える() {
        assert_eq!(stderr_line_count(b""), 0);
        assert_eq!(stderr_line_count(b"\n\n"), 0);
        assert_eq!(stderr_line_count(b"one line\n"), 1);
        assert_eq!(stderr_line_count(b"first\n\nsecond"), 2);
    }

    #[test]
    fn screencaptureは絶対パスで起動する() {
        assert_eq!(SCREENCAPTURE_PATH, "/usr/sbin/screencapture");
        assert!(Path::new(SCREENCAPTURE_PATH).is_absolute());
    }
}
