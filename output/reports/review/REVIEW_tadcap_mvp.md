# コードレビュー: Tadcap MVP 実装全体(Phase 5)

> レビュー対象: `src/**`, `src-tauri/src/**`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
> `src-tauri/capabilities/**`, `index.html`, `e2e/**`, `scripts/**`
> 基準: `output/prd/PRD_tadcap_mvp.md`(承認済み)/ `output/design/ARCH_tadcap_mvp.md`(承認済み、T12 で RGBA8 改訂)/
> `output/tasks/TASK_tadcap_mvp.md`(承認済み)/ `docs/docs/development-patterns.md` / `project-config.md`
> コミットが無いためファイルを直接読んでレビューした(git diff は使用していない)。

## 概要

- レビュー対象ファイル数: フロントエンド 21 ファイル(ソース 12 + テスト 9)、Rust 11 ファイル、設定 3 ファイル(Cargo.toml /
  tauri.conf.json / capabilities/default.json)、`index.html`、E2E 3 ファイル、`scripts/latency-summary.mjs`
- 影響範囲: MVP 全機能(FR-001, FR-002, FR-004〜FR-006, FR-008〜FR-010, NFR-001〜003)
- 仕様準拠: **NG**(MUST 参照。コア機能自体は FR/NFR の受け入れ基準をおおむね満たすが、Gate5(検証)完了の
  証跡が未整備、かつ FR-006/FR-008/FR-010 の核心である「Canvas への書き込み」と「履歴切替」に
  データ破損を招く競合状態が2件ある)
- ドキュメント同期: **OK**(`docs/docs/*.md` は実装の意図的な逸脱(RGBA8化・asset protocol scope の
  canonicalize 補強・`[hidden]` の `!important` 修正など)を含めて極めて正確に実装を反映しており、
  今回の突き合わせで不整合は見つからなかった)

## 定量計測(任意 / ゲート 5 根拠)

`testreport/t18/summary.txt` に T18 時点のスモークテスト結果がある:

| 指標 | 結果 | 取得元 |
| ---- | ---- | ------ |
| `npm run build` | exit=0 | testreport/t18/summary.txt |
| `npm run test:run`(Vitest) | exit=0 | 同上 |
| `cargo test` | exit=0 | 同上 |
| `cargo clippy -D warnings` | exit=0 | 同上 |
| `npm run e2e`(Playwright) | exit=0 | 同上 |
| `npm run tauri build`(app+dmg) | **exit=1**(dmg 生成失敗、`--bundles app` のみ再実行で exit=0) | 同上 |

上記はすべて自動化コマンドの結果であり、`testreport/manual/CHECKLIST_T18.md`(実機での手動確認 28 項目、
NFR-001 最終計測・NFR-002 実機確認を含む)は全項目 `☐`(未実施)のままである。詳細は MUST-3 参照。

## 指摘事項

### MUST(必須修正)

- [ ] `src/canvas/tools/arrowTool.ts:154-245`, `src/canvas/tools/mosaicTool.ts:243-324`, `src/main.ts:55-76`
  ドラッグ中(`pointerdown`〜`pointerup`)に保持する `snapshot`(`ctx.getImageData()`)と、非同期に
  Canvas を書き換える経路(新規キャプチャ完了 `capture://completed` → `handleCaptureCompleted`、または
  履歴サイドバーの再読込 `reloadHistoryItemIntoCanvas`)が一切同期していない。
  **理由**: `bindArrowTool`/`bindMosaicTool` は `pointerdown` 時点でのみ `canvasState.image` を確認し
  (`arrowTool.ts:172-176`, `mosaicTool.ts:261-265`)、以降 `pointermove`/`pointerup` は自分のローカル変数
  `start`/`snapshot` だけを見て動作する。一方 `handleCaptureCompleted`(`main.ts:55-76`)は
  `getCanvasState().isDrawing` を一切確認せずに `canvas.width`/`height` を変更し新しい画像を描画する。
  **再現条件**: (1) 矢印ツールで Canvas 上を `pointerdown` したまま(ボタンを離さない)、(2) その状態で
  別経路のキャプチャ完了(グローバルショートカット `Cmd+Shift+2` はキーボード入力でありマウスボタン押下
  と独立に発火できる。あるいはキーボードで履歴サイドバーの別項目にフォーカスして Enter/Space で
  `handleItemClick` を発火させれば同じ結果になる。`sidebar.ts` のボタンは通常の `<button>` なのでキーボード
  操作可能)、(3) その後 `pointerup` でドラッグを終了する。`finishDrag`(`arrowTool.ts:208-232`)は
  古い(サイズ・内容とも別画像時点の)`snapshot` を `ctx.putImageData(snapshot, 0, 0)` で新しい画像の上に
  上書きしたうえで矢印を焼き込み、確定させてしまう。結果、`canvasState.image.assetUrl` は新キャプチャ/
  新履歴項目を指しているにもかかわらず、実際に画面へ表示され「クリップボードにコピー」される
  Canvas ピクセルは古い画像と新しい矢印が混在した内容になる(FR-006/FR-008 の「Canvas に確定焼き込み」
  という受け入れ基準が、ユーザーには気づかれないまま実質的に破られる)。
  **修正案**: `pointermove`/`finishDrag` の冒頭で `getCanvasState().image`(または画像の identity/寸法)が
  `pointerdown` 時点と変わっていないかを確認し、変わっていれば `start`/`snapshot` を破棄してそのフレームの
  描画・焼き込みを中止する。あるいは `subscribeCanvasState()` で画像変更を監視し、ドラッグ中に変更を
  検知したら即座に `finishDrag` 相当のキャンセル処理(`start = null; snapshot = null; setDrawing(false)`)を
  呼ぶ。

- [ ] `src/ui/sidebar.ts:41-57`(`handleItemClick`)、`src/history/historyStore.ts:190-204`
  (`updateSelectedItemImage`)
  複数の `handleItemClick` 呼び出しが並行に走ることを想定しておらず、`state.selectedId` を
  TOCTOU(time-of-check-to-time-of-use)的に読むため、選択切替を連続して行うと**無関係の履歴項目へ
  誤った画像データを上書きする**。
  **理由**: `renderItemView`(`sidebar.ts:59-84`)は各サムネイルボタンに
  `() => { void handleItemClick(item, callbacks); }` を素朴にバインドするだけで、実行中フラグ等の排他制御が
  一切無い。`handleItemClick` は `await callbacks.captureCurrentAssets()`(内部で `canvas.toBlob()` を2回
  呼ぶ非同期処理)の**後**に `updateSelectedItemImage(assets)` を呼ぶが、この時点で参照する
  `state.selectedId` はグローバル可変状態であり、await 中に他の `handleItemClick` 呼び出しが
  `selectHistoryItem()` で書き換えている可能性がある。
  **再現条件**: 履歴に項目 A(選択中)・B・C があるとする。B のサムネイルをクリックした直後(await 中、
  `captureCurrentAssets()` が解決する前)に C のサムネイルもクリックする(高速な連続クリックで再現可能。
  自動テストなら `handleItemClick` を2回連続で `await` せずに呼べば決定的に再現する)。
  1. B クリック: `current = A`。`captureCurrentAssets()` 開始(await)。
  2. C クリック: この時点で `state.selectedId` はまだ `A`(B クリック側がまだ `selectHistoryItem` を
     呼んでいない)。`current = A` と誤認し、同じく `captureCurrentAssets()` を開始(await)。
  3. B クリック側が先に解決 → `updateSelectedItemImage()` は `selectedId === A` を見て A を正しく上書き
     → `selectHistoryItem("B")` → `selectedId = B` → `reloadImage(B)`。
  4. C クリック側が解決 → `updateSelectedItemImage()` は**今や `selectedId === B`** を見て、**A の
     キャンバス内容(B クリック時点で撮ったスナップショット)を B の image/thumbnail として上書き**して
     しまう(`replaced` として B の正しい画像は revoke されて失われる)。→
     `selectHistoryItem("C")` → `reloadImage(C)`。
  最終的に画面は C を表示し矛盾なく見えるが、**B の履歴データが恒久的に A の内容へすり替わる**
  (次に B をクリックすると誤った画像が Canvas に再読み込みされる)。ObjectURL 自体の二重 revoke や
  リークは発生しない(生成・revoke の対応は取れている)が、FR-010「項目クリックでその画像が
  Canvas に再読み込みされる」という受け入れ基準に反するデータ破損が起きる。
  **修正案**: `handleItemClick` 全体を1つの直列化された処理列(例: 前の呼び出しの Promise を保持し、
  新しい呼び出しは前の完了を待ってから開始する簡易ミューテックス、または処理中は他のサムネイル
  ボタンを `disabled` にする)にする。加えて `updateSelectedItemImage` を呼ぶ直前に
  「captureCurrentAssets 開始時に selectedId として捉えていた id」と「今の `state.selectedId`」が
  一致するかを確認し、不一致なら書き込みを破棄する防御も入れる。

- [ ] `output/tasks/TASK_tadcap_mvp.md:192-195`(T18 受け入れ条件)、
  `testreport/manual/CHECKLIST_T18.md`(全28項目 `☐` 未実施)、
  `testreport/nfr-001/result-20260923.md`(中間計測のみ、リリースビルドでの最終計測が無い)
  T18(最終検証)の受け入れ条件は「手動確認チェックリスト全項目が実行され結果(pass/fail)が
  `testreport/` に記録されている」ことだが、`CHECKLIST_T18.md` は全項目が未チェック(`☐ pass ☐ fail`
  のまま)であり、NFR-001 の最終計測(リリースビルドでの 10 回試行中央値)・NFR-002 の実機3点確認・
  グローバルショートカットの実機衝突確認・トレイ/ウィンドウクローズ後のプロセス継続・実クリップボード
  貼付など、いずれも実施記録が無い。`AGENTS.md`「完了報告には証拠を添える…証拠のない『完了』は禁止」
  にも反する。
  **理由**: `testreport/t18/summary.txt` はスモークテスト(build/vitest/cargo test/clippy/e2e)の自動実行
  ログのみで、これは T01〜T17 の各タスクの受け入れ条件を満たす自動検証に過ぎず、T18 固有の受け入れ条件
  (実機手動確認)を満たす証跡ではない。またフル `tauri build`(app+dmg)は exit=1 で失敗しており
  (`--bundles app` のみで再実行して成功)、DMG ターゲット(`tauri.conf.json` の
  `bundle.targets: ["app", "dmg"]`)が実際にビルド可能であることも未確認。
  **修正案**: 実機 macOS で `CHECKLIST_T18.md` の 28 項目を実施し、pass/fail とメモ(NFR-001 の
  中央値実測値を含む)を記入して保存する。DMG ビルドの失敗原因(署名・Finder 自動化権限等、環境依存か
  実装起因かの切り分け)を明記し、未解決なら `output/tasks/PROGRESS.md` へ申し送る。Gate5(検証)は
  この記録が揃うまで完了と見なさない。

### SHOULD(推奨修正)

- [ ] `src-tauri/src/commands.rs:104-125`(`run_capture`)、`src/ui/captureButton.ts:36-55`
  `try_begin_capture()` が `false`(他起点が実行中)の場合、`run_capture` は `Ok(None)` を返して
  何もしない。アプリ内ボタン起点(`capture_screen` → `handleCaptureClick`)はこの `None` を
  「Esc キャンセルと同じ正常系」として扱い、ステータス欄・ボタン状態のどちらにも「別のキャプチャが
  進行中のため無視された」旨のフィードバックが出ない。**理由**: ユーザーがボタンを押したのに何も
  起きない(無反応に見える)体験は、正当な多重起動防止の意図を損なう。**修正案**: `capture_screen`
  の戻り値が `null` かつ Esc キャンセルと区別したい場合、専用のフィードバック文言(例:
  「別のキャプチャが進行中です」)を出す分岐を追加する(現状は Esc とキャンセル理由が区別できない
  設計のため、最低限どちらであっても軽微なトースト表示を検討)。

- [ ] `src/main.ts:55-76`(`handleCaptureCompleted`)、`src/history/historyStore.ts`
  セッション内履歴は「捕捉直後」(`handleCaptureCompleted` 内の `captureHistoryAssets`)と「明示的な
  保存点」(`sidebar.ts` の項目切替直前、または `clipboardButton.ts` のコピー成功時)の2箇所でしか
  `image`/`thumbnail` を更新しない。**理由**: ユーザーが画像 A を撮影 → 矢印/モザイクを加える →
  クリップボードへコピーも履歴切替もせずに次の画像 B を撮影、という操作をすると、A の履歴エントリは
  「未編集の生画像」のまま固定される(編集内容が失われる)。PRD §10 決定#3「編集後(マークアップ済み)
  画像を保持・再読込する」という決定の趣旨から見ると、暗黙の保存タイミングに強く依存した設計になって
  いる。**修正案**: 新規キャプチャ到着時にも、直前の `canvasState.image` が存在すれば
  `updateSelectedItemImage()` 相当の上書きを行ってから新画像を反映する(`sidebar.ts` の
  「切替直前に上書きする」パターンを `handleCaptureCompleted` にも適用する)。

- [ ] `src/ui/sidebar.ts`(テストファイル無し)
  `handleItemClick` は DOM 要素を直接操作しておらず、`SidebarCallbacks`(`captureCurrentAssets`/
  `reloadImage`)を外部から注入できる設計になっている(`ipc/capture.ts` のモックテストと同じパターンが
  適用可能)にもかかわらず、`initSidebar`/`handleItemClick` を対象にした `*.test.ts` が存在しない。
  **理由**: MUST-2 の競合状態は、まさにこの未テストの非同期オーケストレーションロジックに潜んでいた。
  `docs/docs/development-patterns.md` §1 が謳う「状態遷移の純粋関数はテスト、ストア/購読は
  `ui/` が担う」という設計方針上も、`handleItemClick` は DOM 非依存の部分(選択判定・呼び出し順序)を
  切り出してテスト可能なはずである。**修正案**: `handleItemClick` をエクスポートし、
  フェイクの非同期 `captureCurrentAssets`/`reloadImage`(`vi.fn()` + 手動 resolve タイミング制御)を注入して、
  同一項目への連打で1回のみ処理されること・異なる項目への連続クリックで前の呼び出しが完了してから
  次を処理することを Vitest で検証する。

- [ ] `src-tauri/src/tray.rs:70-72`(`show_and_focus_main_window`)、`src-tauri/src/tray.rs:127`
  (`focus_main_window_on_main_thread`)、`src/main.ts:71-75, 141-145`(`catch` ブロック)
  複数箇所でエラーが握りつぶされ、診断情報が失われている。**理由**: `let _ = window.show();` /
  `let _ = window.set_focus();` / `let _ = app.run_on_main_thread(...)` はいずれも失敗を無視するため、
  ウィンドウが前面化しない不具合が起きても手がかりが残らない。フロントエンドの `catch { ... }` も
  実際の `Error` オブジェクトを握りつぶし、`statusEl.textContent` に固定文言を出すのみで
  `console.error` 等のログを残していない。**修正案**: Rust 側は `if let Err(e) = ... { eprintln!(...) }`
  程度の最小ログを追加する(`shortcuts.rs` の登録失敗時と同じ方針)。フロントエンドは
  `catch (error) { console.error(error); ... }` として実エラーをコンソールへ残す。

- [ ] `src-tauri/src/commands.rs:20-23`, `src-tauri/src/lib.rs:69`
  スキャフォールド由来の `greet` コマンドが `invoke_handler` に残ったままで、フロントエンドからは
  一切呼ばれていない(`src/` 全体を検索しても `greet`/`invoke("greet"` の参照は無い)。**理由**:
  NFR-003(軽量性・YAGNI)の方針、および T18 で MVP が完成した現時点では、未使用の IPC サーフェスを
  残す理由がない(小さいがコードレビュー対象・攻撃面が意味なく増える)。**修正案**: `greet` と
  対応するテストを削除するか、削除しない場合はその理由(スキャフォールド保持の意図)を
  `project-config.md` §11 に一言残す。

### CONSIDER(検討)

- [ ] `src-tauri/src/capture/mod.rs:178-196`(`ensure_screen_recording_access`)、
  `src/main.ts:227-232` 起動のたびに画面収録権限が未許可なら毎回 `CGRequestScreenCaptureAccess`
  (OS ダイアログ)を呼ぶ。ユーザーが一度拒否した後も起動するたびにダイアログが出うる。意図的な
  設計(PJM決定 2026-09-23、`capture/mod.rs` doc 参照)ではあるが、体験としては煩わしくなりうるため、
  将来的にセッション内で一度だけ試行する等の緩和を検討してもよい。

- [ ] `testreport/t18/summary.txt:7-9` フル `tauri build`(`bundle.targets: ["app", "dmg"]`)が
  exit=1 で失敗し、`--bundles app` のみで再実行して成功している。環境要因(署名・Finder 自動化権限)
  と推測されているが未確定のため、実機の通常権限を持つ macOS で DMG ビルドが成功することを確認して
  おくとよい(リリース手順に関わるため)。

- [ ] `src-tauri/capabilities/default.json` は `core:default` を含んでいるが、実際に呼ばれるコマンドは
  `capture_screen`/`check_screen_recording_permission`/`open_screen_recording_settings`/
  `write_image_fallback`(自前コマンドのため ACL 対象外、`docs/docs/development-patterns.md` §9.7 の
  判断どおり)のみである。`core:default` が実際にどの機能(window 操作等)を許可しているかの
  棚卸しは T17 で行われた形跡があるが、将来コマンドが増えた際に見落とさないよう定期的な再棚卸しを
  推奨する。

## 良い点

- **並行処理の設計が一貫して正しい**: 3起点(ボタン/トレイ/ショートカット)共有の `CAPTURE_IN_PROGRESS`
  (`AtomicBool::compare_exchange`, `commands.rs:39-54`)、`spawn_blocking` によるブロッキング処理の
  退避、`run_on_main_thread` によるウィンドウ操作の退避(`tray.rs:107-128`)が、コメントで挙げられた
  設計意図(T16 で PJM が指摘したメインスレッド閉塞問題)どおりに実装されており、`end_capture()` の
  呼び出しが早期リターンより前に必ず実行される(フラグのリーク無し)ことをコードから確認できた。
- **CoreGraphics FFI が模範的**: `capture/permission.rs` は `unsafe` を2関数の呼び出しのみに閉じ込め、
  `SAFETY:` コメント、`c_uchar` での安全な受け取り、`#[cfg(target_os = "macos")]` の徹底など、
  ARCH §15/§12 の決定を忠実に実装している。
- **レイヤー依存方向の逸脱が皆無**: `src/canvas/`・`src/history/`・`src/ipc/`・`src/ui/` の import を
  すべて確認したが、ARCH §3.2 の依存方向ルール(`canvas`/`history`/`ipc` は `ui` に依存しない、等)への
  違反は1件も見つからなかった。`#[tauri::command]` も `commands.rs` に一元化されている。
- **docs/docs と実装が高精度で同期している**: RGBA8 への設計変更(ARCH §5.2 からの逸脱)、
  asset protocol scope の canonicalize 補強(symlink 問題)、`[hidden]` の `!important` 修正など、
  実装時に生じた設計逸脱・バグ修正のいずれも `docs/docs/development-patterns.md` に理由付きで記録
  されており、今回のレビューで実装との齟齬は見つからなかった。
- **E2E テストが実際の振る舞いを検証している**: `e2e/capture-flow.spec.ts` は矢印色のピクセル判定・
  モザイク前後のピクセル差分検証など、DOM の存在確認に留まらない実質的なアサーションを行っている。

## 総合判定

- **条件付き承認(MUST修正後)**
  MUST-1・MUST-2 は MVP のコア機能(矢印/モザイク編集、履歴切替)におけるデータ破損バグであり、
  アーキテクチャ全体の見直しは不要(局所的な排他制御・整合性チェックの追加で修正可能)。MUST-3 は
  実装の欠陥ではなく Gate5 の検証証跡が未整備という手続き上のギャップ。これら3件の解消を条件に承認可。
