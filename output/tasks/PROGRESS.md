# 進捗引き継ぎノート — Tadcap MVP(TEAM_PJM フルライフサイクル)

> **再開手順(セッションリミット等で中断した場合)**: 新しいセッションで次を入力するだけでよい。
> `.claude/teams/TEAM_PJM.md docs/requirements.md 再開。output/tasks/PROGRESS.md の「次にやること」から続行`
> PJM は §2 のフェーズ表で最初の未完了行を探し、成果物ファイルが既にあれば**作り直さず検証から**再開する。
> 各ステップ完了のたびに本ファイルを更新する(フェーズ表の状態列 + §4 ログ)。行の削除は禁止。

## 1. 現在の状態

| 項目 | 内容 |
| ---- | ---- |
| 最終更新 | 2026-09-24(v0.1.2 公開済み。ゲート4 = 人間がリリース版で実機確認中) |
| 入力 | `docs/requirements.md`(要求メモ・ドラフト) |
| 承認モード | 通常(各ゲートで人間承認を待つ) / 実装モード: 逐次 |
| ブランチ | `main`(origin = https://github.com/froggugugugu/tadcap、push 済み)/ 作業用 `feat/mvp` |
| スモークテスト | `npm run build && npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings && npm run e2e`(Bash では先頭に `. "$HOME/.cargo/env" &&`。e2e は T13 以降) |
| 実行順 | T01→T02→T03→T04→T05→T06→T07→**T15→T16**→T08→T09→T10→T11→T12→**T14→T13→T19**→T17→T18(ID は不変、T15/T16 を前倒し。E2E が履歴 UI も含められるよう T14 を先に) |
| タスク進捗 | T01〜T31 すべて実装済み・自動検証 green(vitest 323 / cargo 109 / e2e 27)。手動チェックリスト `testreport/manual/CHECKLIST_T18.md` 41 項目は人間の実施待ち |
| 既知の壊れている箇所 | なし(自動検証 green)/ Rust は Bash で先に `. "$HOME/.cargo/env"` が必要 / `docs/project.md` 等 4 ファイルは `docs/docs/` 配下(CLAUDE.md の `@docs/*.md` と不一致) |

## 2. フェーズ表(状態列のみ更新)

状態: ⬜ 未着手 / 🔄 作業中 / ⏸ ゲート承認待ち / ✅ 承認済み / ⏭ スキップ

| Phase | 内容 | 担当 | 成果物 | 状態 |
| ----- | ---- | ---- | ------ | ---- |
| 0 | brainstorm(条件付) | アナリスト | — | ⏭(メモは半ページ超・非対象も明記。未決事項は PRD で【要確認】化) |
| 1 | PRD 生成 | アナリスト `/prd` | `output/prd/PRD_tadcap_mvp.md` | ✅(生成済み・11 セクション充足) |
| G1 | ゲート1: PRD 承認 | 人間 | — | ✅(2026-09-23 通過。PRD 反映済み・未解決【要確認】0) |
| 2 | アーキテクチャ設計 | アナリスト `/architecture` | `output/design/ARCH_tadcap_mvp.md` | ✅(384 行・16 セクション) |
| G2 | ゲート2: 設計承認 | 人間 | — | ✅(2026-09-23 通過。ARCH 反映済み・未解決【要確認】0) |
| 3 | タスク分解 | プランナー `/plan` | `output/tasks/TASK_tadcap_mvp.md` | ✅(T01〜T18、317 行) |
| G3 | ゲート3: タスク分解承認 | 人間 | — | ✅(2026-09-23 通過。lint=clippy のみスモークに追加 / CI なし / T15・T16 を T07 直後に前倒し) |
| 4 | 実装(逐次・1 タスクずつ) | 開発者 `/implementing-features` | `src/` `src-tauri/` + §1「タスク進捗」 | ✅(全 19 タスク実装済み・自動検証 green) |
| G4 | ゲート4: テスト全パス | 人間 | `testreport/manual/CHECKLIST_T18.md` | ⏸(手動確認 28 項目の結果待ち) |
| 5 | 検証(review / security / legal / e2e / perf) | レビュアー・テスター | `output/reports/**` | 🔄(review/security/legal 完了 → 指摘修正 F1/F2 中。perf 未) |
| G5 | ゲート5: レポート承認 | 人間 | — | ⬜ |
| 6 | 完了報告 | PJM | — | ⬜ |

## 3. 次にやること(優先順)

**B1 ✅(②〜⑤ 人間確認 OK)/ B2 ✅(人間の実機確認 OK)/ F1 ✅ / 追加機能の PRD・ARCH 改訂 ✅(FR-006 改訂・FR-007/011〜014)→ 人間確認 ✅(#9〜12 すべて推奨)→ タスク分解 ✅(T20〜T30)→ **T20〜T24 ✅ / T25 ✅ / 矢印の太さ調整 ✅(人間の見た目確認待ち)/ T26 ✅ / **T31 ✅・T27 ✅(いずれも人間の実機確認待ち)→ T28 ✅・T29 ✅ → T30 ✅。**追加機能の実装完了 → ゲート4(人間の実機確認 41 項目)待ち**(人間要望: 矢印をもっと太くインパクトある形に。終点胴幅 2000px 画像で 20px 前後、大きめ矢じり、薄いドロップシャドウ → T25 担当に追加)→ T24→…→T30 は逐次**

**追加要望(2026-09-24)**: メニューバー常駐アイコンをモノクロのオタマジャクシ形に(macOS テンプレート画像)→ ✅ 実装済み(`src-tauri/icons/tray/tadpole@2x.png` をテンプレート画像で表示。プレビュー `output/reports/ui/tray-icon-preview.png`)、人間の実機確認待ち → 足 2 本を追加済み(プレビュー更新、PJM 目視では 18pt で足 1 本に見える可能性あり → 人間の判断待ち)

**追加機能の人間決定(2026-09-24)**: ①矢印を始点から終点へ徐々に太くなるテーパー形状に ②矩形枠 ③円(楕円)枠 ④テキスト挿入(フォントサイズは小・中・大の 3 段階を一括指定、解像度から実寸算出)⑤色の一括指定(プリセット色見本+ macOS カラーピッカー)⑥取り消し Cmd+Z。注釈は焼き込みのまま(色・サイズ変更はこれから描くものにだけ効く)。F-06b(枠・テキスト)を MVP に昇格

0. **使用率ガード(2026-09-24 19:20 人間指示で停止。Pro 契約に切替)**: 以下は参考記録。 5h 使用率が 95% 以上なら新しい subagent を起動せず、リセット(0%)まで待つ。確認元 `~/.claude/vscode-claude-status-cache.json` の `utilization5h`。監視スクリプト: セッションの scratchpad の `usage-watch.sh` v2(セッションが切り替わったら新しい scratchpad にコピーして再起動)(人間指定: 3 分間隔・しきい値 95%。安全策として次回予測 98% 以上でも PAUSE。v1 の 15 分間隔では 91%→100% に飛び検知が間に合わなかった)

1. G4 — 人間が `testreport/manual/CHECKLIST_T18.md` を実施。fail 項目があれば 1 件ずつ開発者に修正させ、スモーク(e2e 含む)緑を確認
2. G4 で人間に確認: 履歴上限 50 件【仮定】/ DMG 生成の要否 / コミット方針 / T19 新 UI の好み
3. Phase 5 指摘修正(並行、ファイル非重複):
   - **F1(フロント)✅ 完了**: review MUST-1(ドラッグ中の Canvas 差し替えで古いスナップショットに焼き込み)/ MUST-2(履歴連続クリックの競合で誤上書き)/ SHOULD-2(新規キャプチャ到着時に直前の編集を履歴へ保存)/ SHOULD-3(sidebar のテスト)/ SHOULD-4(main.ts の握りつぶし)。docs 更新は F1 のみ
   - **F2(Rust)✅ 完了**: security HIGH(`write_image_fallback` の checked 演算+上限)/ review SHOULD-4(tray.rs のエラーログ)/ SHOULD-5(未使用 greet 削除)/ `.gitignore` に `.env*`
   - **人間決定(2026-09-24)**: 一時キャプチャファイルは自動削除(起動時と終了時に `tadcap-captures/` を空にする)。ARCH §12 の「MVP 未クリーンアップ」を改訂。実装は F2 に追加
   - 見送り: review SHOULD-1(多重起動で無視された要求のフィードバック)は Rust/TS 双方の変更が要り効果小 → MVP 後 / legal の NOTICE・cargo-deny・Info.plist 確認は公開準備タスクへ
   - review MUST-3(手動チェックリスト未実施)は G4 の人間作業そのもの
4. 修正完了後 performance 計測 → ゲート5

**ゲート2 決定(2026-09-23 人間回答)**: #1 権限チェックは自前 FFI(CGPreflight/CGRequestScreenCaptureAccess)、設定画面は既存 opener で開く / #2 Capture.kind は常に range / #3 fallback は arboard / #4 E2E は Playwright+IPC モック、実機確認は手動チェックリスト

**ゲート1 決定(2026-09-23 人間回答)**: #1 保存機能なし / #2 B案: capture を trait で抽象化し差し替え可能に、SCK 移行は Phase 4 の起動レイテンシ実測で判断 /
#3 編集後画像を保持・再読込 / #4 モザイクのみ / #5 200ms 未満 / #6 B案(PJM 推奨): アプリ内で権限を事前確認し「システム設定を開く」導線 /
#7 F-04 を MVP に含める(既定キー Cmd+Shift+2 等の空きキー、変更 UI は MVP 外) / #8 ライトテーマ固定 / 追加: F-08 メニューバー常駐も MVP に含める(Dock アイコンは非表示で確定)

## 4. セッションログ(新しいものを上に)

### 2026-09-24 — v0.1.1 / v0.1.2 リリース

- **v0.1.1**: アプリアイコンとロゴを案 A(ファインダー記号+テーパー矢印)に。Releases に DMG 2.7MB / zip 2.4MB、インストーラーで導入・codesign OK・版 0.1.1
- **v0.1.2**: メニューバーのアイコンを案 A の白黒テンプレート版(`src-tauri/icons/tray/viewfinder-arrow@2x.png`)に。Releases に DMG / zip、インストーラーで導入・codesign OK・版 0.1.2
- **次**: 人間がリリース版で CHECKLIST_T18(41 項目)を確認中

### 2026-09-24 — v0.1.0 リリース

- **やったこと**: アプリアイコン(オタマジャクシ)一式、ad-hoc 署名(`signingIdentity: "-"`)の DMG/zip(`scripts/package-mac.sh`、`CI=true` で Finder 自動化を回避)、`scripts/install.sh`(sha256 照合)、`release.yml`(build/publish 分離)、紹介ページ・README のインストール節を更新。5 コミット → main push → `v0.1.0` タグ push
- **結果**: release ワークフロー build/publish 成功。Releases に `Tadcap-0.1.0-arm64.dmg`(2.38MB)と `.zip`(2.24MB)。公開された install.sh をパイプ実行して一時ディレクトリに導入 → exit 0、codesign OK、版 0.1.0、quarantine 無し
- **未追跡のまま**: `npm run tauri icon` が生成した `src-tauri/icons/{android,ios,64x64.png}`(削除は deny ルールで拒否されたため add せず残置。人間が削除してよい)
- **人間の要望**: アイコンをキャプチャを連想させる幾何学デザインに(mdslide 参考)→ 3 案 `output/reports/ui/icon-candidates.png`、PJM 推奨 A

### 2026-09-24 — GitHub へ公開

- **人間**: リポジトリ froggugugugu/tadcap を作成し「後はできるかな」
- **やったこと**: 公開前点検(秘密情報・第三者製品名なし、`.vitest/` を ignore、レポート内の絶対パスを除去)→ `feat/mvp` で 6 コミット → main を早送り → GitHub 側の初期コミット(LICENSE、内容同一)を unrelated histories で統合 → push(force なし)→ Pages を GitHub Actions で有効化 → pages ワークフロー成功 → https://froggugugugu.github.io/tadcap/ ほか 6 URL が 200。Lucide のライセンス表記を v1.45.0 原文に修正して追加 push

### 2026-09-24 — 紹介ページ完成(未公開)

- **やったこと**: `.github/pages/index.html`(ヒーロー・流れ・機能・ツールバー・インストール・初回設定・使い方・FAQ、ダーク対応)、`_config.yml`(baseurl /tadcap)、`.github/workflows/pages.yml`、README 全面更新、THIRD_PARTY_NOTICES.md、`docs/media/`(editor/annotated/toolbar/permission/icon)
- **検証(PJM 再実行)**: build 0 / vitest 0 / e2e 0。PJM がヒーローと使用例画像を目視確認
- **公開は人間待ち**: GitHub リポジトリ作成 → push → Settings > Pages = GitHub Actions。【仮定】Lucide の著作権年は公開前に上流 LICENSE と照合

### 2026-09-24 — 紹介ページ作成に着手

- **人間の依頼**: mdslide(`../mdslide/.github/pages/` + `pages.yml`)と同じ方式で紹介ページ(インストール方法・使い方つき)を作る
- **やったこと**: 担当(Opus)に委任。`.github/pages/`・`.github/workflows/pages.yml`・README 全面更新・架空画面のスクショ。tadcap には git remote が無いため URL は https://github.com/froggugugugu/tadcap / https://froggugugugu.github.io/tadcap/ と仮置き。配布ビルドは無いので「ソースからビルド」を正直に記載

### 2026-09-24 — T30 完了(追加機能すべて完了)

- **やったこと**: `e2e/annotation-tools.spec.ts`(横断 5 シナリオ)、共通待機 `e2e/fixtures/captureReady.ts` で既存 spec の `canvas.width>0` 競合を解消、チェックリストに #29〜#41 を追記
- **検証(PJM 再実行)**: build 0 / vitest 0(323) / cargo test 0(109) / clippy 0 / e2e 0(27)。repeat-each 5 で 130/130(テスター報告)

### 2026-09-24 — T28・T29 完了

- **T28**: colorPicker(6 色 #FF5C8A/#FF3B30/#FF9500/#FFCC00/#34C759/#007AFF + OS カラーパネル)、fontSizePicker(A アイコン 2/3:1:1.5)。`isEditableTarget` が type=color の INPUT で真になり Cmd+C/Z が効かなくなる不具合を修正
- **T29**: undoButton(Cmd+Z / Cmd+Shift+Z / ボタン)。編集中図形は取り消し=破棄、その間やり直しは無効。E2E で 3 操作の取り消しが元画像とバイト一致
- **検証(PJM 再実行)**: build 0 / vitest 0(323) / cargo test 0(109) / clippy 0 / e2e 0(22)
- **既知(報告のみ)**: テキスト入力中に取り消しボタン → 確定後に取り消されて文字が消える(やり直しで戻せる)/ 既存 E2E に `canvas.width > 0` 待機の競合余地

### 2026-09-24 — T27 完了

- **やったこと**: textTool.ts(単一行 input、Enter/blur 確定・Esc 取消・IME 中 Enter 無視、フォント実寸 = clamp(round(対角×0.024),18,128)×{2/3,1,1.5}、太さ 600、影は矢印と同トーン)、ToolId に text、E2E 5 件、スクショ `output/reports/ui/text-*.png`
- **検証(PJM 再実行)**: build 0 / vitest 0(300) / cargo test 0(109) / clippy 0 / e2e 0(13)

### 2026-09-24 — T31 完了

- **やったこと**: `shapeEdit.ts`(純粋関数)/`pendingShape.ts`(ストア)/`tools/shapeTools.ts`(共通結線+ハンドルのオーバーレイ canvas)/`ui/pendingShapeKeys.ts`(Enter 確定・Esc 破棄)。確定トリガー: 次の図形・空白/Canvas 外クリック・ツール切替・モザイク・コピー・新規キャプチャ・履歴切替。矢印 1.5 倍(0.0135・9〜72px)。E2E 5 件追加、スクショ `output/reports/ui/edit-*.png`
- **検証(PJM 再実行)**: build 0 / vitest 0(276) / cargo test 0(109) / clippy 0 / e2e 0(8)
- **申し送り**: T29 は編集中なら `discardPendingShape()`、有効判定 `canUndo()||hasPendingShape()` / T27 は配置前に `commitPendingShape()` / 【仮定】色は描いた時点で固定

### 2026-09-24 19:20 — 人間の実機確認と追加要望

- **人間**: Pro に切替、使用率チェックは停止。実機確認済み。矢印はさらに 1.5 倍太く。矩形・円・矢印は配置後にリサイズしたい
- **決定(AskUserQuestion)**: 編集できるのは直前に描いた 1 つだけ(次の図形・ツール切替・コピー・Enter/Esc・画像外クリック等で確定焼き込み)/ リサイズに加えて移動も入れる
- **計画**: T31 を新設し T27 より先に実装(ツールの基本パターンが「pointerup で即焼き込み」から「確定まで保留」に変わるため)

### 2026-09-24 — T26 完了

- **やったこと**: ellipseTool.ts(外接矩形→楕円、Shift で正円【仮定】、太さは矩形と同式)、ToolId に ellipse、スクショ `output/reports/ui/ellipse.png`
- **検証(PJM 再実行)**: build 0 / vitest 0(231) / cargo test 0 / clippy 0 / e2e 0
- **人間確認待ち**: 矩形・円の枠線の太さ(現状 2000px 画像で約 7px)を太い矢印に合わせるか

### 2026-09-24 — 矢印の太さ改訂完了

- **やったこと**: 終点胴幅 = 対角×0.009(6〜48px)、矢じり 胴×3 / 幅 胴×2.4(直交オフセット方式)、始点 胴×0.15、影 rgba(0,0,0,0.35)。スクショ `output/reports/ui/arrow-taper-{2000x1000,5120x2880,400x300}.png`
- **検証(PJM 再実行)**: build 0 / vitest 0(211) / cargo test 0(109) / clippy 0 / e2e 0(3)。PJM 目視で太いテーパー+影を確認

### 2026-09-24 — T25 完了

- **やったこと**: 矩形枠ツール、cropSnapshotRect/roundRect を coords.ts へ集約、スクショ `output/reports/ui/rectangle.png`
- **検証(PJM 再実行)**: build 0 / vitest 0 / cargo test 0 / clippy 0 / e2e 0
- **事象**: 矢印の太さ調整の途中で開発者のコマンド実行が権限判定で拒否され、未検証の変更を戻して報告 → 同じ設計(終点胴幅 = 対角×0.009、6〜48px、矢じり 胴×3 / 幅×2.4、始点 ×0.15、薄い影)で再開を指示。再度拒否されたら回避せず報告させる

### 2026-09-24 — 矢印の太さ要望

- **人間の要望**: テーパー矢印の終点が細すぎる、もっとインパクトを。→ 終点胴幅を大幅に引き上げ、矢じり拡大、薄いドロップシャドウ。arrowTool.ts を触る T25 担当に追加依頼(同一ファイルの同時編集を避けるため)

### 2026-09-24 — T24 完了

- **やったこと**: `computeTaperArrowPolygon`(7 頂点、始点太さ=終点×0.25)、色は toolSettings、矢印・モザイクに pushUndoStep、画像差し替え後に clearUndoStack、スクショ `output/reports/ui/arrow-taper.png`
- **検証(PJM 再実行)**: build 0 / vitest 0(191) / cargo test 0(109) / clippy 0 / e2e 0(3)
- **PJM 目視**: テーパーは出ているが全体に細く矢じりが小さい → 人間に太さの好みを確認中
- **T25 への指示**: cropSnapshotRect/roundRect が 2 か所複製 → 3 か所目になるので coords.ts へ集約

### 2026-09-24 — T23 完了

- **やったこと**: `src/canvas/undoStack.ts`(差分方式・上限 30、`pushUndoStep` / `popUndo(current)` / `popRedo(current)` / `clearUndoStack`)。pop 側は呼び出し側が現在ピクセルを渡す設計(Redo 用)
- **検証(PJM 再実行)**: build 0 / vitest 0(175) / cargo test 0(109) / clippy 0 / e2e 0(3)
- **申し送り(T24〜)**: 焼き込み直前に `pushUndoStep`、画像差し替え完了後に `clearUndoStack`、undoStack.ts 独自の Rect/ImageDataLike は coords.ts に統一

### 2026-09-24 — T20〜T22 完了

- **やったこと**: Rect 系を coords.ts へ移設、`src/canvas/toolSettings.ts`(色・フォントサイズ、既定ピンク・中)、`src/ui/shortcutGuards.ts::isEditableTarget` 抽出
- **検証(開発者報告)**: build 0 / vitest 175 passed / e2e 3 passed(T23 分含む)。PJM の再実行は T23 完了後にまとめて行う

### 2026-09-24 17:40 — 再開

- **状態確認**: 使用率 0%。途中停止の影響で build exit 2 / vitest 6 件失敗(isEditableTarget 移設途中)を確認 → T20〜T22・T23 の開発者を同文脈で再開
- **人間の要望**: トレイのオタマジャクシに小さな足 → アイコン担当を再開
- **監視 v2.1**: キャッシュが 30 分更新されない(使用停止中)ときに終了していた → 警告のみに変更

### 2026-09-24 — 使用率 PAUSE

- **事象**: 監視が PAUSE(util 90%、予測 98% 超)。T20〜T22(clipboardButton.test.ts の移設途中)と T23 を途中停止。途中の編集はディスクに残る
- **再開手順**: 17:30 以降、`git status`/`npm run test:run` で状態確認 → 停止した 2 人の開発者に続きを依頼(同文脈で再開できない場合は同じ指示で新規起動し「途中編集あり」と伝える)

### 2026-09-24 14:10 — セッション切替後の再開

- **確認**: トレイアイコン完了(cargo test 109 / clippy 0 / build 0 と報告)。当初プランナーは切替前に T20〜T30 まで記載済みだった(確認が早すぎて未記載と誤認し再実行→重複編集前に停止。ファイルに重複なしを確認)。監視スクリプトを新 scratchpad で再起動。§1 の古い記述を整理

### 2026-09-24 — B2 実機 OK / 追加機能 承認

- **人間の確認**: B2 前面表示 OK。追加機能 #9 Redo あり / #10 単一行・Enter/blur 確定 / #11 6 色プリセット / #12 フォント実寸は実装時確定 — すべて推奨で承認
- **新要望**: トレイアイコンをモノクロのオタマジャクシ形に

### 2026-09-24 — 追加機能の PRD/ARCH 改訂完了

- **やったこと**: PRD に FR-006 改訂(テーパー)、FR-007 矩形(MVP 化)、FR-011 円、FR-012 テキスト、FR-013 色、FR-014 取り消し。ARCH にテーパー多角形塗り、Undo 差分方式(変更矩形のみ+上限 30 件)、Rect 系を coords.ts へ共通化、`toolSettings` を色の真実源、`shortcutGuards.ts::isEditableTarget()`
- **人間確認待ち**: #9 Redo(推奨: 入れる)/ #10 テキストは単一行・Enter/blur で確定(推奨)/ #11 色プリセット 6 色(推奨)/ #12 フォント実寸は目安に留め実装時確定(推奨)

### 2026-09-24 — F1 完了

- **やったこと**: `isSameCanvasImage` でドラッグ中の画像差し替えを検知して中断(MUST-1)、サイドバークリックを Promise キューで直列化(MUST-2)、新規キャプチャ到着時に現在の編集を選択中項目へ保存(SHOULD-2)、catch に console.error、`e2e/capture-race.spec.ts` 追加
- **検証(PJM 再実行)**: build 0 / vitest 0(138) / cargo test 0(109) / clippy 0 / e2e 0(3)。B2 の docs 同期を doc-synchronizer に依頼
- **追加ツールの注意**: 新ドラッグ系ツールも `imageAtDragStart` + `isSameCanvasImage` を踏襲、undo スタックは画像差し替え時の扱いを設計で決める

### 2026-09-24 — B2 完了(実機確認待ち)

- **やったこと**: `src-tauri/src/window_front.rs` 新設(撮影後: 0/150/350ms に unminimize→show→activate→set_focus→NSFloatingWindowLevel→orderFrontRegardless、500ms 後に通常レベル、1000ms 後 Probe)、`[tadcap:front]` 診断ログ、objc2-app-kit feature 追加(NSRunningApplication/NSWorkspace)
- **検証(PJM 再実行)**: cargo test 0(109) / clippy 0
- **docs**: B2 の docs 同期は doc-synchronizer で反映済み(architecture / development-patterns / project-config §11)

### 2026-09-24 — 実機再確認と追加要望

- **人間の実機確認**: ②〜⑤ OK、①ショートカット後の前面表示は NG のまま
- **追加要望と決定**: §3 の「追加機能の人間決定」参照

### 2026-09-24 — B1 修正完了(実機再確認待ち)

- **根本原因(確定)**: ②〜⑤ = asset URL を crossOrigin なしで描画し Canvas 汚染(別オリジン E2E で red 再現)。① = macOS 14+ の協調的アクティブ化で拒否されうる(推定)
- **修正**: `read_capture_image` コマンド(capture_dir 直下 png のみ、canonicalize 検証)→ Blob/ObjectURL 描画。asset プロトコル・scope・CSP の asset を撤去(img-src 'self' blob:)。前面化は activate + orderFrontRegardless(objc2/objc2-app-kit、tao 既存依存の範囲)。E2E は別オリジン配信+console.error 0 件を検証
- **検証(PJM 再実行)**: build 0 / vitest 0(130) / cargo test 0(98) / clippy 0 / e2e 0(2)

### 2026-09-24 — 実機不具合報告(人間)

- **人間の実機確認**(`npm run tauri dev`): 上記 ①〜⑤。B1 を F1 より優先
- **根拠**: `src/main.ts:71` の catch が例外を握りつぶして文言表示(review SHOULD-4 の指摘箇所)。tauri asset プロトコルは `Access-Control-Allow-Origin: <window_origin>` を返すが `loadImage` は `crossOrigin` 未設定

### 2026-09-24 — F2 完了

- **やったこと**: 画像サイズ上限+checked_mul(各辺 16384 / 256MiB)、tray のエラーログ、greet 削除、`.gitignore` に `.env*`、一時キャプチャ自動削除(起動時 setup・終了時 RunEvent::Exit、*.png のみ・非再帰・symlink 除外)。PJM が project-config §11 と development-patterns §8 の該当行を改訂
- **検証(PJM 再実行)**: build 0 / vitest 0(128) / cargo test 0(84) / clippy 0 / e2e 0(2)
- **使用率**: 90% のため F1 はリセット(12:30)後に開始。監視を resume モードに切替

### 2026-09-24 — 一時ファイル方針変更

- **人間の決定**: 一時キャプチャファイルを自動削除(ARCH §12 改訂)。F2 に追加指示

### 2026-09-24 — Phase 5 コードレビュー完了

- **結果**: 条件付き承認、MUST 3 / SHOULD 5 / CONSIDER 3(`output/reports/review/REVIEW_tadcap_mvp.md`)。依存方向違反 0、docs 同期良好
- **方針**: §3 の F1/F2 で修正、一時ファイル削除は人間に確認

### 2026-09-24 — Phase 5 セキュリティ完了

- **結果**: CRITICAL 0 / HIGH 1 / MEDIUM 1 / LOW 2 / INFO 3(`output/reports/security/SECURITY_20260924.md`)。npm audit 0 件、Cargo 主要クレートの既知アドバイザリ 0(悉皆ではない)
- **HIGH**: `write_image_fallback` の width/height に上限なし・`width*height*4` が release でラップし長さ検証をバイパス → checked 演算 + 上限で修正予定
- **MEDIUM**: 一時キャプチャ未削除(legal と重複)

### 2026-09-24 — Phase 5 法務チェック完了

- **結果**: CRITICAL 0 / WARNING 4 / INFO 8(`output/reports/legal/LEGAL_2026-09-24_0953.md`)。非互換ライセンス検出なし(Rust 推移依存は未機械検証で暫定)
- **WARNING**: 一時キャプチャ未削除 / Rust 依存ライセンス未機械検証 / THIRD-PARTY-NOTICES なし / 画面収録の Info.plist 使用目的キー要否未確認 → security・review の結果と合わせて修正方針を決める

### 2026-09-24 — Phase 5 並行開始

- **人間の指示**: `librust_out.rlib` 削除 OK(削除済み)、「そのまま進めて」→ Phase 5(読取専用レビュー)を G4 手動確認と並行で開始。その他の確認事項(履歴上限・DMG・コミット方針・UI の好み)は未回答のため現状維持

### 2026-09-24 — T18 自動部分完了(ゲート4 提示)

- **やったこと**: 全自動検証(build / vitest 128 / cargo 61 / clippy 0 / e2e 2)、リリースビルド `src-tauri/target/release/bundle/macos/Tadcap.app`(4.5MB、`--bundles app`。DMG は bundle_dmg.sh で失敗)、手動チェックリスト 28 項目、受け入れ基準対応表(未カバー 4 件)
- **証拠**: `testreport/t18/summary.txt`、`output/reports/test/T18_acceptance_matrix.md`

### 2026-09-24 — T17 完了

- **やったこと**: `opener:default` 削除(未使用で攻撃面のみ)、CSP 最小化(default/connect ipc/img asset+blob/style self)、asset scope の /var→/private/var 不一致バグを発見し setup で canonicalize 済みディレクトリを動的許可、レビュー `output/reports/security/T17_capabilities_review.md`
- **検証(PJM 再実行)**: build 0 / vitest 0(128) / cargo test 0(61) / clippy 0 / e2e 0(2)

### 2026-09-24 — T19 完了(UI 見直し)

- **やったこと**: 1 本のアイコンツールバー(インライン SVG、aria-label 維持)、トースト化、空状態「⌘⇧2 でキャプチャ」、アクセント 1 色、`[hidden]{display:none !important}` でバナー常時表示バグを修正。before/after スクショ `output/reports/ui/`、`UI_REVIEW_T19.md`
- **検証(PJM 再実行)**: build 0 / vitest 0(128) / cargo test 0(60) / clippy 0 / e2e 0(2 passed)。リポジトリ内に第三者名なし(grep)
- **人間確認待ち**: 新 UI の見た目の好み(スクショ提示済み)

### 2026-09-24 — T13 完了

- **やったこと**: Playwright(chromium)+ 自己完結 IPC モック(`__TAURI_INTERNALS__` 注入、asset は同一オリジン相対パス)、`e2e/capture-flow.spec.ts` 2 本、レポート `output/reports/test/E2E_T13_capture-flow.md`
- **検証(PJM 再実行)**: `npm run e2e` 1 passed / 1 failed(権限バナー。本体 CSS バグで再現確認)。スモーク 4 コマンド exit 0(vitest 128 / cargo 60)
- **判断**: バナー CSS 修正は同じファイルを作り直す T19 に含め、E2E 全 green を T19 の完了条件にする

### 2026-09-24 — 利用上限からの再開

- **事象**: 2026-09-23 23:36 頃に 5h 枠上限到達。T13 テスターが E2E 実行直前(スモーク全 exit 0)で停止。監視 v1 は 15 分間隔で 98% を飛び越えた
- **対応**: 監視を v2(5 分・予測型)に更新して再起動、T13 テスターを同じ文脈で再開。リポジトリ直下の未追跡 `librust_out.rlib` の出所を確認中

### 2026-09-23 — T11 完了 / 要望追加

- **人間の計測**: 約 25ms → 200ms 未満、CLI 継続(`testreport/nfr-001/result-20260923.md`)
- **人間の要望**: UI 見直し(T19 として T13 の後に追加)、使用率 98% で中断・リセット後に再開(15 分ポーリング)

### 2026-09-23 — T14 完了

- **やったこと**: history/historyStore.ts(純粋関数+薄いストア、上限 50 件【仮定】、ObjectURL を上書き/破棄時 revoke)、ui/sidebar.ts、render.ts `captureHistoryAssets`、コピー成功フック
- **検証(PJM 再実行)**: red 確認済み → build 0 / vitest 0(128) / cargo test 0(60) / clippy 0
- **申し送り**: 手動確認に履歴 5 項目を追加(T18) / 上限 50 件は ゲート4 で人間確認

### 2026-09-23 — T12 完了

- **やったこと**: ipc/clipboard.ts(Image.new+writeImage → 失敗時 Rust `write_image_fallback`(arboard、Raw ボディ))、ui/clipboardButton.ts(ボタン+Cmd+C、編集中入力は奪わない)、capabilities `clipboard-manager:allow-write-image` のみ
- **検証(PJM 再実行)**: red 確認済み → build 0 / vitest 0(111) / cargo test 0(60) / clippy 0
- **PJM 判断**: 受け渡しを PNG→RGBA8 に変更(追加依存回避)を承認し ARCH §4/§5.2/§7 に改訂注記
- **PJM 判断(T14 用)**: 履歴はキャプチャ完了時に追加し、別項目へ切替時とコピー時に現在の Canvas(編集後画像)で上書き(PRD FR-010・決定#3 に整合)

### 2026-09-23 — T11 仕込み完了(計測待ち)

- **やったこと**: 3 入口(button/tray/shortcut)で Instant 起点 → `screencapture` spawn 完了までを `[tadcap:latency]` で stderr 出力、`CaptureProvider::capture` に `on_spawn` 引数追加、`scripts/latency-summary.mjs` + `npm run latency:summary`、手順書 `testreport/nfr-001/README.md`
- **検証(PJM 再実行)**: build 0 / vitest 0(92) / cargo test 0(47) / clippy 0
- **PJM 注記**: spawn 完了は近似で、ほぼ確実に 200ms 未満になる。体感(UI 表示)の判定は人間の目視/動画を併用して行う。T11 の完了判定は人間の計測結果待ち(T12 以降は並行で進める)

### 2026-09-23 — T10 完了

- **やったこと**: canvas/tools/mosaicTool.ts(ブロック=clamp(round(対角×0.008),12,64)、矩形のみ getImageData、端数ブロック対応、正規化・クリップ)、toolbar に mosaic 追加
- **検証(PJM 再実行)**: red(exit 1)確認済み → build 0 / vitest 0(78) / cargo test 0(42) / clippy 0

### 2026-09-23 — T09 完了

- **やったこと**: canvas/coords.ts(表示→画像ピクセル座標)、canvas/tools/arrowTool.ts(線幅=clamp(round(対角×0.0035),2,14)、矢じり=線幅×4・30°、ImageData スナップショットでプレビュー→pointerup で焼き込み)、ui/toolbar.ts、色は CSS `--arrow-color` 1 か所
- **検証(PJM 再実行)**: red 実行確認済み(exit 1)→ build 0 / vitest 0(59) / cargo test 0(42) / clippy 0
- **申し送り(T10)**: toolbar の TOOLS に mosaic 追加、同じスナップショット→焼き込みパターン、activeTool ガード

### 2026-09-23 — T08 完了

- **やったこと**: 権限コマンド 2 つ(check=未許可なら request を 1 回 / 設定画面を開く=固定 URL)、ipc/permissions.ts・ui/permissionBanner.ts、3 入口(ボタン reject・`capture://error`・起動時)で同一バナー。allow 残 0 件。capabilities に `opener:allow-open-url`(固定 URL)
- **検証(PJM 再実行)**: build 0 / vitest 0(33) / cargo test 0(42) / clippy 0
- **申し送り**: TS 側の red 実行は省略された(開発者が開示)→ 以降のタスクで red 実行を明示指示 / 再起動要否は【仮定】で条件付き文言、手動確認#2 / opener の Rust 直呼びは capabilities を経由しない点を T17 で再確認

### 2026-09-23 — T08 中断→再開

- **事象**: T08 開発者がセッションリミット(429)で停止。コード変更なし・スモーク 4 コマンド exit 0 を確認し、同じ指示で再開

### 2026-09-23 — T16 完了

- **やったこと**: `shortcuts.rs`(Cmd+Shift+2、Pressed のみ、登録失敗はログのみで継続)、`tauri-plugin-global-shortcut` 追加。PJM 指摘のメインスレッドブロッキングを修正(`capture_screen` async 化 + `spawn_blocking`、トレイ/ショートカットは `async_runtime::spawn` + `run_on_main_thread` で前面表示)、3 起点共有 AtomicBool 排他(panic 時も JoinError 経由で解放)
- **検証(PJM 再実行)**: build 0 / vitest 0(16) / cargo test 0(36) / clippy 0
- **人間に実機試用を依頼**: `npm run tauri dev` → Cmd+Shift+2(手順は TASK/報告参照)

### 2026-09-23 — T15 完了

- **やったこと**: `tray.rs`(3 項目メニュー、`run_capture_and_show_editor` / `show_and_focus_main_window`)、Dock 非表示(`app.handle().set_activation_policy(Accessory)`)、クローズ→hide、`capture://error` イベント新設、`tray-icon` feature
- **検証(PJM 再実行)**: build 0 / vitest 0(16) / cargo test 0(31) / clippy 0
- **PJM 指摘→T16 で修正**: 同期 `#[tauri::command]` とトレイハンドラはメインスレッドで実行されるため、対話的な `screencapture -i` の待ちで UI/イベントループが固まる。`capture_screen` を async 化、トレイ/ショートカットは `spawn_blocking` 等でバックグラウンド実行に
- **申し送り**: フロントの `capture://error` 購読は T08 で実装 / Esc キャンセル時は何もしない【仮定】

### 2026-09-23 — T07 完了

- **やったこと**: ipc/capture.ts・canvas/canvasState.ts・canvas/render.ts・ui/captureButton.ts、main.ts/index.html/styles.css を置換(greet 撤去・ダーク追従削除)。assetProtocol scope=`$TEMP/tadcap-captures/*`、Cargo に `protocol-asset` feature
- **検証(PJM 再実行)**: build 0 / vitest 0(16 passed) / cargo test 0(26) / clippy 0
- **実機確認の注意**: macOS の一時ディレクトリは `/var/folders/...`(実体 `/private/var/...`)。asset scope とパスの一致を手動確認#1 で確認すること / `csp: null` は T17 で見直す

### 2026-09-23 — T06 完了(Rust 基盤 T01〜T06 完了)

- **やったこと**: `capture_screen` コマンド(戻り値 `CaptureResult|null`、エラー文字列 `permission_denied`、成功時のみ `capture://completed` emit)、AppError::PermissionDenied、created_at は std のみで ISO8601 UTC 生成、id はファイル名 stem
- **検証(PJM 再実行)**: build 0 / vitest 0 / cargo test 0(26 passed) / clippy 0。残 allow 3 件はすべて T08 で除去予定
- **申し送り(T07)**: Canvas 反映の主経路は `capture://completed` イベント購読(ショートカット/トレイ起点と共通化)。IPC 仕様は docs/docs/project.md

### 2026-09-23 — T05 完了

- **やったこと**: `capture/screencapture.rs`(ScreenCaptureCli、ファイル有無で Completed/Cancelled)、`capture::run()` / `run_with()`(権限・プロバイダ注入)、RunError
- **検証(PJM 再実行)**: build 0 / vitest 0 / cargo test 0(12 passed) / clippy 0。テストで実 screencapture は起動しない
- **PJM 判断**: `request_screen_recording_access` は恒久未使用にしない。T08 で未許可時に 1 回呼ぶ(OS ダイアログ表示＋システム設定の画面収録リストにアプリを登録させるため。呼ばないとリストに出ずユーザーが許可できない恐れ)→ その後「システム設定を開く」導線。`capture_dir` の未使用 re-export は T06 で削除(YAGNI)

### 2026-09-23 — T04 完了

- **やったこと**: `capture/permission.rs`(CoreGraphics 自前 FFI、unsafe は 2 呼び出しに限定、`to_permission` 純粋関数テスト 2 件)
- **検証(PJM 再実行)**: build 0 / vitest 0 / cargo test 0(7 passed) / clippy 0
- **申し送り**: T05 は `preflight_screen_recording_access()` を使い permission の allow を外す / フロントの「未確認」状態は T08 で TS 側に持つ / 実機の戻り値は T18 手動確認

### 2026-09-23 — T03 完了

- **やったこと**: `capture/mod.rs`(CaptureProvider trait 1 メソッド・CaptureOutcome・CaptureKind::Range・CaptureResult)、`capture/tempfile.rs`(一意パス生成、std のみ)
- **検証(PJM 再実行)**: build 0 / vitest 0 / cargo test 0(5 passed) / clippy 0
- **申し送り**: 骨組みの `#[allow(dead_code)]` は T06 完了時点で全て外れていること(T06 の完了確認で grep する) / `created_at` の生成方式(std のみ vs chrono)は T06 で決定 / 権限チェックは `capture::run()` 側で呼ぶ(ARCH §7.1)

### 2026-09-23 — T02 完了

- **やったこと**: `error.rs`(AppError, thiserror 2)・`commands.rs`(greet 移設)追加、lib.rs 配線。docs/project-config 反映
- **検証(PJM 再実行)**: build 0 / vitest 0 / cargo test 0(2 passed) / clippy 0
- **申し送り**: `AppError` の `#[allow(dead_code)]` は実際に使うコマンド追加時(T05〜)に外す

### 2026-09-23 — T01 完了

- **やったこと**: 人間が rustup で Rust 1.98.1 を導入。PJM がスモークテスト全体を実行、project-config §11 の Rust 未導入エントリを PATH の注意に更新
- **検証**: `npm run build` exit 0 / `npm run test:run` exit 0 / `cargo test` exit 0(0 tests) / `cargo clippy -D warnings` exit 0
- **コミット**: なし(人間の方針待ち)

### 2026-09-23 — T01 実装(Rust 検証待ち)

- **やったこと**: Vitest 5 導入(`test`/`test:run`)、`src/test/smoke.test.ts`、vite.config.ts に test 設定、lib.rs の format! を clippy 対応、project-config §2/§3/§11・docs/docs 反映
- **検証**: `npm run build` exit 0 / `npm run test:run` 1 passed。`cargo` 未インストールのため Rust 側 2 コマンドは未実行
- **コミット**: なし(人間の方針待ち)

### 2026-09-23 — ゲート3 通過

- **人間の決定**: lint は ESLint なし・`cargo clippy -D warnings` をスモークに追加 / CI は作らない / T15・T16 を T07 直後に前倒し
- **やったこと**: TASK 文書への反映をプランナーに依頼、T01 を開発者に委任

### 2026-09-23 — Phase 3 完了

- **やったこと**: プランナーが TASK_tadcap_mvp.md を生成(T01〜T18、1 タスク=1 セッション粒度、手動確認チェックリスト 7 項目)。並行可能は T13/T14 のみ → 逐次で問題なし
- **スモークテスト案**: `npm run build && npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml`(T01 で導入)

### 2026-09-23 — ゲート2 通過

- **やったこと**: ゲート2 決定を ARCH に反映。grep で未解決【要確認】0・第三者権限プラグイン残存 0 を確認。Phase 3 をプランナーに委任
- **申し送り**: 設定画面 URL `x-apple.systempreferences:...Privacy_ScreenCapture` は非公式のため【仮定】(実機で確認)

### 2026-09-23 — Phase 2 完了

- **やったこと**: アナリストが ARCH を生成(CaptureProvider trait / 画像は一時ファイル+asset protocol・最終画像はバイト列 / OS 起点はイベント / Dock 非表示=ActivationPolicy::Accessory / フロント 4 モジュール)
- **申し送り**: §15【要確認】4 件(権限チェック方式・Capture.kind・クリップボード fallback クレート・E2E 手段)をゲート2 で提示

### 2026-09-23 — ゲート1 通過

- **やったこと**: ゲート1 決定を PRD に反映(MVP 8 機能・全 9 実装フェーズ)。grep で未解決【要確認】0 を確認。人間が「そのまま進めて」と指示 → Phase 2 着手
- **申し送り**: FR-004 既定キーは実装時に衝突確認して確定 / FR-009 Dock 非表示は【仮定】(G2 で確認)→ 同日人間決定済み・PRD 反映済み

### 2026-09-23 — ゲート1 協議中

- **人間の決定**: F-04 グローバルショートカットを MVP に含める(「Cmd+Shift+4 のような使い方」が目的)。PRD へは残りの回答とまとめて反映予定(未反映)
- **協議中**: ScreenCaptureKit 移行の是非(人間は非機能の改善を希望)。PJM 推奨=MVP は CLI+capture trait で差し替え可能にし、Phase 4 で起動レイテンシを実測して判断
- **F-04 派生の未決**: 既定キー(Cmd+Shift+4 は OS 予約)、常駐方式(F-08 を MVP に入れるか)

### 2026-09-23 — Phase 1 完了

- **やったこと**: アナリストが `output/prd/PRD_tadcap_mvp.md`(302 行、出力契約 §1〜§11 充足)を生成。見出し構成を PJM が確認
- **申し送り**: 【要確認】8 件(未決事項 4 + NFR 曖昧点 2 + 整合性 2: F-04 の Must/MVP 外矛盾・テーマ対応)をゲート1 で人間に提示済み

### 2026-09-23 — PJM 起動

- **やったこと**: TEAM_PJM 起動。本ノート作成。Phase 0 はスキップ判定。Phase 1(PRD)をアナリスト subagent に委任
- **判断**: 承認モード=通常、実装モード=逐次(指定なしのため既定)
- **未完了 / 申し送り**: Phase 1 の完了確認と G1 提示
