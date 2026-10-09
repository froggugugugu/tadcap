# セキュリティ確認レポート: 機密情報の自動マスキング(AM-T25)

## 免責事項

本スキャンは自動化ツールに基づく参考情報であり、セキュリティ専門家によるペネトレーションテストの代替ではない。重要なシステムでは必ず専門家のレビューを受けること。

## スキャン概要

| 項目 | 内容 |
| ---- | ---- |
| 実施日 | 2026-10-09 |
| 対象範囲 | `git diff 02837e4..HEAD` のうち自動マスキング関連: `src-tauri/src/masking/**`、`src-tauri/src/commands.rs`(`scan_sensitive_text` と周辺)、`src-tauri/src/error.rs`、`src-tauri/src/lib.rs`、`src/ui/autoMask.ts`、`src/ui/maskOverlay.ts`、`src/canvas/maskSession.ts`、`src/ipc/textScan.ts`、`src/canvas/documentState.ts`(`applyBaseEdits`)、`e2e/fixtures/tauriMock.ts`、`e2e/auto-mask.spec.ts`、`eval/masking/**`、`src-tauri/Cargo.toml`・`Cargo.lock` |
| 根拠 | `output/design/ARCH_auto-masking.md` §12、`output/tasks/TASK_auto-masking.md` AM-T25 |
| 方法 | SAST(手動のコードレビュー + パターン検索)、シークレット形の検索。DAST は対象外(デスクトップアプリで HTTP の面が無い) |
| 使用したツール | Claude Code のファイル読み取り・`Grep`(内部は ripgrep。版は表示されない)・`Glob` のみ。**この実行環境にはシェル・ネットワーク接続が無い**ため、`git diff`・`cargo`・`npm audit`・OSV 照会・`shasum` は実行していない(下記「未確認」) |
| ソースの変更 | なし(本レポートのみ作成) |
| 行番号について | 別の担当が `src/ui/autoMask.ts`・`src/canvas/documentState.ts`・`src-tauri/src/commands.rs` などをレビュー指摘の修正で編集中のため、これらのファイルの指摘は**関数名**で示す |

## エグゼクティブサマリー

| 重大度 | 件数 |
| ------ | ---- |
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 3 |
| Info | 5 |

読み取った文字列は IPC 応答・エラー文字列・ログ・ファイルに出ない作りになっている。`SensitiveText`、固定のエラー文字列、矩形と種類だけを返す応答、TS 側でキーが 5 つちょうどかの検証、の 4 つで守っている。`unsafe` は 3 か所で、すべて前提コメントがあり、Objective-C の例外の捕捉と `autoreleasepool` も設計どおりだった。XSS の経路は見つからなかった。

残る主なリスクは Medium 1 件。Rust の文字列スライスでパニックすると、標準のパニック表示が**読み取った文字列の一部を標準エラーに出す**(ARCH §12 の「パニック文言に文字列を入れない」が仕組みで守られていない)。読んだ範囲では実際にパニックを起こす箇所は見つかっておらず、潜在的なリスクである。

確認項目 6(権限の差分)・7(依存の脆弱性の再照会)・10(辞書の SHA-256)は、この環境ではコマンドを実行できず**未確認**。代わりの証拠は載せたが、人間による実行が必要。

## 検出事項

### Critical

検出なし(スキャン範囲内)

### High

検出なし(スキャン範囲内)

### Medium

- [ ] **[MEDIUM]** `src-tauri/src/masking/detect/*.rs`(`identifier.rs` の `company_name_before`・`company_value`・`name_before`・`name_value`・`japanese_name_after`・`repeated_names`・`surname_names`、`contact.rs`・`credential.rs`・`financial.rs` の同種の関数)。読み取った文字列(`SensitiveText::as_str()` の戻り値)を `&text[a..b]` で直接スライスしている箇所が多い。境界の計算に 1 つでも誤りがあると Rust の標準パニック(`byte index N is not a char boundary; it is inside '…' of `…``)が**対象の文字列(最大 256 バイト程度)を含む文言**を標準エラーに出す。リリースビルドは `panic = "abort"`(`Cargo.toml` の `[profile.release]`)で、パニックの文言を出したあとアプリ全体が終了する。パニックフック(`std::panic::set_hook`)はリポジトリ内に無い(`Grep set_hook|take_hook|catch_unwind` で 0 件)。
  **CVE/CWE**: CWE-209(エラーメッセージによる情報露出)/ CWE-532(ログへの機密情報の記録)/ CWE-248(捕捉されない例外)。
  **影響**: 境界計算のバグと、標準エラーを見られる状況(`tauri dev`・ターミナルからの起動・ログの収集)が重なると、画面上の機密らしい文字列が標準エラーに出る。加えて編集中のアプリが終了し、未コピーの編集が失われる。ARCH §12 の要件(パニック文言に文字列を入れない)が、個々の実装の正しさだけに頼っている。
  **修正案**: (1) `lib.rs` の `run()` の先頭で、パニックの内容(payload)を出さず位置(`file:line`)だけを出すフックを入れる。例: `std::panic::set_hook(Box::new(|info| { if let Some(l) = info.location() { eprintln!("[tadcap:panic] at {}:{}", l.file(), l.line()); } }));`。アプリ全体に効くので最も確実。(2) 加えて、検出側のスライスを `text.get(a..b)?` に置き換えるか、境界の性質テスト(任意の UTF-8 の行で `detect::run` がパニックしない)を追加する。
  **修正難易度**: 低((1))/ 中((2))。
  **偽陽性の可能性**: あり。読んだ範囲(`identifier.rs` の上記関数)の境界は、正規表現の一致位置・`char_indices`・`len_utf8`・ASCII の空白の直後(`+1`)から作られていて、パニックを起こす入力は見つからなかった。ただし全関数を網羅的には検証していない。

### Low

- [ ] **[LOW]** `src-tauri/src/commands.rs` の `scan_sensitive_text` / `run_text_scan`。Vision の呼び出し(`masking::ocr::recognize` → `performRequests`)に時間の上限が無い。Vision が戻らない場合は `TextScanGuard` が捨てられず、`TEXT_SCAN_IN_PROGRESS` が立ったままになる。そのため以後の読み取りがすべて `text_scan_busy` になる。フロントは `createAutoMaskController` の `inFlight` で前の完了を待つので、2 回目以降は処理中の表示のまま止まる。
  **CVE/CWE**: CWE-400(リソースの制御されない消費)/ CWE-833(デッドロック相当の待ち)。
  **影響**: 自動マスキングの機能だけが再起動まで使えなくなる。データの漏えいは無い。発生にはOS側の不具合が要る。
  **修正案**: フロント側で `scanSensitiveText` に時間の上限(例: 30 秒)を付け、超えたら `failScan(token)` で `idle` に戻して失敗のトーストを出す。Rust 側のフラグは処理が終わるまで下ろさない(現状どおり。二重実行の防止を保つ)。
  **修正難易度**: 低。
  **偽陽性の可能性**: あり(Vision が戻らない事象は観測していない)。

- [ ] **[LOW]** 実在の金融機関名が評価データと検出規則のコメントにある。`eval/masking/holdout2/pages/portal.html`(118 行目付近、銀行名 + 記号・番号の形の数字)、`eval/masking/holdout3/pages/rental.html`(118 行目付近、略称 + 記号・番号)、`src-tauri/src/masking/detect/financial.rs` のモジュールコメント・`ACCOUNT` 系の定数のコメント・テスト名(郵便貯金系の銀行の固有名)。
  **CVE/CWE**: 該当なし(確認項目 8 の方針「実在の会社を書かない・他社名を書かない」に反する)。
  **影響**: 公開リポジトリに実在の会社名と、その会社の口座番号の形をした数字の組が載る。数字は乱数だが、実在の口座と偶然一致する可能性は否定できない。
  **修正案**: 評価ページでは架空の銀行名(例: 「みなと台信用金庫」)にする。数字は形の規則(記号 1NNN0・番号の末尾 1)を保ったまま、`10000-00000001` のように明らかに架空と分かる値にする。コードのコメント・テスト名は「記号・番号形式(5 桁 - 6〜8 桁)の口座」のような一般的な表現にする。評価画像を作り直したときは `truth.json` も更新する(ホールドアウトの再計測が要るかは人間が判断する)。
  **修正難易度**: 低〜中(画像の再生成を伴う)。
  **偽陽性の可能性**: なし(固有名の記載そのもの)。

- [ ] **[LOW]** `eval/masking/pages/fixture.js` の `PREFIXES` とそのコメント・`genToken`。本体の文字種の名前に他社のサービス名(チャットサービス名の小文字)を使っている(コメントの説明・配列の要素・`genToken` の分岐の 3 か所)。同じファイルの「サービス名は書かない」という方針と食い違う。
  **CVE/CWE**: 該当なし(製品名の記載の方針)。
  **影響**: 公開リポジトリに他社製品名が載る。機能・安全性への影響は無い。
  **修正案**: 文字種の名前を `"digits-digits-alnum"` などの形の説明に変える(3 か所)。生成される値は変わらないので、評価画像の作り直しは不要。
  **修正難易度**: 低。
  **偽陽性の可能性**: なし。

### Info

- [ ] **[INFO]** `src-tauri/src/masking/png.rs` の `MAX_DIMENSION`(16,384)・`MAX_PNG_BYTES`(128MB)。上限ちょうどの画像を Vision が展開すると、RGBA で約 1GiB を使いうる。また `commands.rs` の `scan_sensitive_text` は本文を `to_vec()` で複製してから二重実行の判定をするので、一時的に本文 2 つ分のメモリを使う。入力は自分の webview がベース画像から作る PNG だけで、外部から送れる面は無い。
  **CVE/CWE**: CWE-770(上限の無い割り当て)— 上限はあるが値が大きい。
  **影響**: 巨大な画像で読み取ると一時的にメモリを大きく使う。
  **修正案**: 当面は現状でよい。必要になれば、画素数の上限(例: 幅 × 高さ ≤ 8,000 万)を足すか、`png_from_body` の後・複製の前に `begin_text_scan` を置く。
  **修正難易度**: 低。
  **偽陽性の可能性**: なし(実害は小さい)。

- [ ] **[INFO]** 正規表現の ReDoS: 検出規則は `regex` クレート 1.13.1(`Cargo.lock`)だけを使っていて、後方参照・先読みが無く入力長に対して線形時間で動く(このクレートの設計上の保証)。正規表現以外の走査には、行の長さの 2 乗に比例するものがある。たとえば `identifier.rs` の `names_before_honorifics` は文字の位置ごとに `name_before` を呼び、その中で `text[..end].char_indices()` を集める。`repeated_names` は行・キー・位置の 3 重のループになっている。行は Vision の 1 観測で、画像幅 ≤ 16,384px に収まるので、実用上の問題は見えない。
  **CVE/CWE**: CWE-1333(正規表現)は該当なし / CWE-407(非効率なアルゴリズム)の候補。
  **影響**: 文字だらけの巨大な画像で処理が遅くなりうる。
  **修正案**: AM-T24 の実測(フル HD で 3 秒以内)で問題が無ければ対応不要。必要なら `name_before` に渡す前に `end` から `MAX_NAME_CHARS` 文字分だけを切り出す。
  **修正難易度**: 低。
  **偽陽性の可能性**: あり(計測していない)。

- [ ] **[INFO]** `src-tauri/src/masking/detect/lexicon.rs` の `TOKEN_PREFIXES` などの文字列リテラル。接頭辞の中にサービスを識別できる綴り(例: コード管理サービスの個人トークンの接頭辞)がある。検出に必要なデータで、コメントには製品名を書いていない。トークンの本体はテスト(`credential.rs` の `mixed`・`letters`)と評価ページ(`fixture.js` の `genToken`)が実行時に作り、ソースに完全な形は無い。
  **CVE/CWE**: 該当なし。
  **影響**: 無し(方針上の注記)。
  **修正案**: 現状維持。README などで機能を説明するとき(AM-T26)に、接頭辞の由来のサービス名を書かない。
  **修正難易度**: -。
  **偽陽性の可能性**: -。

- [ ] **[INFO]** `e2e/auto-mask.spec.ts`。一括モザイクの焼き込みは、Canvas の画素の比較(「一連の流れ」のテストで、候補の内側の全画素が変わり外側は不変)と、⌘Z/⇧⌘Z で確かめている。印が ⌘C の画像に写らないことは別のテスト(「印を出したまま ⌘C」、`equalsCanvas` と白い画素 0)で確かめている。一方、**一括モザイクの後に ⌘C した画像にモザイクが入っていること**を直接確かめる e2e テストは無い(コピーは表示 Canvas を読むので、2 つのテストを合わせれば間接的に成り立つ)。
  **CVE/CWE**: 該当なし(テストの網羅性)。
  **影響**: 将来コピーの経路が Canvas 以外を読むように変わったとき、回帰を検出できない。
  **修正案**: 「一連の流れ」のテストの `apply.click()` の後で `Meta+C` を押し、`getClipboardImageStats(...).equalsCanvas === true` を足す。
  **修正難易度**: 低。
  **偽陽性の可能性**: -。

- [ ] **[INFO]** `src/canvas/documentState.ts` の `applyBaseEdits`。取り消し用に元の画素(`surface.read(rect)`)をメモリ上の履歴に持つ。⌘Z で元に戻せるのは仕様(FR-011)で、ファイル・ストレージには書かない。一括モザイクの後に誤って ⌘Z してからコピーすると、元の画素が出る。
  **CVE/CWE**: 該当なし(仕様上の注意)。
  **影響**: 利用者の操作次第。完了のトースト「⌘Z で戻せます」で明示されている。
  **修正案**: 対応不要。
  **修正難易度**: -。
  **偽陽性の可能性**: -。

## 確認項目ごとの結果

### 1. 読み取った文字列が IPC 応答・ログ・パニック/expect の文言・エラー文字列・ファイルに出ない — ✅(Medium 1 件の潜在リスクあり)

| 観点 | 結果 | 根拠 |
| ---- | ---- | ---- |
| 文字列の型 | ✅ | `masking/text.rs` の `SensitiveText`: `Debug` は `SensitiveText(<redacted>)`、`Display` は未実装。`compile_fail` のドキュメントテストで固定。`ocr.rs` の `perform` は読み取り結果を作るとすぐに `SensitiveText::new` で包む |
| IPC 応答 | ✅ | `masking/mod.rs` の `MaskCandidate` は `x/y/width/height/kind` だけ。`scan_page` の戻り値の JSON のキーがこの 5 つであることを Rust のテストで固定 |
| エラー文字列 | ✅ | `error.rs` の `TextScanBusy`/`TextScanFailed` は固定文字列。`commands.rs` の `app_error_from_scan_error` は種類によらず `text_scan_failed`、`png_from_body` は Raw 以外を `text_scan_failed`、`spawn_blocking` の `JoinError` も `text_scan_failed`。`ScanError` は値を持たない enum。TS の `TextScanError` の文言は `code` だけ |
| NSError・例外の中身 | ✅ | `ocr.rs` の `perform` は `performRequests_error(...).map_err(\|_\| ...)`、`recognize` は `exception::catch(...).unwrap_or(Err(...))`、`range_box` は `.ok().flatten()`。どれも中身を読まずに捨てる |
| ログ | ✅ | masking 配下で `println!\|eprintln!\|dbg!\|log::\|tracing::\|print!\|eprint!` は 0 件(`Grep`)。`commands.rs` の `scan_sensitive_text` が出すのは `format_scan_latency_log` の 1 行(`origin=mask scan_ms=… size=WxH`)だけで、テストで形を固定。`#[ignore]` の計測テストが出すのは件数と ms だけ |
| TS の console | ✅ | `src/ui/autoMask.ts`・`src/ui/maskOverlay.ts`・`src/canvas/maskSession.ts`・`src/ipc/textScan.ts`・`src/canvas/documentState.ts` に `console.` は 0 件。`localStorage`・`sessionStorage`・`indexedDB` も 0 件 |
| ファイル | ✅ | 本番コードの masking 配下に `fs::write`・`File::create` は無い。あるのは `eval.rs`(`#[cfg(test)]`・`#[ignore]`)の集計の出力(`testreport/masking/`・`output/reports/masking/`)だけで、出力するのは件数・割合・環境情報(`format!` の引数を確認。冒頭に「読み取った文字列は含まない」と書かれている) |
| パニック/expect の文言 | ⚠️ | 本番コードの `expect` は `LazyLock` の `Regex::new(...).expect("固定の正規表現が不正")` だけで、文言は固定。テスト側のメッセージは行の番号・範囲・件数だけ。**ただし文字列スライスの標準パニックは文字列を含む → Medium** |

### 2. `unsafe`・Objective-C の例外・autoreleasepool — ✅

- `unsafe` は `ocr.rs` の 3 か所だけ(`Grep unsafe` で masking 配下に他は無い): `VisionPage::range_box` 内の `boundingBoxForRange_error` と `boundingBox`、`perform` 内の `observation.boundingBox()`。3 か所とも直前に `// SAFETY:` で前提(オブジェクトの寿命、範囲が文字列の内側で空でないこと、読み取り専用、`Send` でないため生成したスレッドからだけ呼ばれること)が書かれている
- 範囲の事前検査: `range_box` は `range.is_empty() || range.end > line.utf16_len` を弾いてから `NSRange` を作る
- 例外の捕捉: `recognize`(Vision の要求の作成〜実行〜結果の収集の全体)と `range_box` の両方で `objc2::exception::catch` を使用。`Cargo.toml` で `objc2 = { features = ["exception"] }`
- autoreleasepool: `mod.rs` の `recognize_and_detect`(読み取り〜検出の全体)、`ocr.rs` の `recognize`、`range_box` の 3 か所。`VisionPage` は `Retained` を持つので `Send` でなく、`commands.rs` の `run_text_scan` は `spawn_blocking` の 1 スレッドの中で `scan` を最後まで実行する
- `to_normalized` は有限でない値・負の大きさを捨てる

### 3. 入力検証 — ✅

| 観点 | 結果 | 根拠 |
| ---- | ---- | ---- |
| PNG の検証 | ✅ | `png.rs` の `validate_with_limit`: 本文 ≤ 128MB → 署名 → 先頭チャンクが長さ 13 の IHDR → 幅・高さ ≥ 1・≤ 16,384 → チャンクの並びをたどって本文の内側で IEND に届くこと。`next_chunk` は `checked_add` と `get` で範囲外の読み取り・桁あふれが無い。ループは 1 回ごとに 12 バイト以上進むので必ず終わる。テスト: 署名違い・空・幅/高さ 0・16,385・上限ちょうど・途中切れ(7 か所)・IHDR でない・IHDR の長さ違い・長さが `u32::MAX` |
| 検証の順序 | ✅ | `mod.rs` の `scan` は `png::validate` の後に `recognize_and_detect` を呼ぶ。途中で切れた評価画像を Vision に渡さないことをテストで固定(`scanは途中で切れたpngをvisionへ渡さず失敗にする`) |
| IPC 本文が Raw 以外 | ✅ | `commands.rs` の `png_from_body`: `InvokeBody::Raw` 以外は `text_scan_failed`(JSON の本文のテストあり) |
| 応答のスキーマ(TS) | ✅ | `src/ipc/textScan.ts` の `parseCandidates`/`parseCandidate`: 配列でなければ失敗。各要素はオブジェクト(配列・null でない)、`Object.keys` が 5 つちょうどで集合 `{x,y,width,height,kind}` と一致、x/y は 0 以上・幅/高さは 1 以上の安全な整数、`kind` は 4 種のどれか。1 件でも外れれば全体を `invalid_response` にし、受け取ったオブジェクトは返さず 5 キーを詰め替える |
| 矩形の再クランプ | ✅ | `autoMask.ts` の `toMaskCandidateInputs` が `clipRectToCanvas` で画像内に収め、面積 0 を捨てる。`maskSession.ts` の `receiveResult` は数値と種類だけを写す。`documentState.ts` の `applyBaseEdits` も `roundRect` → `clipRectToCanvas` で収め直す |

### 4. 二重実行の防止・DoS — ✅(Low 1・Info 2)

- Rust: `commands.rs` の `begin_text_scan` が `TEXT_SCAN_IN_PROGRESS` を compare-exchange で立て、下ろすのは `TextScanGuard` の `Drop` だけ。ガードは `spawn_blocking` のクロージャへ move されるので、呼び出し側の Future が捨てられても処理が終わるまで下りない。成功・失敗・(開発ビルドの)パニックの巻き戻しでも `Drop` が走る。リリースビルドはパニックでプロセスが終了するので、フラグが残る問題は起きない。テスト `text_scanの排他は二重実行をtext_scan_busyにし失敗の後も下りる` あり
- フロント: `maskSession.ts` の `beginScan` は `idle` のときだけ token を発行する。`autoMask.ts` の `createAutoMaskController` は `inFlight` で前の invoke の完了を待ってから次を送り、待っている間に破棄されていれば送らない。e2e「⌘⇧M で始められ、処理中のボタン・⌘⇧M の再押下で読み取りは 1 回しか呼ばれない」あり
- 巨大な画像: 上限は確認項目 3 のとおり(Info: 上限の値が大きい)
- ReDoS: `regex` 1.13.1 で線形時間。後方参照・先読みは `regex` クレートにそもそも無い。辞書から作る選択肢は `regex::escape` を通している(`credential.rs`・`identifier.rs` の `person_label_ja_pattern`)。正規表現以外の 2 乗の走査は Info
- 時間の上限が無いこと: Low

### 5. XSS — ✅

- `innerHTML` は対象範囲で `autoMask.ts` の `createButton` の 1 か所だけ。代入するのは定数 `BUTTON_ICON_SVG`(固定の SVG)
- 印(`maskOverlay.ts` の `createMark`): ラベルは `KIND_VIEWS` の固定文言を `textContent` で入れる。`aria-label` も固定文言。`data-candidate-id` は数値。位置は `style.left` などに数値 + `%`
- 結果バー(`autoMask.ts` の `createMaskBar`・`renderMaskBar`): すべて `textContent`。件数の文は数値から作る(`resultStatusText`)
- トースト(`src/ui/toast.ts`): `textContent` のみ。文言は `AUTO_MASK_MESSAGES` の固定文言
- 読み取った文字列は IPC を通らない(確認項目 1)ので、DOM に入る経路がそもそも無い

### 6. 権限・CSP の差分 — 未確認(代わりの証拠あり)

- `git diff 02837e4..HEAD -- src-tauri/tauri.conf.json src-tauri/capabilities/` は、シェルが無いため**実行していない**
- 代わりの証拠: 現在の `src-tauri/capabilities/default.json` は `core:default`・`opener:allow-open-url`(システム設定の画面収録の URL 1 件)・`clipboard-manager:allow-write-image` の 3 つだけ。T17 の確認(`output/reports/security/T17_capabilities_review.md`)の最終形と一致する。`tauri.conf.json` の CSP(`default-src 'self'`・`connect-src 'self' ipc: http://ipc.localhost`・`img-src 'self' blob:`・`style-src 'self'`)にも、自動マスキングで足したものは無い。`lib.rs` は `invoke_handler` に `commands::scan_sensitive_text` を 1 件足し、`mod masking` を宣言しただけで、プラグインの追加は無い
- **人間の作業**: `git diff 02837e4..HEAD -- src-tauri/tauri.conf.json src-tauri/capabilities/` を実行し、出力が空であることを確かめる(TASK の検証コマンドは `git diff main -- ...`)

### 7. 依存 — 一部確認(OSV・npm audit は未確認)

- 新規の依存: `Cargo.toml` の `[target.'cfg(target_os = "macos")'.dependencies]` で新しく足されたのは `objc2-vision`(`default-features = false`、使う機能だけ)。`objc2-foundation`・`objc2-core-foundation`・`regex` は既に lock にある版を直接参照に昇格しただけ(コメントにも明記)。`objc2` には `exception` 機能を足した
- `Cargo.lock`: `objc2-vision` 0.3.2、`source = registry+https://github.com/rust-lang/crates.io-index`、`checksum = bfc19475…2689b`(AM-T03 の記録 `DEPS_auto-masking_2026-10-09.md` と一致)。依存は `objc2`・`objc2-core-foundation`・`objc2-foundation` だけ。パッケージ数は 510(`Grep '^name = '` の件数。AM-T03 の再照会の 508 + `objc2-vision` + ルートの `tadcap`)。`regex` 1.13.1 は RUSTSEC-2022-0013 の修正版 1.5.5 より新しい
- **OSV querybatch・`npm audit`・`npm audit signatures`**: ネットワークとシェルが無いため**今回は実行していない**。同じ日の AM-T03 の記録では、OSV の再照会で残りは `glib` 0.18.5(RUSTSEC-2024-0429)と `proc-macro-error` 1.0.4(RUSTSEC-2024-0370)の 2 件で、どちらも macOS の配布物に入らない。`npm audit` は 0 件、`npm audit signatures` は 47 件の署名を検証済み。今回も lock に `glib`・`proc-macro-error` が同じ版で残っていることは確認した
- **人間の作業**: `Cargo.lock` の全パッケージを `https://api.osv.dev/v1/querybatch` で照会し、`npm audit` と `npm audit signatures` を実行して、結果を本レポートに追記する

### 8. 評価データ・テストに実在のトークン・個人情報・会社がない / 製品名 — ✅(Low 2・Info 1)

| 観点 | 結果 | 根拠 |
| ---- | ---- | ---- |
| トークン形 | ✅ | 実在の形のトークン(各種接頭辞 + 本体の長さ・`AKIA` + 16 文字・`AIza` + 35 文字・JWT の `eyJ….eyJ`・`-----BEGIN`・`npm_` + 36 文字ほか)を `eval/masking/**`・`src-tauri/src/**`・`src/**`・`e2e/**`・`scripts/**` で検索した。一致したのは `lexicon.rs` の `TOKEN_PREFIXES` と `credential.rs` のテストの**接頭辞だけ**で、本体の付いた完全な形は 0 件。本体は実行時に作る(`credential.rs` の `mixed`・`fixture.js` の `genToken`。接頭辞も断片の連結) |
| メール・URL のドメイン | ✅ | 評価ページのメールアドレス 55 件・URL 39 件は、すべて `example.com/.net/.org`(RFC 2606)か `example.jp`・`example.co.jp`(JPRS の予約ドメイン)とそのサブドメイン。ほかに一致したのは `deploy@build-01`・`ops@10.0.0.12`(プロンプトとプライベート IP)と、CSS のクラス `.msg.me`(偽陽性)だけ |
| カード番号 | ✅ | 評価ページは `fixture.js` の `genCard` が先頭 9 + Luhn で実行時に作る。テストは `financial.rs` の `valid_card` が先頭 9。ソースにある 13〜19 桁の数字列は、IBAN の架空の BBAN(0 が並ぶもの)・記号番号・検査用の固定値で、先頭が 9 以外で Luhn を満たすカード番号の形のものは見つからなかった(例: 先頭 0 の 16 桁 1 件は Luhn も満たさない) |
| 実在の会社・人物 | ⚠️ | 郵便貯金系の実在の銀行名が評価ページ 2 か所と `financial.rs` のコメント・テスト名にある → Low。人名・会社名は架空の組み合わせに見えた(全件の照合はしていない) |
| 他社製品名 | ⚠️ | `fixture.js` に他社サービス名(文字種の名前)→ Low。`lexicon.rs` のトークン接頭辞のリテラル → Info。対象のソースコメントに他社製品名は無かった(`commands.rs` の日付アルゴリズムの出典 URL は既存の行で範囲外) |

### 9. 一括モザイクの焼き込み・印が ⌘C/履歴に入らない — ✅(Info 1)

- 焼き込み: `autoMask.ts` の `applyMosaic` が `applyBaseEdits(activeRects(), pixelateRect)` を呼ぶ。`documentState.ts` の `applyBaseEdits` はベースの画素を `surface.editBase` で直接加工し、`pixels` コマンドを 1 つの `group` として積む(1 手で取り消せる)
- 印は Canvas に描かない: `maskOverlay.ts` の印は Canvas の兄弟要素の DOM(`.mask-overlay`)。取り消しの履歴に積まれるのはモザイクの画素だけで、印は積まれない。キャプチャの履歴(サイドバー)は元のキャプチャを再読込するだけで、編集の結果を保存する IPC コマンドは無い(`src/**` の `invoke(` を確認)
- e2e: 「一連の流れ」(印は Canvas に描かれない・モザイクの内側の全画素が変わり外側は不変・⌘Z/⇧⌘Z)と、「印を出したまま ⌘C でコピーした画像に印が写らない(画素で確認)」あり。一括モザイクの後のコピーを直接見るテストは無い → Info

### 10. 辞書の同梱物と承認時の SHA-256 — 未確認(代わりの証拠あり)

- `shasum -a 256` を実行できないため、SHA-256 の一致は**未確認**
- 代わりの証拠: `src-tauri/src/masking/lexicon/` の 4 ファイルの行数(空でない行)は `given-names-romaji.txt` 409 / `prefectures.txt` 48 / `surnames-ja.txt` 768 / `surnames-romaji.txt` 836。承認済みレポート(`SECURITY_auto-masking-lexicon_2026-10-09_1303.md`)の `wc -l` と一致する。読み込みは `lexicon.rs` の `include_str!` 4 か所だけで、実行時の読み込み・取得は無い
- **人間の作業**: `shasum -a 256 src-tauri/src/masking/lexicon/*.txt` を実行し、承認時の値と一致することを確かめる。期待値: given-names-romaji `2d40d19f…b5fe9` / prefectures `f895e22d…72d5fd` / surnames-ja `ca2251dd…c1b97a1` / surnames-romaji `22d95e5d…258b40a4`(全桁は承認済みレポート参照)

## 実行したコマンド(検索)と出力の要約

| # | 検索(`Grep` / `Glob`) | 出力の要約 |
| - | ----------------------- | ---------- |
| 1 | `println!\|eprintln!\|dbg!\|log::\|tracing::\|print!\|eprint!\|std::io::stderr\|stdout\|fs::write\|File::create` in `src-tauri/src/masking` | `eval.rs` の `fs::write` 2 件だけ(テスト専用) |
| 2 | `panic!\|.expect(\|unwrap(\|unreachable!\|format!\|write!` in `src-tauri/src/masking` | 本番コードは `expect("固定の正規表現が不正")` と正規表現の組み立ての `format!` だけ。そのほかはテストの行(`#[cfg(test)]` の行番号と照合) |
| 3 | `unsafe` 系 in `src-tauri/src/masking` | `ocr.rs` の 3 か所だけ |
| 4 | 文字列スライス `[a..b]` in masking | 本番コードに直接スライス多数(Medium の根拠) |
| 5 | `set_hook\|take_hook\|catch_unwind` in `src-tauri/src` | 0 件 |
| 6 | `console.\|localStorage\|sessionStorage\|indexedDB\|innerHTML\|outerHTML\|insertAdjacentHTML\|document.write` in 対象 TS 5 ファイル | `autoMask.ts` の `createButton` の `innerHTML`(固定 SVG)1 件だけ |
| 7 | トークン形の正規表現(各種接頭辞・AKIA・AIza・JWT・PEM・npm ほか) | 接頭辞のリテラルだけ(2 ファイル) |
| 8 | メール・URL・ドメインの抽出 in `eval/masking` | 予約ドメインのみ(例外は上記の偽陽性) |
| 9 | 13〜19 桁の数字列 | カード番号の形で先頭が 9 以外のものは無し |
| 10 | 他社製品名・金融機関名のリスト in 対象 | fixture.js 3 行・実在の銀行名(評価ページ 2・`financial.rs` のコメント/テスト) |
| 11 | `^name = ` の件数 in `Cargo.lock` | 510 |
| 12 | `^.` の件数 in `masking/lexicon/` | 409 / 48 / 768 / 836(承認時と一致) |

## 依存パッケージサマリー

| パッケージ | 版 | 区分 | 状態 |
| ---------- | -- | ---- | ---- |
| `objc2-vision` | 0.3.2 | 新規(macOS のみ) | AM-T03 で OSV 0 件・`build.rs` なし・checksum 一致。今回の再照会は未実施 |
| `objc2` | 0.6.4 | 既存(`exception` 機能を追加) | 同上 |
| `objc2-foundation` / `objc2-core-foundation` | 0.3.2 | 既存版を直接参照に昇格 | 同上 |
| `regex` | 1.13.1 | 既存版を直接参照に昇格 | 既知の ReDoS(RUSTSEC-2022-0013)は修正済みの版 |
| `glib` / `proc-macro-error` | 0.18.5 / 1.0.4 | 既存(Linux 系) | AM-T03 の記録どおり macOS の配布物に入らない |

## 推奨アクション

1. **[Medium] パニックの文言から文字列を外す**: `lib.rs` の `run()` で、payload を出さないパニックフックを入れる。あわせて検出側の直接スライスを `get` に置き換えるか、任意の UTF-8 でパニックしない性質テストを足す。修正難易度: 低〜中
2. **[未確認の解消] 人間がコマンドを実行する**: `git diff 02837e4..HEAD -- src-tauri/tauri.conf.json src-tauri/capabilities/`(空であること)、OSV querybatch(`Cargo.lock` 全件)、`npm audit`・`npm audit signatures`、`shasum -a 256 src-tauri/src/masking/lexicon/*.txt`。結果を本レポートに追記する。修正難易度: 低
3. **[Low] 読み取りに時間の上限を付ける**(フロントで timeout → `failScan`)。修正難易度: 低
4. **[Low] 実在の銀行名を架空の名前・一般的な表現にする**(評価ページ 2 か所・`financial.rs` のコメント/テスト名)。修正難易度: 低〜中
5. **[Low] `fixture.js` の文字種の名前から他社サービス名を外す**。修正難易度: 低
6. **[Info] e2e に「一括モザイク後の ⌘C の画像 = Canvas」を 1 行足す**。修正難易度: 低

Critical / High は 0 件のため、修正タスク(AM-T25-F*)の起票は必須ではない。Medium 1 件(推奨アクション 1)は次のリリースまでに対応することを推奨する。

## 次回スキャン推奨事項

- シェルとネットワークのある環境で、確認項目 6・7・10 のコマンドを実行する(本レポートの「未確認」を解消する)
- `cargo test`・`cargo clippy -D warnings`・`npm run test`・e2e の結果を添えて再確認する(今回は未実行)
- 検出規則に対するファズ(`cargo fuzz` か proptest で、任意の UTF-8 の行・ページを `detect::run` に与えてパニックしないこと)
- `gitleaks` による Git の履歴全体のシークレットの検査(評価データの追加が続くため)
- `semgrep` の Rust ルールによる文字列スライス・`unwrap` の機械的な検出

## 総合判定

**条件付きで合格**(Critical 0 / High 0 / Medium 1 / Low 3 / Info 5)。

- スキャンした範囲では、ARCH §12 の主要な要件(文字列を IPC・ログ・エラー・ファイルに出さない、`unsafe` の限定と前提コメント、例外の捕捉、入力の検証、二重実行の防止、XSS 対策、焼き込みと印の分離)を満たしている
- AM-T25 の受け入れ基準「Critical / High が 0 件」は満たす
- 確認項目 6・7・10 は未確認(この環境でコマンドを実行できない)。人間が推奨アクション 2 を実行し、問題が無いと確かめるまで、本判定は確定しない

## 追記: 未確認だった項目の確認(2026-10-09、メインセッションで実行)

| # | 項目 | 実行したこと | 結果 |
| - | ---- | ------------ | ---- |
| 6 | 権限・CSP | `git diff 02837e4..HEAD -- src-tauri/tauri.conf.json src-tauri/capabilities/` | ✅ capabilities の差分 0。`tauri.conf.json` の差分は版番号・ライセンス全文の同梱・署名 ID の削除のみ(自動マスキング以外の作業)。CSP・権限の変更なし |
| 7 | 依存 | `Cargo.lock` 全 509 件を OSV querybatch / `npm audit` / `npm audit signatures` | ✅ OSV の該当は `glib` 0.18.5・`proc-macro-error` 1.0.4 の 2 件のみ(いずれも macOS の配布物に入らない Linux 系。DEPS_auto-masking と同じ)。npm は脆弱性 0 件、署名 47 件・証明 25 件を検証 |
| 10 | 辞書の SHA-256 | `shasum -a 256 src-tauri/src/masking/lexicon/*.txt` | ✅ 4 件とも承認時の値(2d40d19f… / f895e22d… / ca2251dd… / 22d95e5d…)と一致 |

これにより総合判定は **合格(Critical 0 / High 0)** に確定。Medium 1 件・Low 3 件は AM-T25-F2 として対応する。
