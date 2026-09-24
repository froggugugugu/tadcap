# E2E テスト結果 — T30 追加機能の横断フロー + 既存 E2E の待機競合修正

- 対象: `e2e/annotation-tools.spec.ts`(新規)、既存 spec の待機ヘルパー置き換え
  (`e2e/capture-flow.spec.ts` / `e2e/shape-edit.spec.ts` / `e2e/text-tool.spec.ts` /
  `e2e/tool-settings.spec.ts` / `e2e/undo-redo.spec.ts`)
- 実行コマンド: `npm run e2e`(= `playwright test`、ブラウザ chromium のみ)
- 実行日: 2026-09-24
- 担当: テスター(T30)。`src/**` `src-tauri/**` は変更していない(不具合は修正せず報告)

## 1. 既存 E2E の待機競合の修正

### 事象(T29 担当からの申し送り)

一部の spec は画像反映の完了を `page.waitForFunction(() => canvas.width > 0 && canvas.height > 0)`
で待っていたが、`<canvas>` 要素はHTML仕様上の既定サイズが `300x150` であり、`width`/`height`
属性が一度も設定されていない状態でもこの条件を満たしてしまう。そのため
`capture://completed` 受信 → `read_capture_image` → `renderImageToCanvas()` が実際に画像を
反映する**前**に `waitForFunction` が解決してしまう競合(レースコンディション)があった。

### 対応

`e2e/fixtures/captureReady.ts` に共通ヘルパー `captureAndWaitReady(page, expectedHistoryCount?)` を
新設した。「コピーボタンが有効になる」(`canvasState.image` セット済み)と「履歴に指定件数が
追加される」(`main.ts::handleCaptureCompleted` 完了後にのみ発生)の両方を待つことで、画像反映が
確実に完了したタイミングまで待機する(`tool-settings.spec.ts`/`undo-redo.spec.ts` が既に使っていた
パターンを共通化したもの)。2回目以降のキャプチャでも `expectedHistoryCount` に増加後の件数を
渡せば同じヘルパーが使える(`annotation-tools.spec.ts` の新規キャプチャシナリオで確認)。

置き換えたファイル:

| ファイル | 変更内容 |
| -------- | -------- |
| `e2e/capture-flow.spec.ts` | `page.waitForFunction(width>0 && height>0)` → `captureAndWaitReady(page)` |
| `e2e/shape-edit.spec.ts` | ローカル関数 `captureAndSelect()` 内の待機を `captureAndWaitReady(page)` に置き換え |
| `e2e/text-tool.spec.ts` | ローカル関数 `captureAndSelectText()` 内の待機を `captureAndWaitReady(page)` に置き換え |
| `e2e/tool-settings.spec.ts` | 重複していたローカル `capture()` 関数を削除し共通ヘルパーへ統一 |
| `e2e/undo-redo.spec.ts` | 重複していたローカル `capture()` 関数を削除し共通ヘルパーへ統一。`saveSnapshot`/`diffFromSnapshot` も `e2e/fixtures/canvasSnapshot.ts` へ切り出して共通化(`annotation-tools.spec.ts` と共有) |

`e2e/capture-race.spec.ts` は幅・高さの**厳密一致**(`el.width === 300 && el.height === 200` 等)を
待っており、Canvas既定サイズ(`300x150`)とは高さが一致しないため同じ競合は起きない。指示どおり
変更していない(回帰確認のみ)。

### 安定性確認(`--repeat-each 5`)

変更した5ファイル + 新規 `annotation-tools.spec.ts` の全26テストを5回ずつ(計130回)実行:

```
npx playwright test e2e/annotation-tools.spec.ts e2e/capture-flow.spec.ts e2e/shape-edit.spec.ts \
  e2e/text-tool.spec.ts e2e/tool-settings.spec.ts e2e/undo-redo.spec.ts --repeat-each 5
```

結果: **130 passed / 130**(exit code 0、19.3秒、5 workers)。フレーキーな失敗なし。

## 2. 横断フロー `e2e/annotation-tools.spec.ts`(新規)

`tool-settings.spec.ts`(T28)・`undo-redo.spec.ts`(T29)・`shape-edit.spec.ts`(T31)・
`text-tool.spec.ts`(T27)が個別機能を検証しているのに対し、本ファイルはツールを横断する
ユーザーフローのみを対象にした(既存specと観点を重複させない)。

| テスト | 結果 | 検証内容 |
| ------ | ---- | -------- |
| 色を変えながら矢印・矩形・円・テキストを描くと、それぞれの領域に選んだ色の画素があり、モザイクは色の影響を受けない | pass | 赤/橙/緑/青を切り替えながら矢印・矩形・円・テキストを描画し各領域の画素色を検証。モザイクは黄を選択した状態で適用しても結果に黄色画素が含まれない(ブロック平均のみで`toolSettings.color`を参照しないことを確認) |
| 矢印→矩形(リサイズ・移動)→円→テキスト→モザイクを混ぜた後、Cmd+Zの連打で元画像とバイト一致、Cmd+Shift+Zの連打で最終状態と一致 | pass | 矩形は描画後に右下ハンドルでリサイズ→内側ドラッグで移動してから確定。5操作ぶん`Cmd+Z`連打でオリジナル画像とバイト完全一致(diff=0)、`Cmd+Shift+Z`連打で最終状態と完全一致 |
| 描いた後にコピーすると、コピー結果がCanvasと一致しハンドルや入力欄は写らない | pass | 編集中(未確定)の矩形を残したままコピー→ハンドルが消え図形が焼き込まれる。次に入力中(未確定)のテキストを残したままコピー→入力欄が消えテキストが焼き込まれる。いずれも`getClipboardImageStats()`で`nearWhitePixels===0`(ハンドル・入力欄の白が写っていない)・`equalsCanvas===true`を確認 |
| 描いた後に新規キャプチャすると、直前の履歴サムネイルに描いた内容が反映され、取り消し・やり直しは空になる | pass | 赤い矢印を確定後に2回目のキャプチャ(モック)を実行。履歴2件目(直前の項目)のサムネイル`<img>`をCanvasへ再描画して画素検証し赤色を検出。取り消し・やり直しボタンとも無効化を確認 |
| 色・文字サイズ・取り消し/やり直しのaria-labelが期待どおり存在する | pass | 色「ピンク」「赤」「橙」「黄」「緑」「青」「その他の色」・文字サイズ「文字サイズ 小/中/大」・「取り消し」「やり直し」の`aria-label`を確認。「赤」等は他要素との部分一致を避けるため`exact: true`で判定 |

- 合計: 5 pass / 0 fail
- レポート: `testreport/e2e/index.html`
- トレース確認: `npx playwright show-report testreport/e2e`

## 3. 検証コマンドの実行結果

```
. "$HOME/.cargo/env" && npm run build && npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml \
  && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings && npm run e2e
```

| コマンド | exit code | 結果 |
| -------- | --------- | ---- |
| `npm run build`(`tsc && vite build`) | 0 | 型検査・ビルドとも成功 |
| `npm run test:run`(Vitest) | 0 | 26 files / **323 tests passed** |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 0 | **109 tests passed** |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | 0 | 警告0件 |
| `npm run e2e`(= `playwright test`、全7ファイル) | 0 | **27 tests passed**(既存22件 + 新規5件、フレーキーな再試行なし) |

チェーン全体(`&&`連結)の最終 exit code: **0**。

## 4. 見つけたアプリ本体の不具合

本タスクの範囲(E2Eテスト作成・既存specの待機修正)では、新たに再現できたアプリ本体の
不具合は**無かった**(全自動テスト・repeat-each 5とも green)。

参考として、`output/tasks/PROGRESS.md`(T29完了ログ、2026-09-24)に開発者から次の**既知の挙動**が
報告されている。本タスクでは独自に再現検証はしていないが、意図した設計か確認が必要な項目として
`testreport/manual/CHECKLIST_T18.md` 項目38に人間の実機確認事項として追記した:

> テキスト入力中に取り消しボタンを押すと、入力中のテキストが確定されたうえで直後に取り消され、
> 文字が消える(やり直しボタンで復元できる)。

## 5. 手動確認チェックリストの追記

`testreport/manual/CHECKLIST_T18.md` に「## 12. 追加機能(T20〜T31)の実機確認」を新設し、
**13項目(#29〜#41)** を追記した(既存 #1〜#28 との重複なし、番号は続き番号)。

- 12-1 色・フォントサイズ選択UI(T28): #29〜#30(macOS標準カラーピッカー・ピッカーフォーカス中のCmd+C)
- 12-2 テキストツール(T27): #31〜#33(IME変換中/確定後のEnter・他アプリ切替時のblur・入力欄フォーカス中のショートカット奪取防止)
- 12-3 直前に描いた図形の編集(T31): #34〜#36(ハンドルでのリサイズ・移動、各種確定トリガー、Escでの破棄)
- 12-4 取り消し・やり直し(T23, T29): #37〜#39(複数操作の連続Undo/Redo・30件上限、テキスト入力中の取り消しボタンの既知挙動、5K相当画像での動作)
- 12-5 テーパー矢印の太さ・影(T24・矢印太さ改訂・T31の1.5倍化): #40
- 12-6 メニューバーアイコン(オタマジャクシ): #41(2026-09-24追加要望、`output/tasks/PROGRESS.md`参照)

`output/tasks/TASK_tadcap_mvp.md`「手動確認チェックリスト(T20 以降・追加分)」(5項目)の内容も
このセクションに統合済み(未転記だったため)。
