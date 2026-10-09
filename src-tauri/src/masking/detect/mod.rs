//! 4 種の検出器を回して `Match`(行・UTF-16 範囲・種類・細分)を集める(ARCH_auto-masking §5.3)。
//! 入力は `RecognizedPage` 越しの行の文字列と位置だけで、`ocr`・`objc2` 系には依存しない。
//! `run()` と検出器の登録口は AM-T11 で実装する。

mod contact;
mod credential;
mod financial;
mod identifier;
mod lexicon;
