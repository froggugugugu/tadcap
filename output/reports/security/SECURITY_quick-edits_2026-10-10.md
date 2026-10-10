# セキュリティ確認レポート: 小さな編集機能(QE-T25)

## 免責事項

本スキャンはツールと手作業のコードレビューに基づく参考情報であり、セキュリティ専門家によるペネトレーションテストの代わりにはならない。重要なシステムでは必ず専門家のレビューを受けること。

## スキャン概要

| 項目 | 内容 |
| ---- | ---- |
| 実施日 | 2026-10-10 |
| 対象範囲 | `git diff 8011458..HEAD`(25 コミット・117 ファイル)のうち、小さな編集機能(スタンプ・スポットライト・トリミング・縮めてコピー・1 キー切替)と設定の保存(`src-tauri/src/settings.rs`・`shortcuts.rs`・`commands.rs` の `get_shrink_copy` / `set_shrink_copy`・`capture/pixel_ratio.rs`・`capture/mod.rs`・`lib.rs`)。フロントは `src/canvas/**`・`src/ui/**`・`src/ipc/**`・`src/history/**`・`src/main.ts`・`index.html` の差分 |
| 根拠 | `output/prd/PRD_quick-edits.md`、`output/design/ARCH_quick-edits.md` §12、`output/design/ADR_002_crop-undo-and-style-basis.md`、`output/design/UI_quick-edits.md`、`output/tasks/TASK_quick-edits.md` QE-T25 |
| 方法 | SAST(手作業のコードレビュー + パターン検索)、PNG 解析の関数を写して動かすファズ、依存の CVE 照会(OSV・npm)。DAST は対象外(デスクトップアプリで HTTP の面が無い) |
| ソースの変更 | なし(本レポートと REVIEW の 2 ファイルだけ作成) |
| 並行作業 | 別の担当がトリミングの E2E(`e2e/`)と `docs/docs/` を書いている。本レポートはコミット済みの `HEAD`(`5a03515`)が対象で、作業ツリーの未コミット分は見ていない |

## エグゼクティブサマリー

| 重大度 | 件数 |
| ------ | ---- |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 3 |
| Info | 5 |

**総合判定: 合格(Critical・High 0 件)。** 修正タスク(QE-T25-F*)は不要。Low 3 件はどれも利用者自身の操作や同じ利用者の権限の範囲に閉じており、外から悪用できる経路は無い。

## 確認項目ごとの結果

| # | 確認項目 | 結果 | 根拠 |
| - | -------- | ---- | ---- |
| ① | PNG の pHYs の読み取りの入力検証 | ✅ 問題なし | 下記「① PNG の解析」 |
| ② | 設定ファイル(未知キー・原子的書き込み・壊れたファイル・並行書き込み・パス) | ✅ 主要な性質は満たす(Low 2 件) | 下記「② 設定ファイル」、L-1・L-3 |
| ③ | IPC の入力検証(`set_shrink_copy`・撮影結果の `pixelRatio`) | ✅ 問題なし | 下記「③ IPC」 |
| ④ | XSS(`innerHTML` は固定の SVG だけか、文言は `textContent` か) | ✅ 問題なし | 下記「④ XSS」 |
| ⑤ | トリミング・取り消しのメモリ(巨大画像・8MB の上限で古い手を捨てる経路) | ✅ 捨てる経路にバグなし(Low 1 件: 表示中の取り消しのメモリは上限なし。ADR-002 で受容済み) | 下記「⑤ メモリ」、L-2 |
| ⑥ | 自動マスキングとの相互作用 | ✅ 候補・読み取り対象の食い違いなし | 下記「⑥ 自動マスキング」 |
| ⑦ | 権限・CSP | ✅ capabilities の差分 0 行。`tauri.conf.json` は `width` 800→1080 と、リリースの `version` 1.0.1→1.1.0 の 2 行(I-2) | 下記「⑦ 権限・CSP」 |
| ⑧ | 依存(OSV・`npm audit`・`npm audit signatures`) | ✅ 新規依存 0。既知の 2 件は既存で macOS の配布物に入らない | 下記「⑧ 依存」 |
| ⑨ | ブラウザの保存(`localStorage` など) | ✅ 0 件 | `grep -rn -E 'localStorage\|sessionStorage\|indexedDB\|document\.cookie' src` → 0 件 |
| ⑩ | 他社の製品名 | ✅ 差分には無い(I-3: 範囲外の既存の 2 か所に残る) | 下記「⑩ 製品名」 |

### ① PNG の解析(`src-tauri/src/capture/pixel_ratio.rs`)

- 入口は `read_pixel_ratio(path)` だけ。パスは Rust の撮影処理が作ったもので、フロントからは受け取らない(`commands.rs` の `run_capture` → `capture::run` の戻り値)
- 署名 8 バイトを確かめる(`:55-58`)。チャンクの長さは PNG の上限 2³¹−1 を超えたら `None`(`:65-67`)。「本文 + CRC」がファイルの残りに収まるかを、読み飛ばす前に `u64` で確かめる(`:69-72`)。`pos` は常に `total_len` 以下なので足し算はあふれない
- pHYs は長さがちょうど 9 のときだけ固定長の配列に読む(`:77-82`)。`IDAT` / `IEND` で打ち切るので、画像の本体は読まない
- 倍率の計算は `u64::from(u32) * 254 * 100` で、最大でも約 1.1×10¹⁴ と `u64` に収まる(`:103`)。浮動小数点は使わない
- `seek` は `i64::try_from(...).ok()?` で変換し、変換できなければ `None`(`:86`)。ファイルが途中で切れていれば `read_exact` が失敗して `None`
- ループは毎回 12 バイト以上進むか `return` するので、必ず終わる
- **ファズ(本確認で追加実施)**: `pixel_ratio_from_reader` などを写した単体のプログラムを、整数あふれの検査を有効にして(`rustc -C overflow-checks=on`)正しい PNG を変異させた 300 万件(1〜4 バイトの書き換え・途中で切る・長さの欄にでたらめな 32bit 値)+ でたらめなバイト列 20 万件で実行した。**パニック 0 件**、戻り値は `Some(2)` / `None` だけ(`Some(1)`・それ以外の値なし)
- ログ出力・`unwrap`・添え字のアクセスは無い

### ② 設定ファイル(`src-tauri/src/settings.rs`)

| 性質 | 結果 | 根拠 |
| ---- | ---- | ---- |
| 未知のキーを残す | ✅ | `AppSettings.extra`(`#[serde(flatten)]`、`:42-43`)。テスト `知らない項目は保存し直しても残す`(入れ子のオブジェクトも残る) |
| 原子的な書き込み | ✅ | 同じディレクトリの `settings.json.tmp` に書き、`sync_all` → `rename`。失敗したら一時ファイルを消す(`:103-114`)。ディレクトリの `fsync` はしない(電源断の直後に古い内容へ戻ることはあるが、壊れた中身は残らない) |
| 壊れたファイル | ✅(既定値で起動) | `:82-88`。次の保存で上書きする(仕様どおり)。型の違うキー・新しい版の扱いは L-1 |
| 並行した書き込み | ✅(同じプロセスの中) | `SettingsStore.update` は `Mutex` を握ったまま保存まで行う(`:143-154`)。保存に失敗したらメモリの値を変えない。テスト `並行した更新は直列化され_どの項目も失われない`(8 スレッド)。別のプロセスとの競合は L-3 |
| 書く場所が 1 か所 | ✅ | `grep -rn save_settings src-tauri/src` → `settings.rs` の中だけ(定義 `:92`・`SettingsStore::update` `:151`・テスト) |
| パス | ✅ | `app_config_dir()/settings.json` の固定(`:65-70`)。フロント・ファイルの中身からパスを受け取らない |
| ロックの順序 | ✅ | `apply_capture_shortcut` は `CaptureShortcutManager` の状態のロックを、`set_shrink_copy` は `SettingsStore` のロックだけを取り、逆順に取る経路は無い(デッドロックなし) |
| ログ | ✅ | 追加なし。`eprintln!` 2 か所(`:78`・`:85`)は `8011458` 時点からある(I-4) |

### ③ IPC

- `set_shrink_copy(enabled: bool)`(`commands.rs`): 引数は `bool` だけで、真偽値でない値は Tauri の引数の復元(serde)で弾かれる。保存に失敗したら値を変えずに固定文字列 `settings_save_failed` を返す(`AppError::SettingsSaveFailed`)。エラーの中身(パス・OS のエラー)はフロントへ出さない
- `get_shrink_copy`: 読み取りだけ。フロントの `getShrinkCopy()`(`src/ipc/settings.ts`)は `=== true` のときだけオンで、失敗・真偽値以外はオフ
- `setShrinkCopy()` は応答が真偽値でなければ `ShrinkCopyError("invalid_response")`
- 撮影結果の `pixelRatio`: Rust は `Option<u8>` で 1 / 2 / `None` しか作らない。フロントは `normalizePixelRatio()`(`src/ipc/capture.ts`)で `1 | 2` 以外を `null` にし、`startCapture()` と `capture://completed` のイベントの両方で通す。さらに `toCanvasPixelRatio()`(2 以外は 1)・`copyRatio()`(2 以上の整数以外は 1)・`shrunkSize()`(1 以下・非有限は縮めない、最小 1px)で多重に守っている。webview がイベントを偽造しても、縮めない側に倒れるだけ
- 新しいコマンドは `lib.rs` の `invoke_handler` に 2 つ足しただけ。capabilities の変更は無い

### ④ XSS

- `innerHTML` の代入は 6 か所(`grep -rn -E 'innerHTML|outerHTML|insertAdjacentHTML|DOMParser|document\.write|eval\(|new Function' src`、テストを除く)。今回の差分で増えたのは `src/ui/stampKindPicker.ts:83`(`stampKindIcon(option.glyph)`)と、`src/ui/toolbar.ts:234` の `tool.icon` の新しいツール(スタンプ・スポットライト・トリミング)の SVG だけ。どちらもソースに書いた固定の文字列で、`glyph` は 5 種の列挙(`STAMP_KIND_OPTIONS`)。利用者の入力・IPC の値は入らない
- `insertAdjacentElement`(`cropTool.ts`)は要素の差し込みで、HTML は解釈しない
- 新しい文言(トリミングの帯 `cropBar.ts`、設定画面の「コピーを等倍に縮める」・失敗の文、上限の通知)はすべて固定文字列を `textContent` / `createTextNode` で入れる。トリミングの帯の大きさの表示も数値から作った文字列を `textContent` で入れる
- スタンプの記号は Canvas の `fillText` で、描くのは番号(`String(number)`)・`!`・`?` の固定値だけ。✓・× は線で描く。色(`shape.color`)は `fillStyle` にしか使わず、`stampGlyphColor()` は `#RRGGBB` の正規表現に合わない値を白として扱う
- `index.html` の差分に `style=`・`<script>`・`on*=` 属性の追加は無い(CSP の `style-src 'self'` と矛盾しない)

### ⑤ メモリ(トリミング・取り消し)

- `crop` コマンドは反対側のベース全体の RGBA を持つ(`documentState.ts` `applyCrop()`、`documentSurface.ts:262` `swapAll`)。取り消し・やり直しのたびに持ち替えるだけで、コピーが積み上がることは無い
- 履歴へ退避するときの上限 8MB(`documentArchive.ts:27`)の切り詰め `trimUndoToBudget()`(`:56-70`)を確かめた:
  - 取り消し側は最も古い手から、やり直し側は最も遠い手から、**連続して**捨てる。途中だけ抜けることは無い
  - `crop` が捨てられるのは、それより古い手がすべて捨てられた後だけ。残った手(トリミングより新しい手)は切った後のベースに対する操作なので、正しく取り消せる
  - やり直し側に `crop` があるときも、遠い手から捨てるので、近い手だけが消えて遠い手が残ることは無い
  - `commandPixelBytes()` は `crop` を数える(`:43`)。`group` は中身の合計
  - 退避した後のバイト数(`archivedDocumentBytes()`)は切り詰めた後の値で、履歴全体の 300MB の判定に使われる
- **表示中のドキュメント**の取り消し・やり直しは件数(各 30)だけで、バイト数の上限は無い → L-2

### ⑥ 自動マスキングとの相互作用

| 経路 | 結果 | 根拠 |
| ---- | ---- | ---- |
| 読み取り対象 | ✅ | 自動マスキングは `exportDocumentBase()`(ベース)を読む。スポットライトの暗さは表示 canvas にだけ塗るため(`composeDocument()`)、文字の読み取りは暗さの影響を受けない。トリミング後はベースも切り詰められているので、候補の座標は切った後の画像の座標と一致する |
| 処理中・確認中のトリミング | ✅ | 自動マスキングが始まるとトリミングの範囲を捨てる(`cropTool.ts` `shouldCancelCrop` の `masking`)。処理中・確認中はトリミングのドラッグを受けない(`handlePointerDown` の `isMaskSessionActive()`)。1 キー切替・取り消しボタンも止まる |
| 大きさが変わったときの候補 | ✅ | `bindMaskSessionToDocumentSize()`(`autoMask.ts`)が、処理・確認の開始時の大きさからの変化(トリミングとその取り消し・やり直し)で候補を捨てる。画像の差し替えは従来の `bindMaskSessionToCanvasImage()` と `main.ts` の `discardMaskSession()` |
| モザイクの粗さ | ✅ | 手のモザイク(`mosaicTool.ts:230`)と一括モザイク(`autoMask.ts:288`)はどちらも `getCaptureSize()`(撮った時点の大きさ)で決める。トリミング後にブロックが細かくなり隠す強さが落ちることは無い。`captureSize` はトリミング・取り消しで変わらず、履歴の退避にも入る |
| 暗い所の候補 | ✅ | 穴の外(暗い所)にある候補も通常どおりモザイクがかかる(ベースに適用、暗さはその上に表示) |

例外として、退避の無い履歴の項目を開き直す経路(`main.ts:344` の `resetDocument()`)では `captureSize` が今の画像の大きさになる。退避は項目が消えるときにしか消されないため、通常は起きない(REVIEW の CONSIDER-1)。

### ⑦ 権限・CSP

- `git diff 8011458..HEAD -- src-tauri/capabilities/` → **0 行**
- `git diff 52b2835 -- src-tauri/tauri.conf.json` → 2 行: `"width": 800` → `1080`(QE-T03)と、`"version": "1.0.1"` → `"1.1.0"`(コミット `7c3c56d` のリリース作業)。`version` はリリースで想定どおりの変更で、権限・CSP には関係しない(I-2)
- CSP(`default-src 'self'`・`connect-src 'self' ipc: http://ipc.localhost`・`img-src 'self' blob:`・`style-src 'self'`)は変わっていない
- `capabilities/default.json` は `core:default`・`opener:allow-open-url`(システム設定の URL 1 つ)・`clipboard-manager:allow-write-image` のまま

### ⑧ 依存

| コマンド | 結果 |
| -------- | ---- |
| `git diff --stat 8011458..HEAD -- package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock` | 4 ファイルとも自分の `version` の行だけ(1.0.1 → 1.1.0)。依存の追加・削除・版の変更・features の追加は 0 |
| OSV querybatch(`https://api.osv.dev/v1/querybatch`、`Cargo.lock` の registry の 509 件すべて、ローカル 1 件は除外) | 該当 2 件: `glib` 0.18.5(GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429)、`proc-macro-error` 1.0.4(RUSTSEC-2024-0370)。どちらも既存で、前回(`SECURITY_auto-masking_2026-10-09.md`)と同じ。Linux 系で macOS の配布物に入らない(I-1) |
| `npm audit` | `found 0 vulnerabilities` |
| `npm audit signatures` | `audited 47 packages`・`47 packages have verified registry signatures`・`25 packages have verified attestations` |

### ⑩ 製品名

- 差分の追加行(画像・lock を除く 9,597 行)を、他社の製品名・サービス名の一覧(画面キャプチャ系の製品、デザイン・チャット・会議・ブラウザ・OS 会社の名前など)で検索した。**該当なし**
- 見つかったのは動作環境の表記(紹介ページの「Apple 公証済み・Apple silicon 向け」「Apple silicon の Mac(macOS 14 以降)」)と、CSS のフォント指定(`-apple-system`・`"Helvetica Neue"`)、自社リポジトリへのリンクだけ。製品の比較・言及ではないため問題なしと判断した(【仮定】動作環境の表記は製品名の禁止に当たらない)
- 範囲外(`8011458` より前から)に 2 か所残っている → I-3

## 指摘

### Low

#### L-1: 設定ファイルの版を確かめず、型の違うキーがあるとファイル全体を壊れたものとして扱う

- **場所**: `src-tauri/src/settings.rs:53-58`(`SettingsFile.version` は読むが使わない)、`:82-88`、`:97-100`(常に `version: 1` で書き戻す)
- **内容**:
  1. 新しい版が書いた `"version": 2` のファイルを読んでも版を確かめず、保存のときに `"version": 1` で書き戻す(未知のキーは残る)。新しい版に戻したとき、版 1 の形として読み直される
  2. 既知のキーの型が違う(例: 将来 `shrinkCopy` をオブジェクトに変えた)と、ファイル全体の読み込みが失敗して既定値で起動し、次の保存(縮めてコピーの切替・キーの変更)でショートカットと未知のキーを含むファイル全体が上書きされる
- **影響**: 利用者の設定の消失(データの完全性)。外からの攻撃の経路は無い(ファイルは利用者のアプリの設定ディレクトリの中)
- **対応案**: 今の形式で困ることは無いので、版 2 を導入するタスクで「`version` が自分より新しければ保存しない(または未知の版として読み取り専用にする)」「既知のキーは 1 つずつ緩く読む」を検討する。今回は修正不要

#### L-2: 表示中のドキュメントのトリミングの取り消しにバイト数の上限が無い

- **場所**: `src/canvas/documentState.ts` `applyCrop()`(`crop` コマンドがベース全体の RGBA を持つ)、`src/canvas/undoStack.ts:25`(上限は件数 30 だけ)
- **内容**: 5K の全画面(約 59MB)で、1px ずつ小さく切る操作を 30 回繰り返すと、取り消し側に最大で約 1.7GB の `ImageData` が残る。履歴の 300MB の上限は退避した分しか数えない
- **影響**: 利用者自身の操作によるメモリの増加。外から引き起こす経路は無い。ADR-002「不採用理由(見送り)」・ARCH §6.4 で受容済み
- **対応案**: メモリで困った報告が出たら ARCH §16 の「画面外の canvas のまま持つ」案を検討する。今回は修正不要

#### L-3: 一時ファイルの名前が固定で、別のプロセスとの同時の保存は直列にならない

- **場所**: `src-tauri/src/settings.rs:103`(`settings.json.tmp`)
- **内容**: `Mutex` は同じプロセスの中だけ。`open -n` などでアプリを 2 つ起動して同時に設定を保存すると、一時ファイルを互いに上書きし、片方の `rename` が失敗する(失敗した側はメモリの値を変えず `settings_save_failed` を返す)。どちらの場合も書きかけのファイルは残らない
- **影響**: 片方の変更が保存されない。同じ利用者の権限の範囲で、境界を越える攻撃にはならない。一時ファイルの作成はシンボリックリンクをたどるが、ディレクトリに書けるのは同じ利用者だけ
- **対応案**: 不要(単一起動の前提)。気になるなら一時ファイル名にプロセス id を付ける

### Info

- **I-1**: OSV の既知 2 件(`glib` 0.18.5・`proc-macro-error` 1.0.4)は既存のまま。macOS の配布物に入らない
- **I-2**: `git diff 52b2835 -- src-tauri/tauri.conf.json` は `width` に加えて `version` の 1 行がある(リリース `7c3c56d`)。TASK の「`width` の 1 行だけ」は QE-T25 の時点の想定で、リリース後に確認したための差。権限・CSP は変わっていない
- **I-3**: 範囲外の既存の製品名: `src/ui/arrangeButtons.ts:5` のコメント(デザインツールの名前)、`output/design/ARCH_tadcap_mvp.md:281`(同じ名前と OS 付属のプレゼン・表計算などのアプリ名)。今回の差分ではないが、公開リポジトリの方針に合わせ、別のタスクで一般的な言い方に直すことを勧める
- **I-4**: `settings.rs:78`・`:85` の `eprintln!` は `8011458` からあり、serde のエラー文(ファイルの中身の一部を含みうる)を標準エラーへ出す。中身はショートカットの文字列と真偽値だけで、機密ではない
- **I-5**: ARCH §12「ログを追加しない」に対し、`src/ui/settingsDialog.ts` に `console.warn` が 2 か所増えた(縮めてコピーの保存・読み込みの失敗)。出すのは `ShrinkCopyError` のコード(`save_failed` など)だけで、パス・設定の値は出ない。問題なし

## 実行したコマンドと結果

| コマンド | 結果 |
| -------- | ---- |
| `git diff --stat 8011458..HEAD` | 117 files changed, 9503 insertions(+), 417 deletions(-) |
| `git diff 8011458..HEAD -- src-tauri/capabilities/` | 0 行 |
| `git diff 52b2835 -- src-tauri/tauri.conf.json` | `version` と `width` の 2 行 |
| `git diff --stat 52b2835 -- package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/capabilities/`(NODEPS) | 4 ファイルとも自分の `version` の行だけ(リリースによる差。依存の変更 0) |
| `grep -rn -E 'from "\.\./(\.\./)?(ui\|ipc)/' src/canvas`(LAYER) | `canvasState.ts:18` と `canvasState.test.ts:3` の `CaptureResult` 型だけ(期待どおり) |
| `grep -rn save_settings src-tauri/src`(LAYER) | `settings.rs` の中だけ |
| `grep -rn -E 'localStorage\|sessionStorage\|indexedDB\|document\.cookie' src`(STORAGE) | 0 件 |
| `grep -rn -E 'innerHTML\|outerHTML\|insertAdjacentHTML\|DOMParser\|document\.write\|eval\(\|new Function' src`(テストを除く) | 6 件、すべて固定の SVG |
| OSV querybatch(Python で `Cargo.lock` を読み 509 件を照会) | 該当 2 件(既存) |
| `npm audit` / `npm audit signatures` | 0 件 / 47 件の署名・25 件の証明を検証 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 487 passed; 0 failed; 9 ignored(+ doc-tests 2 passed) |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | 警告 0 |
| `npx vitest run` | Test Files 55 passed / Tests 1045 passed |
| `npm run build` | 成功 |
| pHYs の解析のファズ(写したプログラム、`overflow-checks=on`) | 320 万件でパニック 0 |

`npm run e2e` は、別の担当が `e2e/` を並行で編集しているため実行していない(SMOKE のうち E2E だけ未実行)。トリミングの E2E は QE-T23 で追加される予定。

## 修正タスク案

Critical・High が 0 件のため不要。
