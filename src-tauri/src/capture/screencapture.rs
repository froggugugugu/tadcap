//! `screencapture -i <dest>` を起動する [`CaptureProvider`] 実装(T05)。
//!
//! MVP で唯一有効化するキャプチャ方式(PRD §7 決定ログ#2 B案、ARCH §1.3 決定#2)。
//! `screencapture -i` はEscキャンセル時も終了コード0で終わり、かつファイルを
//! 生成しないため、終了コードではなく `dest` の存在有無で `Completed` /
//! `Cancelled` を判定する(ARCH §7.1)。

use std::path::Path;
use std::process::Command;

use super::{CaptureOutcome, CaptureProvider};

/// `screencapture -i` を起動する [`CaptureProvider`] 実装(ARCH §5.1)。
pub struct ScreenCaptureCli;

impl CaptureProvider for ScreenCaptureCli {
    fn capture(&self, dest: &Path, on_spawn: &mut dyn FnMut()) -> std::io::Result<CaptureOutcome> {
        // 終了コードは判定に使わない(Escキャンセルも0で終了するため、ARCH §7.1)。
        // プロセス起動自体が失敗した場合(コマンド未検出等)のみ `?` でエラーを
        // 伝播する。
        //
        // `spawn()` でプロセスを起動した直後(ユーザーの選択操作が終わるのを
        // 待つ前)に `on_spawn()` を呼ぶ(NFR-001中間計測、T11)。OS標準の選択UI
        // が実際に画面へ表示された瞬間そのものではなく近似値である(`capture`
        // モジュールの `CaptureProvider::capture` docコメント参照)。
        let mut child = Command::new("screencapture").arg("-i").arg(dest).spawn()?;
        on_spawn();
        child.wait()?;
        Ok(outcome_for(dest))
    }
}

/// `screencapture` プロセス終了後、`dest` の存在有無から結果を判定する純粋関数
/// (Escキャンセル時はファイル未生成のため `Cancelled`、ARCH §7.1)。実プロセスを
/// 起動せずにテストできるよう `ScreenCaptureCli::capture` から切り出した。
fn outcome_for(dest: &Path) -> CaptureOutcome {
    if dest.exists() {
        CaptureOutcome::Completed
    } else {
        CaptureOutcome::Cancelled
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_test_path(name: &str) -> std::path::PathBuf {
        // 各テストで衝突しないよう呼び出しごとに専用のファイル名にする。
        std::env::temp_dir().join(format!(
            "tadcap-screencapture-test-{}-{}.png",
            std::process::id(),
            name
        ))
    }

    #[test]
    fn outcome_for_はファイルが生成されていればcompletedを返す() {
        let path = unique_test_path("completed");
        fs::write(&path, b"fake-png-bytes").expect("テスト用ファイルの書き込みに失敗した");

        let outcome = outcome_for(&path);

        let _ = fs::remove_file(&path);
        assert_eq!(outcome, CaptureOutcome::Completed);
    }

    #[test]
    fn outcome_for_はファイル未生成ならcancelledを返す() {
        let path = unique_test_path("cancelled");
        let _ = fs::remove_file(&path); // 念のため存在しないことを保証する

        let outcome = outcome_for(&path);

        assert_eq!(outcome, CaptureOutcome::Cancelled);
    }
}
