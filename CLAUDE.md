# CLAUDE.md

## プロジェクト
Tadcap: macOS専用、キャプチャ主役のスクリーンショットツール（Tauri v2）。

## ルール
- 要件は docs/requirements.md を正とする。変更時は先に要件を更新する
- Rust側（src-tauri）: キャプチャ・OS連携。フロント（src）: UIのみ
- OS依存処理は src-tauri/src/capture/ に閉じ込める
- コミット前に `cargo fmt` / `cargo clippy` / `npm run build` を通す
