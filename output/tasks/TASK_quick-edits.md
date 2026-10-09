ステータス: ゲート 3 承認待ち(2026-10-10 作成。末尾の【要確認】6 件を人間が決めたら承認)

# タスク分解: 小さな編集機能(1 キー切替 / 縮めてコピー / スタンプ / スポットライト / トリミング)

> 生成元: `output/prd/PRD_quick-edits.md`(Approved 2026-10-10)・`output/design/ARCH_quick-edits.md`(Approved 2026-10-10)・`output/design/UI_quick-edits.md`(Approved 2026-10-10)・`output/design/ADR_002_crop-undo-and-style-basis.md`(Accepted)
> 生成日: 2026-10-10 / 根拠のコード: `52b2835`(ARCH の根拠 `c3c0854` 以降はドキュメントの変更のみ)
> タスク ID は既存の `T01〜T34`・`KS-T*`・`AM-T*` と区別するため `QE-T01` から始める。
> FR / NFR の番号は PRD_quick-edits のもの。「ARCH §n」「UI §n」は本機能の ARCH / UI 仕様の節。変更ファイルはリポジトリのルートからの相対パス。

## 進め方の共通ルール

- **1 タスク = 1 セッション = 1 コミット**(Conventional Commits。例: `feat(canvas): 番号スタンプを置けるようにする`)。実装モードは既存どおり**逐次**(【要確認】#4)。下の「並行可能」は「変更ファイルが重ならず、順番を入れ替えても衝突しない」の意味
- **TDD**: 各実装タスクは「先に書くテスト(Red)」を書いて失敗を確認 → 実装(Green)→ 整理(Refactor)。Red の失敗出力と Green の成功出力の要点を PROGRESS のセッションログに残す
- **着手前**: `SMOKE` が緑であることを確認する。**終了時**: `SMOKE` 緑 + コミット + `output/tasks/PROGRESS.md` の該当行の `passes` を更新し、セッションログを追記する(PROGRESS は全タスクが触るが、自分の行の `passes` とログの追記だけなので、変更ファイルの重なりの判定から外す)
- **依存を追加しない**(NFR-003): `package.json`・`package-lock.json`・`src-tauri/Cargo.toml`・`src-tauri/Cargo.lock` は変えない。Cargo の機能(features)の追加もしない。毎タスクの終わりに `NODEPS` を実行する
- **権限・CSP を変えない**: `src-tauri/capabilities/` は変えない。`src-tauri/tauri.conf.json` の差分は既定の窓幅 `width` の 1 行だけ(QE-T03、【要確認】#3)
- **何も残さない**(NFR-002): 新たに保存するのは `settings.json` の `shrinkCopy` だけ。スタンプ・穴・トリミング・倍率・`captureSize`・`styleBasis` はメモリだけ。ログ・一時ファイルへの出力を足さない
- **層の向き**(ARCH §3.2): `src/canvas/` から `src/ui/`・`src/ipc/` を import しない(既存の `canvasState.ts` の `CaptureResult` 型の 1 件を除く)。設定ファイルへの書き込みは `SettingsStore` だけ
- **製品名を書かない**: コード・テスト・コメント・ドキュメント・README・紹介ページに他社の製品名・サービス名を書かない
- **docs の更新**: 「並行可能」なタスク(QE-T04・T06・T07・T10・T14・T18・T19)は `docs/`・`project-config.md` を触らず、発見事項を PROGRESS に書いて次の結線タスクへ渡す(変更ファイルを重ねないため)。docs は各機能の結線タスクが最小差分で更新する(§ドキュメント更新計画)

### 共通の検証コマンド

```bash
# SMOKE(全タスク共通)
. "$HOME/.cargo/env" && npm run build && npm run test:run \
  && cargo test --manifest-path src-tauri/Cargo.toml \
  && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings \
  && npm run e2e

# NODEPS(全タスク共通。期待: 出力なし)
git diff 52b2835 -- package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/capabilities/

# LAYER(canvas / ui / ipc / Rust の設定を触ったタスク。期待: canvasState.ts の CaptureResult 型の 1 件だけ / settings.rs の中だけ)
rg -n 'from "\.\./(\.\./)?(ui|ipc)/' src/canvas
rg -n 'save_settings' src-tauri/src

# STORAGE(期待: 0 件)
rg -n 'localStorage|sessionStorage|indexedDB' src
```

## 要件サマリー

- [ ] 8 ツールを修飾キーなしの 1 文字(A・R・O・T・N・M・S・C)で切り替えられ、修飾キー付き・入力中・IME 変換中・設定画面・自動マスキングの処理中/確認中・画像なしでは反応しない(FR-013)
- [ ] ツールボタンの名前・ツールチップ・`aria-keyshortcuts` にキーが出る(`矢印(A)` の形)(FR-013、UI §1.3)
- [ ] ツールバーが「描く注釈 5 つ ┆ 画像を変える 3 つ」に分かれ、既定の窓幅 1080px で 1 段、狭めると 2 段に折り返す(UI §1.1・§1.4)
- [ ] 設定画面で「コピーを等倍に縮める」をオン/オフでき、既定はオフ、再起動後も保たれ、古い設定ファイルはオフとして読む。ショートカットの変更で消えない(FR-011、ARCH §1.3 #13)
- [ ] オンのとき ⌘C・コピーボタン・撮った直後の自動コピーの全経路で、幅・高さを画面の倍率で割って四捨五入(最小 1px)した画像がコピーされる。倍率 1・不明は縮めない。表示・編集・履歴は元の解像度のまま(FR-012)
- [ ] 画面の倍率は撮った PNG の pHYs から決まり(144dpi → 2、72dpi → 1、それ以外 → 不明)、履歴から開き直しても同じ(ARCH §1.3 #10・#11)
- [ ] スタンプツールのクリックで、選択中の色の丸に白(明るい色では黒)の番号・記号のスタンプが置かれ、大きさは文字サイズに連動し、2 桁もはみ出さない(FR-001・FR-004、UI §2)
- [ ] 番号は置いた順に 1 から振られ、消すと詰まり、取り消しで戻り、移動・重ね順では変わらず、記号は数えない(FR-002)
- [ ] スタンプを選んで移動・削除・色・文字サイズ・重ね順を変えられ、それぞれ取り消し 1 手(FR-003)
- [ ] 番号スタンプと穴は 50 個の上限で焼き込まず、焼き込める注釈が無ければ 51 個目を追加せず「注釈は 50 個までです。…」と知らせる(ARCH §15 #2・#3、UI §6)
- [ ] スポットライトで矩形の穴を複数開けられ、穴の和の外側だけが 1 段階(黒 50%)暗くなり、注釈は穴の外でも明るい。穴は移動・リサイズ・削除でき、コピー・履歴に暗さが写る。自動マスキングはベースを読む(FR-008〜FR-010)
- [ ] トリミングで範囲を囲み、Enter / 確定で切り詰め、Esc / やめるで中止できる。範囲は整数の画素で画像の内側、全体と同じ・0 は何もしない。確定前の表示はコピーに写らない(FR-005)
- [ ] 確定は取り消し 1 手で、注釈は位置が合い、完全に外へ出た注釈は消え、⌘Z で大きさ・位置・消えた注釈が戻る。トリミングより前の手も続けて戻せる(FR-006・FR-007、ADR-002)
- [ ] 切る前に描いた注釈の大きさはトリミングで変わらず、モザイクの粗さは撮った時点の大きさで決まる(ADR-002)
- [ ] 範囲の指定中の ⌘Z / ⇧⌘Z は指定をやめるだけ。自動マスキングの処理中・確認中はトリミングを始められず、大きさが変わったら候補を捨てる(ARCH §15 #4、FR-007)
- [ ] 実機で「撮る → 番号 → トリミング・スポットライト → コピー → 他のアプリへ貼る」が Tadcap だけでできる(NFR-001)
- [ ] 依存・権限・CSP の差分 0、保存するのは `shrinkCopy` だけ(NFR-002・NFR-003)

## 影響調査

| カテゴリ | ファイル | 変更内容 |
| -------- | -------- | -------- |
| スキーマ | `src/canvas/shapeEdit.ts` | 追加: `StampShape`・`SpotlightShape` を `EditableShape` に、全種類に任意の `styleBasis`。変更: ハンドル・当たり判定・`shapeUndoRect()`・ツールごとに掴める注釈(`decidePointerDown()`)・はみ出した注釈の移動の範囲(`moveShape()`) |
| スキーマ | `src/canvas/commands.ts` | 追加: `crop` コマンド、`PixelStore.swapAll()` |
| スキーマ | `src/canvas/canvasState.ts` | 変更: `ToolId` に `"stamp"`・`"spotlight"`・`"crop"`、`CanvasImage.pixelRatio` |
| スキーマ | `src/ipc/capture.ts` / `src-tauri/src/capture/mod.rs` | 追加: `CaptureResult.pixelRatio`(`1 \| 2 \| null`) |
| スキーマ | `src-tauri/src/settings.rs` | 追加: `AppSettings.shrink_copy`(`false` は書かない)、`SettingsStore` |
| ストア | `src/canvas/documentState.ts` | 追加: `applyCrop()`・`captureSize`(退避にも)。変更: 上限の焼き込み(`pickBurnTarget()`・追加しないとき `null`)、選択中のスタンプ・穴への色・文字サイズ |
| ストア | `src/canvas/cropSession.ts` | 追加: 確定前のトリミング範囲 |
| ストア | `src/canvas/toolSettings.ts` | 追加: `stampKind`(既定は番号、非永続) |
| ストア | `src/history/historyStore.ts` / `src/history/documentArchive.ts` | 追加: `HistoryItem.pixelRatio`。変更: `commandPixelBytes()` が `crop` の画素を数える |
| ユーティリティ | `src/canvas/tools/stampShape.ts` / `src/canvas/styleBasis.ts` / `src/canvas/spotlight.ts` / `src/canvas/crop.ts` / `src/canvas/copyScale.ts` | 追加: 直径・記号の色・番号・描画 / 大きさの基準の対角線 / 暗くする矩形の集合 / 範囲の整数化と注釈の計画 / 縮めた大きさと倍率 |
| ユーティリティ | `src/canvas/render.ts` | 変更: `getCanvasImageData(canvas, ratio)` で縮めた RGBA を返せる |
| ユーティリティ | `src/canvas/tools/{arrowTool,rectangleTool,ellipseTool,textLayout,textTool}.ts` | 変更: 太さ・文字の大きさを `shapeStyleDiagonal()` の対角線から決める |
| ユーティリティ | `src/canvas/tools/mosaicTool.ts` / `src/ui/autoMask.ts` | 変更: モザイクの粗さを `captureSize` で決める。`autoMask.ts` は大きさの変化で候補を捨てる |
| ユーティリティ | `src-tauri/src/capture/pixel_ratio.rs` | 追加: PNG の pHYs → `Some(1)` / `Some(2)` / `None` |
| ユーティリティ | `src-tauri/src/commands.rs` / `src-tauri/src/shortcuts.rs` / `src-tauri/src/lib.rs` | 追加: `get_shrink_copy`・`set_shrink_copy`、`run_capture()` が倍率を埋める。変更: ショートカットの保存を `SettingsStore` 経由に |
| コンポーネント | `src/canvas/documentSurface.ts` | 追加: `swapAll()`、暗さの段、スタンプの描画(番号を渡す) |
| コンポーネント | `src/canvas/tools/shapeTools.ts` / `src/canvas/tools/cropTool.ts` | 変更: スタンプを置く・穴を描く・選択の表示・上限の通知。追加: トリミングのドラッグ・ハンドル・範囲外の暗さ・Enter / Esc |
| コンポーネント | `src/ui/toolKeys.ts` / `src/ui/stampKindPicker.ts` / `src/ui/cropBar.ts` | 追加: 1 キー切替 / スタンプの種類 / 確定・やめるの帯 |
| コンポーネント | `src/ui/toolbar.ts` / `src/ui/undoButton.ts` / `src/ui/settingsDialog.ts` | 変更: 3 ツール・組の区切り・名前にキー / 範囲の指定中の ⌘Z / 「コピーを等倍に縮める」と「キーを既定に戻す」 |
| ページ | `index.html` / `src/styles.css` / `src/main.ts` | 変更: `.toolbar__end`・折り返し・区切り・種類の選択・帯・設定画面の CSS、各 `init*()`・`bindToolKeys()`・`bindCropTool()` の結線、`cancelCrop()`、`shrinkCopy` の保持と `getClipboardPayload()` |
| 設定 | `src-tauri/tauri.conf.json` | 変更: 既定の窓幅 `width` 800 → 1080 の 1 行だけ(UI 【要確認】#1 の決定) |
| テスト | `e2e/tool-keys.spec.ts`・`shrink-copy.spec.ts`・`stamp.spec.ts`・`spotlight.spec.ts`・`crop.spec.ts`・`screenshots/quickEdits.visual.ts` | 追加 |
| テスト | `e2e/fixtures/tauriMock.ts`・`e2e/fixtures/sampleCapturePng.ts` | 変更: `pixelRatio` 付きの撮影結果、pHYs 付き/無しの PNG、`get/set_shrink_copy` |
| テスト | `e2e/annotation-tools.spec.ts`・`e2e/v020-feedback.spec.ts`・`e2e/screenshots/{roundedRect,landing,toolbar}.visual.ts` | 変更: ツール名を `exact: true` で探している箇所を `矢印(A)` の形に(確認時点: `annotation-tools.spec.ts:125`・`v020-feedback.spec.ts:147`・`roundedRect.visual.ts:47`・`landing.visual.ts:161`) |
| ドキュメント | `docs/docs/{project,architecture,data-model,development-patterns}.md` / `project-config.md` §11 | 変更: §ドキュメント更新計画 |
| ドキュメント | `README.md` / `.github/pages/index.html` / `docs/media/*` / `output/design/ADR_002_*.md` / `output/design/ARCH_quick-edits.md` §17 | 変更: 仕上げ(QE-T26) |
| ドキュメント | `output/reports/quick-edits/` / `testreport/quick-edits/` / `testreport/manual/CHECKLIST_T18.md` | 追加: 実機確認の記録(QE-T01・QE-T24)。`testreport/` は git 管理外 |

## タスク分解

### Phase 0 — 最初の実機確認(人間の操作あり。ソース変更なし)

- [ ] QE-T01 — 撮影 PNG に画面の倍率(pHYs)が入るかの実機確認(ARCH §1.3 #10 の【仮定】・§10.3「最初に」)(変更ファイル: `output/reports/quick-edits/PHYS_<日付>.md`, `testreport/quick-edits/phys/*`(git 管理外) | 依存: なし)
  - **目的**: 縮めてコピー(Phase 2)の倍率の取り方を決める前に、Tadcap が使う撮影コマンドが倍率 2 の画面では 144dpi(5669 ピクセル/メートル)、倍率 1 の画面では 72dpi(2835)の pHYs を IDAT より前に書くかを確かめる
  - **前提**: Tadcap の撮影は `screencapture -i <保存先>` で、ほかの引数を渡していない(`src-tauri/src/capture/screencapture.rs:26`)。そのため**ターミナルから同じコマンドで撮れば同じファイルになる**。ターミナルに画面収録の権限が要る(無ければ手順の B を使う)
  - **人間の操作(範囲・ウィンドウの選択と画面の接続は人間にしかできない)**:
    1. 準備(Claude が実行してよい): `mkdir -p testreport/quick-edits/phys`
    2. 次の各条件で 1 枚ずつ撮る(A: ターミナルで `screencapture -i testreport/quick-edits/phys/<名前>.png` を実行して選ぶ。B: Tadcap で撮り、アプリを閉じる前に `ls -t "$TMPDIR"tadcap-captures/` の最新の PNG を `testreport/quick-edits/phys/<名前>.png` へコピーする)

       | 名前 | 画面 | 選び方 |
       | ---- | ---- | ------ |
       | `hi-range` | 倍率 2 の画面(内蔵の画面など) | 範囲をドラッグ |
       | `hi-window` | 倍率 2 の画面 | スペースキーでウィンドウを選ぶ |
       | `hi-scaled` | 倍率 2 の画面を「スペースを拡大」などの拡大縮小の解像度にした状態 | 範囲をドラッグ |
       | `lo-range` | 倍率 1 の外部の画面(あれば) | 範囲をドラッグ |
       | `lo-window` | 倍率 1 の外部の画面(あれば) | ウィンドウを選ぶ |
       | `span` | 2 つの画面をまたぐ範囲(選べなければ「選べない」と記録) | 範囲をドラッグ |

    3. 撮った画像は画面の内容を含むため、**記録の後に削除する**(コミットしない。`testreport/` は git 管理外)
  - **Claude の解析(人間が撮った後)**: 各ファイルについて次を実行し、pHYs の値・単位・IDAT より前にあるか・画像の画素数を表にする。`sips` は pHYs が無くても 72dpi と表示することがある【仮定】ため、チャンクを直接読む方を判定に使う

    ```bash
    for f in testreport/quick-edits/phys/*.png; do
      echo "== $f"; sips -g pixelWidth -g pixelHeight -g dpiWidth -g dpiHeight "$f" | tail -4
      python3 -I - "$f" <<'EOF'
    import struct, sys
    d = open(sys.argv[1], "rb").read()
    assert d[:8] == b"\x89PNG\r\n\x1a\n", "not png"
    i, found = 8, False
    while i + 8 <= len(d):
        n, t = struct.unpack(">I4s", d[i:i+8])
        if t == b"pHYs":
            x, y, u = struct.unpack(">IIB", d[i+8:i+17]); found = True
            print(f"pHYs x={x} y={y} unit={u} dpi={x*0.0254:.2f}")
        if t == b"IDAT":
            print("IDAT reached; pHYs before IDAT:", found); break
        i += 12 + n
    EOF
    done
    ```

  - **判定**:
    - 倍率 2 の 3 条件がすべて 144dpi(±2%)・単位 1・縦横同じ、倍率 1 の条件が 72dpi(±2%)→ ARCH のまま QE-T04 へ進む
    - 1 つでも pHYs が無い・値が違う → **QE-T04 を止め、結果を添えて人間に諮る**(【要確認】#1)。QE-T06・QE-T07 は倍率の出どころに依存しないので進めてよい
    - 倍率 1 の外部の画面が無い → 倍率 1 の行は「未確認」と記録し、QE-T24 で確かめる(【要確認】#2)
  - 受け入れ基準:
    - [ ] `output/reports/quick-edits/PHYS_<日付>.md` に、条件ごとの pHYs の値・単位・IDAT より前か・画素数・`sips` の表示・判定・確認した機種と OS の版がある(画像そのものは載せない)
    - [ ] 撮った画像を削除した(`ls testreport/quick-edits/phys/` が空)
    - [ ] 判定(進む / 人間に諮る)が PROGRESS のセッションログにある
  - 検証コマンド: 上の解析スクリプトの出力を記録に貼る / `ls testreport/quick-edits/phys/`(記録後に空)

### Phase 1 — ツールの 1 キー切替(FR-013)

#### Phase 1a(並行可能。QE-T01 の結果を待たない)

- [ ] QE-T02 — 1 キー切替とツールボタンの名前(変更ファイル: `src/ui/toolKeys.ts`, `src/ui/toolKeys.test.ts`, `src/ui/toolbar.ts`, `src/ui/toolbar.test.ts`, `src/main.ts`, `e2e/tool-keys.spec.ts`, `e2e/annotation-tools.spec.ts`, `e2e/v020-feedback.spec.ts`, `e2e/screenshots/roundedRect.visual.ts`, `e2e/screenshots/landing.visual.ts`, `docs/docs/project.md` | 依存: なし)
  - `TOOL_KEYS` は `ReadonlyArray<{ tool: ToolId; code: string; label: string }>`(今は 5 ツール: `KeyA` 矢印・`KeyR` 矩形・`KeyO` 円・`KeyT` テキスト・`KeyM` モザイク)。新しいツールは追加するタスクで 1 行足す(PRD §9 Phase 1)
  - `toolKeyTarget(event, context): ToolId | null`(ARCH §7.1 手順 K): `defaultPrevented`・`repeat`・⌘/⇧/⌥/⌃ のどれか・`isComposing` または `keyCode === 229`・`isEditableTarget()`・`toolButtonState(id, context).disabled` なら `null`。`event.code` で引く
  - `toolLabel(id)` が `矢印(A)` を組み立て、`toolbar.ts` が `aria-label`・`title`・`aria-keyshortcuts` に使う(UI §1.3)
  - `bindToolKeys()` を `main.ts` で `bindSelectionKeys()` の**後**に登録(ARCH §11)。ツールが返れば `preventDefault()` → `toggleActiveTool(id)`
  - 既存 E2E のうちツール名を `exact: true` で探している箇所を新しい名前に直す(`rg -n 'exact: true' e2e` で洗い出す)
  - TDD(先に書くテスト):
    - `toolKeyTarget`: 5 キーがそれぞれのツールを返す / ⌘C・⌘Z・⇧⌘Z・⌘⇧F・⌘⇧B・⌘⇧M・⌥A・⌃A・⇧A で `null` / `repeat` で `null` / IME 変換中(`isComposing`・`keyCode 229`)で `null` / 入力欄・`contenteditable` が対象で `null` / 自動マスキングの処理中・確認中、描画中、画像なしで `null` / 割り当てのないキー(`KeyZ`・`Digit1`)で `null` / `event.key` が日本語入力の文字でも `event.code` で引ける
    - `toolLabel`: 全ツールが `名前(キー)` の形(半角かっこ・空白なし・大文字)
    - 表の整合: `toolbar.ts` の `TOOLS` のツールと `TOOL_KEYS` のツールが過不足なく一致し、`code` が重複しない
    - E2E `tool-keys.spec.ts`(先に Red を確認): 各キーで `aria-pressed` が切り替わる → 同じキーで外れる → ⌘C・⌘Z は奪わない(コピーと取り消しが起きる)→ テキスト入力中に `a` を押すと文字が入りツールは変わらない → 自動マスキングの確認中は効かない → 設定画面を開いている間は効かない
  - 受け入れ基準:
    - [ ] 上記ユニット・E2E が緑、既存 E2E が名前の変更後も緑、`SMOKE` 緑、`NODEPS` 出力なし
    - [ ] ツールボタンのツールチップが `矢印(A)` の形で、`aria-keyshortcuts` が入っている
    - [ ] `docs/docs/project.md` にツールのキーの一覧がある
  - 検証コマンド: `npx vitest run src/ui/toolKeys.test.ts src/ui/toolbar.test.ts` / `npx playwright test e2e/tool-keys.spec.ts` / `SMOKE` / `NODEPS`

#### Phase 1b(QE-T02 完了後)

- [ ] QE-T03 — ツールバーの 2 組・折り返し・既定の窓幅(UI §1.1・§1.2 の区切り・§1.4)(変更ファイル: `index.html`, `src/styles.css`, `src/ui/toolbar.ts`, `src/ui/toolbar.test.ts`, `src-tauri/tauri.conf.json`, `e2e/screenshots/toolbar.visual.ts` | 依存: QE-T02)
  - `TOOLS` に組の区切りを持たせ、`initToolbar()` が「描く注釈」と「画像を変える」の間に `.tool-toolbar__divider`(`aria-hidden="true"`)を 1 本入れる。モザイクは「画像を変える」組の先頭へ(キーは M のまま)
  - `index.html`: 右のまとまり(取り消し・やり直し〜コピー)を `.toolbar__end` で包み、`.toolbar__spacer` を外す。`src/styles.css`: `.toolbar` の `flex-wrap: wrap; height: auto; min-height: 40px; box-sizing: border-box; padding: 5px 8px; row-gap: 4px`、`.toolbar__end { display: flex; gap: 4px; margin-left: auto }`
  - `tauri.conf.json` の `width` を 1080 にする(高さ 600 のまま)
  - TDD(先に書くテスト): `TOOLS` の組の並び(描く注釈 → 画像を変える、モザイクが後ろの組の先頭)/ 区切りが組の間に 1 本だけ。見た目は `toolbar.visual.ts` に「幅 1080px で 1 段」「幅 800px で 2 段、右のまとまりが右端」を足す(画面の高さで段数を判定するアサーションを先に書いて Red を確認)
  - 受け入れ基準:
    - [ ] 上記テストが緑、`SMOKE` 緑、`NODEPS` 出力なし
    - [ ] `git diff 52b2835 -- src-tauri/tauri.conf.json` が `width` の 1 行だけ
    - [ ] 幅 800px のスクリーンショットで、ボタンが隠れず横スクロールも出ない(`output/reports/ui/` に保存)
  - 検証コマンド: `npx vitest run src/ui/toolbar.test.ts` / `npx playwright test --config=e2e/screenshots/playwright.config.ts e2e/screenshots/toolbar.visual.ts` / `git diff 52b2835 -- src-tauri/tauri.conf.json` / `SMOKE` / `NODEPS`

### Phase 2 — 縮めてコピー(FR-011・FR-012)

#### Phase 2a(並行可能。QE-T04 は QE-T01 の判定が「進む」のときだけ。QE-T06・QE-T07 は Phase 1 と並行してもよい)

- [ ] QE-T04 — Rust: PNG の pHYs から倍率を読み、撮影結果に載せる(ARCH §1.3 #10・§7.1 R-1〜2)(変更ファイル: `src-tauri/src/capture/pixel_ratio.rs`, `src-tauri/src/capture/mod.rs`, `src-tauri/src/commands.rs` | 依存: QE-T01)
  - `pixel_ratio_from_png(bytes: &[u8]) -> Option<u8>`(純粋)と `read_pixel_ratio(path) -> Option<u8>`(先頭から IDAT までのチャンク見出しと pHYs の 9 バイトだけを読む。画像は展開しない)。`masking/png.rs` とは共有しない(ARCH §3.2)
  - `CaptureResult` に `pixel_ratio: Option<u8>`(JSON は `pixelRatio`)。`run_capture()` が既存の `spawn_blocking` の中で読み、失敗しても撮影は成功のまま `None`(ARCH §5.5)
  - TDD(先に書くテスト、`#[cfg(test)]` でバイト列を組み立てる): 72dpi → `Some(1)` / 144dpi → `Some(2)` / ±2% の内側と外側の境目 / pHYs 無し → `None` / 単位 0(不明)→ `None` / 縦横が違う → `None` / 署名違い → `None` / チャンクの長さがファイルの残りを超える・2³¹−1 を超える → `None`(パニックしない)/ IDAT より後の pHYs は見ない / 途中で切れたバイト列 → `None` / `CaptureResult` の JSON に `pixelRatio` が出る(`null` を含む)
  - 受け入れ基準:
    - [ ] 上記テストが緑、`SMOKE` 緑、`NODEPS` 出力なし
    - [ ] `pixel_ratio.rs` が `masking` を参照していない、`println!`・`eprintln!`・`dbg!` を足していない
  - 検証コマンド: `cargo test --manifest-path src-tauri/Cargo.toml capture::pixel_ratio` / `rg -n 'masking|println!|eprintln!|dbg!' src-tauri/src/capture/pixel_ratio.rs`(0 件)/ `SMOKE` / `NODEPS`
- [ ] QE-T06 — 縮めた大きさと縮めた RGBA の取り出し(ARCH §1.3 #12)(変更ファイル: `src/canvas/copyScale.ts`, `src/canvas/copyScale.test.ts`, `src/canvas/render.ts` | 依存: なし)
  - `shrunkSize(w, h, ratio)`(四捨五入・最小 1px。`ratio` が 1 以下・有限でない値は元の大きさ)、`copyRatio(enabled, pixelRatio)`(オフ・1・`null`・不正値は 1)
  - `getCanvasImageData(canvas, ratio = 1)`: `ratio > 1` のときだけ `shrunkSize()` の大きさの canvas に `imageSmoothingQuality = "high"` で描いて RGBA を読む。`ratio = 1` は今と同じ経路
  - TDD(先に書くテスト): `shrunkSize` — 2 倍で 3024×1964 → 1512×982 / 奇数(3×5 → 2×3、四捨五入)/ 1×1 → 1×1(最小 1px)/ `ratio` 1・0.5・0・`NaN`・`Infinity` で元の大きさ。`copyRatio` — オフ・オン × 1・2・`null` の 6 通り。`render.ts` の縮小は DOM が要るため QE-T08 の E2E で確かめる(jsdom は入れない。既存方針)
  - 受け入れ基準:
    - [ ] 上記テストが緑、`SMOKE` 緑(既存の `getCanvasImageData()` の呼び出しは引数なしで今と同じ結果)、`NODEPS` 出力なし
    - [ ] `copyScale.ts` が `ui/`・`ipc/` を import していない(`LAYER`)
  - 検証コマンド: `npx vitest run src/canvas/copyScale.test.ts` / `LAYER` / `SMOKE` / `NODEPS`
- [ ] QE-T07 — IPC: 撮影結果の倍率の型と、縮めてコピーの取得・変更(ARCH §5.5)(変更ファイル: `src/ipc/capture.ts`, `src/ipc/capture.test.ts`, `src/ipc/settings.ts`, `src/ipc/settings.test.ts` | 依存: なし)
  - `CaptureResult.pixelRatio: 1 | 2 | null`。`1 | 2 | null` 以外(3・1.5・文字列・欠落)は `null` として扱う(壊れた値で縮めない)
  - `getShrinkCopy(): Promise<boolean>`(コマンドが無い・失敗は `false`)、`setShrinkCopy(enabled): Promise<boolean>`(`settings_save_failed` を区別できる例外にする)
  - TDD(先に書くテスト。既存 `src/ipc/*.test.ts` の invoke の偽物の作法): `pixelRatio` の正規化(1・2・`null`・欠落・3・1.5・`"2"`)/ `get_shrink_copy` が真偽値以外を返したら `false` / 失敗で `false` / `set_shrink_copy` に `{ enabled }` を渡す / 保存失敗の例外
  - 受け入れ基準:
    - [ ] 上記テストが緑、`SMOKE` 緑、`NODEPS` 出力なし
    - [ ] `src/ipc/*.ts` が `canvas/`・`ui/` を import していない
  - 検証コマンド: `npx vitest run src/ipc/capture.test.ts src/ipc/settings.test.ts` / `rg -n 'from "\.\./(canvas|ui)/' src/ipc`(0 件)/ `SMOKE` / `NODEPS`

#### Phase 2b(QE-T04 完了後。`commands.rs` が重なるため)

- [ ] QE-T05 — Rust: `SettingsStore` と `get_shrink_copy`・`set_shrink_copy`(ARCH §1.3 #13・§5.5・§11)(変更ファイル: `src-tauri/src/settings.rs`, `src-tauri/src/shortcuts.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `docs/docs/project.md`, `docs/docs/data-model.md`, `docs/docs/development-patterns.md`, `project-config.md`(§11) | 依存: QE-T04)
  - `SettingsStore { path, settings: Mutex<AppSettings> }`: `load()`・`get()`・`update(f)`(今の設定に `f` を当てて既存の `save_settings()` で保存し、失敗したらメモリの値を戻す)。`AppSettings.shrink_copy` は `#[serde(default, skip_serializing_if = "is_false")]`
  - `shortcuts.rs` の保存(`shortcuts.rs:340` の `AppSettings { capture_shortcut }` でファイル全体を書く所)と起動時の読み込み(`shortcuts.rs:381`)を `SettingsStore` 経由にする。`lib.rs` の `setup()` の最初で `manage()`(ショートカットの登録より前)、`invoke_handler` に 2 コマンド
  - TDD(先に書くテスト): 項目の無いファイル → オフ / オフのときキーを書かない / オンで `"shrinkCopy": true` / **ショートカットを変えても `shrinkCopy` が消えない・逆も同じ**(今のコードで Red になることを確認)/ 保存失敗でメモリの値が戻り `settings_save_failed` / 知らない項目は無視(既存)/ 壊れたファイルは既定(既存)
  - 受け入れ基準:
    - [ ] 上記テストと既存の `settings`・`shortcuts` のテストが緑、`SMOKE` 緑、`NODEPS` 出力なし
    - [ ] `LAYER` で `save_settings` が `settings.rs` の中だけ
    - [ ] docs: IPC コマンド表に 2 コマンド、`capture_screen` の戻り値に `pixelRatio`、`settings.json` の `shrinkCopy`、規約「設定は `SettingsStore` だけが書く」。§11 に「設定の保存がファイル全体の書き換えで、項目を足すと他の項目が消えた」(追記前に重複確認)
  - 検証コマンド: `cargo test --manifest-path src-tauri/Cargo.toml settings shortcuts` / `LAYER` / `SMOKE` / `NODEPS`

#### Phase 2c(Phase 2a・2b 完了後)

- [ ] QE-T08 — 倍率の受け渡しとコピーの全経路で縮める(ARCH §5.2・§7.1 R-3〜5)(変更ファイル: `src/canvas/canvasState.ts`, `src/canvas/canvasState.test.ts`, `src/history/historyStore.ts`, `src/history/historyStore.test.ts`, `src/main.ts`, `e2e/fixtures/tauriMock.ts`, `e2e/fixtures/sampleCapturePng.ts`, `e2e/shrink-copy.spec.ts`, `docs/docs/data-model.md`, `docs/docs/architecture.md` | 依存: QE-T05, QE-T06, QE-T07)
  - `CanvasImage.pixelRatio`(1 か 2。不明は 1)、`HistoryItem.pixelRatio`。`handleCaptureCompleted` が `result.pixelRatio ?? 1` を両方に入れ、`reloadHistoryItemIntoCanvas` は `item.pixelRatio` を `CanvasImage` に戻す
  - `main.ts` が起動時に `getShrinkCopy()` を読んで `shrinkCopy` に持ち(読み終わるまではオフ)、`getClipboardPayload()` が `getCanvasImageData(canvasEl, copyRatio(shrinkCopy, image.pixelRatio))` を渡す。撮った直後の自動コピーも同じ関数を通る(`main.ts:228-236`)
  - `tauriMock.ts`: 撮影結果の `pixelRatio`(1・2・`null` を切り替え)、`get_shrink_copy`(初期値を切り替え)。`sampleCapturePng.ts`: 必要なら 144dpi の pHYs 付き PNG
  - TDD(先に書くテスト): `canvasState`・`historyStore` が倍率を保持し、履歴から開き直しても同じ値 / E2E(先に Red): 設定オン × 倍率 2 で ⌘C・コピーボタン・撮った直後の自動コピーのクリップボードの画像が半分(四捨五入)/ 倍率 `null`・1 は元の大きさ / 設定オフは元の大きさ / 履歴のサムネイル・表示 canvas は元の大きさのまま / 履歴から開き直しても同じ大きさで縮む
  - 受け入れ基準:
    - [ ] 上記テストが緑、`SMOKE` 緑、`NODEPS` 出力なし
    - [ ] docs: `CanvasImage.pixelRatio`・`HistoryItem.pixelRatio`、`copyScale.ts`・`pixel_ratio.rs` とテストの一覧
  - 検証コマンド: `npx vitest run src/canvas/canvasState.test.ts src/history/historyStore.test.ts` / `npx playwright test e2e/shrink-copy.spec.ts` / `SMOKE` / `NODEPS`

#### Phase 2d(QE-T08 完了後)

- [ ] QE-T09 — 設定画面の「コピーを等倍に縮める」(UI §5.1・§6)(変更ファイル: `src/ui/settingsDialog.ts`, `src/ui/settingsDialog.test.ts`(新設), `src/styles.css`, `src/main.ts`, `e2e/fixtures/tauriMock.ts`, `e2e/shrink-copy.spec.ts` | 依存: QE-T08)
  - ショートカットの項目の下に `<hr class="settings-dialog__divider">`・チェック・説明(`aria-describedby`)・状態の文(`role="status"`、失敗だけ)。「既定に戻す」の文言を「キーを既定に戻す」に変える
  - 開いたときに `getShrinkCopy()` で読み直す。切り替えたらすぐ `setShrinkCopy()`、保存中は `disabled`、失敗したらチェックを戻して「保存できませんでした。元の設定のままです。」。成功したら `main.ts` の `shrinkCopy` を更新(コールバックで渡す)
  - 文言は固定文字列を `textContent` で入れる
  - TDD(先に書くテスト。DOM に依存しない部分を関数に分ける): 保存の結果からチェックの値・状態の文を決める関数(成功 / 失敗で元に戻す / 読み込み失敗はオフ)/ E2E(先に Red): オンにしてコピー → 半分 → オフに戻してコピー → 元の大きさ / 保存失敗のモックでチェックが戻り文言が出る / 設定の読み直し(画面の再読み込み)で値が保たれる / 既存の `shortcut-settings.spec.ts` が「キーを既定に戻す」でも緑
  - 受け入れ基準:
    - [ ] 上記テストが緑、`SMOKE` 緑、`NODEPS` 出力なし
    - [ ] 設定画面のスクリーンショット(オン・保存失敗)を `output/reports/ui/` に保存
  - 検証コマンド: `npx vitest run src/ui/settingsDialog.test.ts` / `npx playwright test e2e/shrink-copy.spec.ts e2e/shortcut-settings.spec.ts` / `SMOKE` / `NODEPS`

### Phase 3 — 番号・記号スタンプ(FR-001〜FR-004)

#### Phase 3a(並行可能。いつ着手してもよい。ほかのタスクと変更ファイルが重ならない)

- [ ] QE-T10 — スタンプの寸法・記号の色・番号・描画と、大きさの基準の関数(UI §2.3・§2.4、ARCH §5.1)(変更ファイル: `src/canvas/tools/stampShape.ts`, `src/canvas/tools/stampShape.test.ts`, `src/canvas/styleBasis.ts`, `src/canvas/styleBasis.test.ts` | 依存: なし)
  - `StampGlyph = "number" | "check" | "cross" | "exclamation" | "question"` と `StampShape { kind: "stamp"; center; glyph; color; fontSize; styleBasis? }` の型をここで定義する(`shapeEdit.ts` は QE-T11 で union に加える)
  - `shapeStyleDiagonal(shape, w, h) = shape.styleBasis ?? hypot(w, h)`
  - `stampDiameter(fontSize, diagonal)`: `max(20, round(computeFontSizePx 相当 × 1.2))`(UI §2.3 の定数を名前付きで)。`stampRingWidth`・`stampDigitPx(d, digits)`(1 桁 0.58・2 桁 0.48)・`stampStrokeWidth`
  - `stampGlyphColor(color)`: 白とのコントラスト比 2.5 未満なら `#1a1a1a`、それ以外は白
  - `stampNumbers(objects): Map<id, number>`: 番号スタンプを `id` の昇順に並べた順位(1 から)。記号は数えない
  - `drawStamp(ctx, shape, label, w, h)`: 影 → 白の円 → 色の円 → 記号(✓・× は線、数字・!・? は `fillText`)。`hitStamp(shape, point, w, h)`: 円の内側
  - TDD(先に書くテスト): 直径 — UI §2.3 の例(2080×1204 で 小 47・中 70・大 104、2880×1800 で 中 98)と下限 20、同じ入力で同じ値 / `stampGlyphColor` — プリセット 6 色(橙・黄・緑は黒、ピンク・赤・青は白)と比 2.5 の境目の前後 / `stampNumbers` — 置いた順 1・2・3、2 を消すと 1・2、記号を挟んでも数えない、配列の順(重ね順)を入れ替えても同じ / `shapeStyleDiagonal` — `styleBasis` 無しは今の対角線、有りはその値 / `hitStamp` — 中心・縁の内側・外側 / `drawStamp` — 偽の `ctx` で描く順(影 → 白 → 色 → 記号)と 2 桁の文字の大きさ
  - 受け入れ基準:
    - [ ] 上記テストが緑、`SMOKE` 緑、`NODEPS` 出力なし
    - [ ] 2 ファイルが純粋関数のみで `ui/`・`ipc/`・状態ストアを import していない(`LAYER`)
  - 検証コマンド: `npx vitest run src/canvas/tools/stampShape.test.ts src/canvas/styleBasis.test.ts` / `LAYER` / `SMOKE` / `NODEPS`

#### Phase 3b(Phase 2・QE-T10 完了後)

- [ ] QE-T11 — スタンプをオブジェクトの種類に加え、上限の焼き込みの選び方を変える(ARCH §5.3・§15 #2・#3)(変更ファイル: `src/canvas/canvasState.ts`, `src/canvas/shapeEdit.ts`, `src/canvas/shapeEdit.test.ts`, `src/canvas/objectModel.ts`, `src/canvas/objectModel.test.ts`, `src/canvas/documentState.ts`, `src/canvas/documentState.test.ts`, `src/canvas/tools/shapeTools.ts`, `src/canvas/tools/textTool.ts` | 依存: QE-T10)
  - `ToolId` に `"stamp"`。`EditableShape` に `StampShape`。ハンドル無し、当たり判定は円の内側、移動は中心を半径の分だけ内側に収める、`shapeUndoRect()` は影込みの外接矩形
  - `decidePointerDown()`: スタンプツールではスタンプだけを掴み、空白は `place`(UI 側は QE-T12)。矢印・矩形・円ツールはスタンプも掴める(ARCH §5.3 の表)
  - `pickBurnTarget(objects)`: 重ね順の奥から、番号スタンプを飛ばして最初の注釈(穴は QE-T15 で加える)。`addShapeObject()` は選べなければ追加せず `null` を返し、取り消しの手も積まない。呼び出し元(`shapeTools.ts:291`・`textTool.ts:217`)は `null` のとき何もしない(通知は QE-T12)
  - `setSelectedFontSize()`・`setSelectedColor()` をスタンプに広げる(中心を保って直径が変わる。1 手)
  - TDD(先に書くテスト): 50 個 + 1 で最も奥が番号スタンプなら次の注釈を焼き込む / 全部が番号スタンプなら `null` で状態・取り消しが変わらない / 記号スタンプは焼き込まれる / スタンプのハンドルが空 / スタンプツールでテキストを掴まない / 移動で画像の外へ出ない / 文字サイズの変更で中心が同じ・1 回の取り消しで戻る / 色の変更が 1 手 / 既存の 50 個の上限・焼き込みのテストが緑
  - 受け入れ基準:
    - [ ] 上記テストと既存テストが緑、`SMOKE` 緑、`NODEPS` 出力なし、`LAYER`
  - 検証コマンド: `npx vitest run src/canvas/shapeEdit.test.ts src/canvas/objectModel.test.ts src/canvas/documentState.test.ts` / `LAYER` / `SMOKE` / `NODEPS`

#### Phase 3c(QE-T11 完了後)

- [ ] QE-T12 — スタンプを描く・置く・選ぶ、上限の通知(ARCH §5.2・§7.1 S、UI §2.5・§6)(変更ファイル: `src/canvas/documentSurface.ts`, `src/canvas/tools/shapeTools.ts`, `src/canvas/tools/textTool.ts`, `src/canvas/toolSettings.ts`, `src/canvas/toolSettings.test.ts`, `src/ui/toolbar.ts`, `src/ui/toolKeys.ts`, `src/ui/toolKeys.test.ts`, `src/main.ts` | 依存: QE-T11)
  - `documentSurface.render()` が `stampNumbers()` を 1 回求めて番号スタンプに渡す。下書きの新しい番号は「今の番号スタンプの数 + 1」
  - `shapeTools.ts`: スタンプツールで押した位置に下書き、離した位置で `addShapeObject()`(1 手)。選択の輪(円の外側 4px、白の実線 + 濃い破線 `[4,3]`)をオーバーレイに。カーソル(上 `move`・空白 `crosshair`)
  - 上限の通知: `bindShapeTools()`・`bindTextTool()` に `onObjectLimit` を渡し、`main.ts` が `showToast("注釈は 50 個までです。いらない注釈を消してから置いてください。", "error")` を結ぶ(`canvas/` → `ui/` を作らない。【要確認】#5)
  - `toolSettings.stampKind`(既定 `"number"`、取り消し対象外・非永続)。ツールバーにスタンプのボタン(UI §1.2 のアイコン、テキストの直後)、`TOOL_KEYS` に `KeyN`
  - TDD(先に書くテスト): `stampKind` の既定と変更・購読 / `TOOL_KEYS` に N が入り表の整合テストが緑 / 下書きの番号 / 上限で `onObjectLimit` が呼ばれる(偽の `addShapeObject` が `null` を返す)
  - 受け入れ基準:
    - [ ] 上記テストが緑、`SMOKE` 緑、`NODEPS` 出力なし、`LAYER`
  - 検証コマンド: `npx vitest run src/canvas/toolSettings.test.ts src/ui/toolKeys.test.ts` / `LAYER` / `SMOKE` / `NODEPS`

#### Phase 3d(QE-T12 完了後)

- [ ] QE-T13 — スタンプの種類の選択・E2E・見た目(UI §2.1・§2.2)(変更ファイル: `src/ui/stampKindPicker.ts`, `src/ui/stampKindPicker.test.ts`, `index.html`, `src/styles.css`, `src/main.ts`, `e2e/stamp.spec.ts`, `e2e/screenshots/quickEdits.visual.ts`, `docs/docs/data-model.md`, `docs/docs/architecture.md`, `docs/docs/development-patterns.md` | 依存: QE-T12)
  - `initStampKindPicker(mount)`: 5 ボタン(`スタンプ 番号` など)、`aria-pressed`、`data-preserve-selection`。スタンプツールの間だけ表示し、重ね順の後ろ(区切り線 1 本)。選択中のスタンプは変えない
  - TDD(先に書くテスト): 種類 → `aria-label` / 表示条件(スタンプツールのときだけ)の純粋関数 / E2E(先に Red): 番号を 3 つ置く → 1・2・3 → 2 番目を消す → 1・2 → ⌘Z で 1・2・3 → 色・文字サイズの変更 → 記号に切り替えて置いても次の番号は 4 → ⌘⇧B で番号が変わらない → 種類を出し入れしても色・文字サイズ・重ね順のボタンの位置が変わらない / 番号の読み取りは画素の比較ではなく、注釈の状態を読むテスト用の口があれば使い、無ければ見た目の比較で確かめる
  - 見た目(`quickEdits.visual.ts`): 番号 1 桁・2 桁と記号 4 種 × 小・中・大、明るい画像・暗い画像、黄の丸の黒い記号、選択の輪
  - 受け入れ基準:
    - [ ] 上記テストが緑、`SMOKE` 緑、`NODEPS` 出力なし
    - [ ] スクリーンショットを `output/reports/ui/` に保存し、UI §2 のモックと見え方が一致する(差があれば理由を PROGRESS に記す)
    - [ ] docs: `StampShape`・`stampKind`・`stampNumbers()` の約束(数字は持たず `id` の順位)、新モジュールとテスト
  - 検証コマンド: `npx vitest run src/ui/stampKindPicker.test.ts` / `npx playwright test e2e/stamp.spec.ts` / `npx playwright test --config=e2e/screenshots/playwright.config.ts e2e/screenshots/quickEdits.visual.ts` / `SMOKE` / `NODEPS`

### Phase 4 — スポットライト(FR-008〜FR-010)

#### Phase 4a(並行可能。いつ着手してもよい)

- [ ] QE-T14 — 暗くする矩形の集合 `spotlightShadeRects()`(ARCH §1.3 #8)(変更ファイル: `src/canvas/spotlight.ts`, `src/canvas/spotlight.test.ts` | 依存: なし)
  - 穴の端の座標で縦横に区切り、どの穴にも入らないマスを横につないで返す。`SPOTLIGHT_SHADE = "rgba(0, 0, 0, 0.5)"`(UI §3.1)
  - TDD(先に書くテスト): 穴 0 個 → 画像全体の 1 矩形 / 1 個 → 補集合 / 2 個の重なり・接する・離れる / 画像の外へはみ出した穴は画像に切り詰める / 端数の座標 / **性質テスト**: 乱数(固定シード)の穴 1〜50 個で、返す矩形が互いに重ならず、面積の和が「画像 − 穴の和」と一致し、どの穴とも重ならない / 50 個で矩形の数が (2×50+1)² 以下
  - 受け入れ基準:
    - [ ] 上記テストが緑、`SMOKE` 緑、`NODEPS` 出力なし、`LAYER`
  - 検証コマンド: `npx vitest run src/canvas/spotlight.test.ts` / `LAYER` / `SMOKE` / `NODEPS`

#### Phase 4b(Phase 3・QE-T14 完了後)

- [ ] QE-T15 — 穴をオブジェクトの種類に加え、合成に暗さの段を足す(ARCH §1.3 #9・§5.3)(変更ファイル: `src/canvas/canvasState.ts`, `src/canvas/shapeEdit.ts`, `src/canvas/shapeEdit.test.ts`, `src/canvas/objectModel.ts`, `src/canvas/objectModel.test.ts`, `src/canvas/documentState.ts`, `src/canvas/documentState.test.ts`, `src/canvas/documentSurface.ts` | 依存: QE-T11, QE-T14)
  - `ToolId` に `"spotlight"`。`SpotlightShape { kind: "spotlight"; rect }`。四隅のハンドル、未選択時は枠の付近だけ掴める、ツールなしのときも枠の付近だけ(ARCH §5.3 の表)。スポットライトツールでは穴だけを掴む
  - `pickBurnTarget()` が穴も飛ばす。`setSelectedColor()`・`setSelectedFontSize()` は穴では何もしない(`false`)
  - 合成: ベース → `spotlightShadeRects()` を 1 本のパスで 1 回塗る → 穴以外の注釈(重ね順)→ 穴以外の下書き。下書きの穴も暗さに含める。穴そのものは何も描かない
  - TDD(先に書くテスト): 穴のハンドル 4 つ / 内側のクリックで掴まない・枠の付近で掴む / 上限で穴と番号スタンプを飛ばす・全部が穴なら `null` / 色・文字サイズは穴で `false` / 合成の順(偽の `ctx` の呼び出し順で、塗りが 1 回・注釈より前)/ 穴 0 個なら塗らない
  - 受け入れ基準:
    - [ ] 上記テストと既存テストが緑、`SMOKE` 緑、`NODEPS` 出力なし、`LAYER`
    - [ ] 自動マスキングが読むのはベース(`exportDocumentBase()`)のままで、暗さの段を通らない(コードで確認)
  - 検証コマンド: `npx vitest run src/canvas/shapeEdit.test.ts src/canvas/objectModel.test.ts src/canvas/documentState.test.ts` / `LAYER` / `SMOKE` / `NODEPS`

#### Phase 4c(QE-T15 完了後)

- [ ] QE-T16 — スポットライトのツール・E2E・見た目(UI §3)(変更ファイル: `src/canvas/tools/shapeTools.ts`, `src/ui/toolbar.ts`, `src/ui/toolKeys.ts`, `src/ui/toolKeys.test.ts`, `e2e/spotlight.spec.ts`, `e2e/screenshots/quickEdits.visual.ts`, `docs/docs/data-model.md`, `docs/docs/architecture.md`, `docs/docs/development-patterns.md` | 依存: QE-T15)
  - ドラッグで穴の下書き → 離して `addShapeObject()`(上限は QE-T12 の通知)。選択は四隅の丸ハンドル + 白の実線と濃い破線の枠。ツールバーにボタン(UI §1.2、モザイクの後ろ)、`TOOL_KEYS` に `KeyS`
  - TDD(先に書くテスト): 表の整合テストに S / E2E(先に Red): 穴を 2 つ(重なりあり)→ コピーされる画像の画素で、穴の中は元のまま・外は 1 段階(元の画素 × 0.5 ±1)・重なりも暗くない・穴の外の矢印は明るい → 移動・リサイズ・削除がそれぞれ 1 手 → 最後の穴を消すと暗さが消える → 選択の枠がコピーに写らない → 履歴のサムネイルに暗さが写る
  - 見た目: 穴 2 つ(重なり)・選択中の穴、明るい画像・暗い画像
  - 受け入れ基準:
    - [ ] 上記テストが緑、`SMOKE` 緑、`NODEPS` 出力なし
    - [ ] docs: `SpotlightShape`・暗さの塗り方の規約(1 本のパスで 1 回だけ塗る)、上限で焼き込まない種類
  - 検証コマンド: `npx vitest run src/ui/toolKeys.test.ts` / `npx playwright test e2e/spotlight.spec.ts` / `npx playwright test --config=e2e/screenshots/playwright.config.ts e2e/screenshots/quickEdits.visual.ts` / `SMOKE` / `NODEPS`

### Phase 5 — トリミング(FR-005〜FR-007、ADR-002)

#### Phase 5a(Phase 4 完了後)

- [ ] QE-T17 — 注釈の大きさを `shapeStyleDiagonal()` から決める(ADR-002「注釈の大きさの基準」)。動作は変えない下準備(変更ファイル: `src/canvas/shapeEdit.ts`, `src/canvas/tools/arrowTool.ts`, `src/canvas/tools/arrowTool.test.ts`, `src/canvas/tools/rectangleTool.ts`, `src/canvas/tools/rectangleTool.test.ts`, `src/canvas/tools/ellipseTool.ts`, `src/canvas/tools/ellipseTool.test.ts`, `src/canvas/tools/textLayout.ts`, `src/canvas/tools/textLayout.test.ts`, `src/canvas/tools/textTool.ts`, `src/canvas/tools/stampShape.ts`, `src/canvas/documentSurface.ts`, `src/canvas/tools/shapeTools.ts`, `src/canvas/documentState.ts`, `project-config.md`(§11) | 依存: QE-T16)
  - 全種類の形に任意の `styleBasis?: number`。太さ・文字の大きさ・直径の関数(ARCH が示す `arrowTool.ts:122-125`・`textLayout.ts:61-68`・`rectangleTool.ts:72-75` など)が幅・高さではなく対角線を受け取り、呼び出し元は `shapeStyleDiagonal(shape, w, h)` を渡す。`setSelectedFontSize()` の測り直しも同じ
  - `shapeUndoRect()`(焼き込み・範囲外の判定に使う)も同じ対角線で線の太さ・影を見積もる
  - TDD(先に書くテスト): 各関数で `styleBasis` 無しのとき今と同じ値(既存テストがそのまま緑)/ `styleBasis` 有りのとき、画像の大きさが変わっても太さ・文字の大きさ・直径が変わらない / `rg -n 'Math\.hypot\(' src/canvas/tools` で、対角線を直接計算する箇所が `styleBasis.ts` 経由に置き換わった(残すものは理由をコメント)
  - 受け入れ基準:
    - [ ] 上記テストと既存テストが緑、`SMOKE` 緑(既存の見た目の E2E を含む)、`NODEPS` 出力なし
    - [ ] §11 に「注釈の大きさを画像の今の大きさから毎回計算していた。大きさが変わる操作では `shapeStyleDiagonal()` を通す」(重複確認のうえ)
  - 検証コマンド: `npx vitest run src/canvas` / `rg -n 'Math\.hypot\(' src/canvas` / `SMOKE` / `NODEPS`

#### Phase 5b(QE-T17 完了後。QE-T18 と QE-T19 は並行可能)

- [ ] QE-T18 — モザイクの粗さを撮った時点の大きさ `captureSize` で決める(ADR-002「モザイクの粗さ」)(変更ファイル: `src/canvas/documentState.ts`, `src/canvas/documentState.test.ts`, `src/canvas/tools/mosaicTool.ts`, `src/canvas/tools/mosaicTool.test.ts`, `src/ui/autoMask.ts`, `src/ui/autoMask.test.ts` | 依存: QE-T17)
  - `DocumentState`(または `documentState` のモジュール変数)に `captureSize`。`resetDocument()` で画像の大きさ、`restoreDocument()` で退避の値(`DocumentSnapshot` に追加。古い退避で無ければ画像の大きさ)
  - `mosaicTool.ts:306` と `autoMask.ts:277` の `pixelateRect(..., width, height)` を `captureSize` に替える
  - TDD(先に書くテスト): 新規・退避からの復元で `captureSize` が正しい / 退避に入る / ベースの大きさが変わっても(偽の `PixelStore` で大きさを変える)モザイクのブロックの大きさが変わらない / 自動マスキングの一括モザイクも同じ
  - 受け入れ基準:
    - [ ] 上記テストと既存テストが緑、`SMOKE` 緑、`NODEPS` 出力なし、`LAYER`
  - 検証コマンド: `npx vitest run src/canvas/documentState.test.ts src/canvas/tools/mosaicTool.test.ts src/ui/autoMask.test.ts` / `SMOKE` / `NODEPS`
- [ ] QE-T19 — 範囲の整数化と注釈の計画 `crop.ts`、はみ出した注釈の移動(ARCH §5.1・§5.3・§7.1 C-3)(変更ファイル: `src/canvas/crop.ts`, `src/canvas/crop.test.ts`, `src/canvas/shapeEdit.ts`, `src/canvas/shapeEdit.test.ts` | 依存: QE-T17)
  - `normalizeCropRect(rect, w, h)`: 各辺を四捨五入して `[0, 幅] × [0, 高さ]` に収める。幅・高さ 0 または全体と同じなら「何もしない」
  - `planCrop(objects, rect, w, h): CropPlan`: 描画範囲(`shapeUndoRect()`)が範囲と重ならなければ「消す」、重なれば範囲の左上の分だけずらし、`styleBasis` が無ければ切る前の対角線を付ける(有れば変えない)。スタンプは中心、穴は矩形をずらす
  - `moveShape()` の範囲を `[min(0, -左端), max(0, 幅 - 右端)]` に
  - TDD(先に書くテスト): 四捨五入・画像外の切り詰め・負の幅(逆向きのドラッグ)/ 0・全体で何もしない / 全種類のずらし / 一部はみ出しは残る・完全に外は消す・線の端が掛かる矢印は残る / `styleBasis` を付ける・2 回目は変えない / はみ出した注釈の移動で範囲が逆転せず、はみ出しを増やす方向には動かない / 画像の内側の注釈は今と同じ範囲
  - 受け入れ基準:
    - [ ] 上記テストと既存テストが緑、`SMOKE` 緑、`NODEPS` 出力なし
    - [ ] `crop.ts` が `documentState.ts` を import していない(ARCH §3.2)
  - 検証コマンド: `npx vitest run src/canvas/crop.test.ts src/canvas/shapeEdit.test.ts` / `rg -n 'documentState' src/canvas/crop.ts`(0 件)/ `SMOKE` / `NODEPS`

#### Phase 5c(QE-T18・QE-T19 完了後)

- [ ] QE-T20 — `crop` コマンドと `applyCrop()`(ARCH §5.4・§7.1 C-3〜5、ADR-002「取り消しの手の形」)(変更ファイル: `src/canvas/commands.ts`, `src/canvas/commands.test.ts`, `src/canvas/documentSurface.ts`, `src/canvas/documentState.ts`, `src/canvas/documentState.test.ts`, `src/history/documentArchive.ts`, `src/history/documentArchive.test.ts` | 依存: QE-T18, QE-T19)
  - `PixelStore.swapAll(image)`(ベースと表示 canvas を `image` の大きさにして書き、前のベース全体を返す)。`{ type: "crop"; rect; image }` の取り消し・やり直しは `swapAll` の入れ替え
  - `applyCrop(rect)`: `normalizeCropRect` → 何もしないなら終わり → `planCrop` → `surface.read(rect)` → `swapAll` → `group[crop, update…(配列順), remove…(先頭から、消した時点の index)]` を 1 手 → 消えた注釈を選んでいたら選択を外す → 通知。`captureSize` は変えない
  - `commandPixelBytes()` が `crop` の `image` を数える
  - TDD(先に書くテスト。既存の偽の `PixelStore` に `swapAll` を足す): 確定で大きさ・注釈の位置・消えた注釈 / 1 回の undo で元の大きさ・位置・消えた注釈が戻る / redo で再び / **トリミングより前の `pixels`(モザイク)・`add` を続けて戻せる** / 何もしない範囲で手が積まれない / 2 回のトリミングと undo 2 回 / `commandPixelBytes` / `trimUndoToBudget()` で `crop` が捨てられるとそれより古い手も捨てられ、後の手は残る
  - 受け入れ基準:
    - [ ] 上記テストと既存テストが緑、`SMOKE` 緑、`NODEPS` 出力なし、`LAYER`
  - 検証コマンド: `npx vitest run src/canvas/commands.test.ts src/canvas/documentState.test.ts src/history/documentArchive.test.ts` / `LAYER` / `SMOKE` / `NODEPS`

#### Phase 5d(QE-T20 完了後)

- [ ] QE-T21 — 確定前の範囲 `cropSession` とトリミングツール(ARCH §5.1・§6.3・§7.1 C-1〜2・C-6、UI §4.1)(変更ファイル: `src/canvas/canvasState.ts`, `src/canvas/cropSession.ts`, `src/canvas/cropSession.test.ts`, `src/canvas/tools/cropTool.ts`, `src/canvas/tools/cropTool.test.ts`, `src/ui/toolbar.ts`, `src/ui/toolKeys.ts`, `src/ui/toolKeys.test.ts` | 依存: QE-T20)
  - `ToolId` に `"crop"`。`cropSession`: `beginCrop`・`updateCropRect`(画像の内側に収める)・`cancelCrop`・`getCropSession`・`subscribeCropSession`
  - `bindCropTool(canvas)`: ドラッグで範囲、8 つのハンドル(四隅はかぎ形・四辺の中央は棒、当たり半径 10px)でリサイズ、内側で移動、カーソル(UI §4.1)。オーバーレイ(`pointer-events: none`)に範囲外の暗さ `CROP_SHADE = rgba(0,0,0,0.6)`・白の枠・ハンドル。Enter で `applyCrop()` → `cancelCrop()` とトースト「切り抜きました。⌘Z で戻せます。」(通知は `onCropped` で `main.ts` から受ける。【要確認】#5 と同じ形)、Esc で `cancelCrop()`。範囲が無いときの Enter / Esc は何もしない
  - やめる条件の購読: ツールの変化・自動マスキングの開始(`maskSession`)・ドキュメントの大きさの変化で `cancelCrop()`
  - ツールバーにボタン(UI §1.2、最後)、`TOOL_KEYS` に `KeyC`
  - TDD(先に書くテスト): セッションの遷移と購読 / ハンドルの当たり判定(隅・辺・内側・外側)とリサイズ後の範囲(逆転しない・画像内)/ やめる条件 3 つ / 自動マスキングの処理中・確認中はツールボタンが無効でトリミングを始められない(`toolButtonState`)/ 表の整合テストに C
  - 受け入れ基準:
    - [ ] 上記テストが緑、`SMOKE` 緑、`NODEPS` 出力なし、`LAYER`(`cropSession.ts` が `ui/`・`ipc/` を import しない)
  - 検証コマンド: `npx vitest run src/canvas/cropSession.test.ts src/canvas/tools/cropTool.test.ts src/ui/toolKeys.test.ts` / `LAYER` / `SMOKE` / `NODEPS`

#### Phase 5e(QE-T21 完了後)

- [ ] QE-T22 — 確定・やめるの帯と画面への結線(UI §4.2・§4.3、ARCH §11・§15 #4)(変更ファイル: `src/ui/cropBar.ts`, `src/ui/cropBar.test.ts`, `index.html`, `src/styles.css`, `src/main.ts`, `src/ui/undoButton.ts`, `src/ui/undoButton.test.ts`, `src/ui/autoMask.ts`, `src/ui/autoMask.test.ts` | 依存: QE-T21)
  - `initCropBar(mount)`: `<div id="crop-bar" class="crop-bar" hidden>` をツールバー直後に。トリミングツールを選んだ時点で出す。状態の文(範囲なし / `残す範囲 W × H` + 補足 / `画像全体と同じ範囲です`)、「やめる」`<kbd>esc</kbd>`・「確定」`<kbd>return</kbd>`(何もしない範囲では `disabled`)。`role="status"` の更新はポインタを離したときだけ
  - `main.ts`: `initCropBar()`・`bindCropTool(canvasEl)`(`bindSelectionKeys()` より**前**)、`handleCaptureCompleted`・`reloadHistoryItemIntoCanvas`・`clearEditor` の画像を差し替える前に `cancelCrop()`(`discardMaskSession()` の隣)
  - `undoButton.ts`: 範囲の指定中の ⌘Z / ⇧⌘Z とボタンは `cancelCrop()` だけ
  - `autoMask.ts`: ドキュメントの大きさが変わったら候補を捨てる(防御)
  - TDD(先に書くテスト): 帯の文言の組み立て(範囲なし・あり・全体と同じ、寸法は `normalizeCropRect` 後の整数・半角・`×` の前後に空白)と確定ボタンの可否 / ⌘Z の判定(指定中は `cancel`、指定なしは今どおり)/ 大きさの変化で候補が捨てられる
  - 受け入れ基準:
    - [ ] 上記テストと既存テストが緑、`SMOKE` 緑、`NODEPS` 出力なし、`LAYER`
  - 検証コマンド: `npx vitest run src/ui/cropBar.test.ts src/ui/undoButton.test.ts src/ui/autoMask.test.ts` / `LAYER` / `SMOKE` / `NODEPS`

#### Phase 5f(QE-T22 完了後)

- [ ] QE-T23 — トリミングの E2E・他の機能との組み合わせ・見た目・docs(FR-005〜FR-007、ARCH §10.2)(変更ファイル: `e2e/crop.spec.ts`, `e2e/screenshots/quickEdits.visual.ts`, `e2e/fixtures/tauriMock.ts`(必要時), `docs/docs/project.md`, `docs/docs/architecture.md`, `docs/docs/data-model.md`, `docs/docs/development-patterns.md` | 依存: QE-T22)
  - E2E(先に書いて Red を確認し、足りない結線は QE-T22 の範囲で直してコミットに含め、PROGRESS に記す): 範囲を囲む → Esc で変わらない → 囲み直して Enter → canvas の大きさが範囲の整数の大きさ・注釈の位置が合う(画素)→ 完全に外の注釈が消え、番号が詰まる → ⌘Z で大きさ・位置・消えた注釈・番号が戻る → ⇧⌘Z → 確定前の ⌘C は元の大きさ → トリミングより前のモザイクも続けて戻せる → 範囲の指定中の ⌘Z は指定をやめるだけ → 自動マスキングの確認中はトリミングを始められない → 確定後のコピー・履歴のサムネイルは切り詰め後 → 履歴を切り替えて戻っても続きの操作・取り消しができる → 縮めてコピーがオンなら切り詰め後の大きさの半分 → 切る前に描いた矢印の太さが変わらない・モザイクの粗さが変わらない
  - 見た目: トリミングの確定前(明るい地・暗い地)と帯の 3 状態
  - 受け入れ基準:
    - [ ] `npm run e2e` で新規シナリオを含め全件緑。確定前の表示がコピーに写らないことは、オーバーレイを合成に描くと落ちることを一度確かめる
    - [ ] スクリーンショットを `output/reports/ui/` に保存
    - [ ] docs: `crop` コマンド・`cropSession`・`captureSize`・`styleBasis`、規約(大きさは `shapeStyleDiagonal()`、モザイクは `captureSize`)、新モジュールとテスト一覧
  - 検証コマンド: `npx playwright test e2e/crop.spec.ts` / `npx playwright test --config=e2e/screenshots/playwright.config.ts e2e/screenshots/quickEdits.visual.ts` / `SMOKE` / `NODEPS`

### Phase 6 — 実機確認(Phase 5 完了後。人間の操作あり)

- [ ] QE-T24 — 実機確認(NFR-001・NFR-004、ARCH §10.3、PRD §8.3)(変更ファイル: `testreport/manual/CHECKLIST_T18.md`(§14 を追加、git 管理外), `output/reports/quick-edits/MANUAL_quick-edits_<日付>.md`, 必要時 `src/canvas/spotlight.ts`・`src/canvas/tools/cropTool.ts`(暗さの定数) | 依存: QE-T23)
  - Claude が `CHECKLIST_T18.md` に §14 を足し(手順・期待・結果の欄)、人間が実機で行う。結果を受けて Claude が記録をまとめる
  - 項目: ①**成功条件(NFR-001)**: 撮る → 番号スタンプ 3 つ → トリミング → スポットライト → コピー → 他のアプリへ貼る を、縮めてコピーのオン/オフで。貼り付け先で番号・暗さ・切り抜き・大きさを目視 ②スポットライトの暗さ: 明るい画面・暗い画面のキャプチャで「周りの文字がうっすら読める」か。暗い画面で弱ければ `SPOTLIGHT_SHADE` を 60%・`CROP_SHADE` を 70% にする(UI 【要確認】#3 の決定) ③縮めたモザイク: 倍率 2 の画面の小さい文字にモザイク → 縮めてコピー → 貼った先で読めない ④縮めてコピーの倍率: 倍率 2・倍率 1(あれば)・両方を接続した状態で撮った画像の貼り付け後の大きさ(QE-T01 で未確認の行があればここで) ⑤ドラッグの追従(NFR-004): 倍率 2 の画面の全画面キャプチャで、穴とトリミング範囲のドラッグ中の表示 ⑥日本語入力がオンの状態で 8 キー ⑦既定の窓幅 1080px で 1 段、狭めて 2 段
  - 受け入れ基準:
    - [ ] 記録に各項目の結果・機種・OS の版・画面の倍率がある(画像を載せる場合は架空の画面のみ)
    - [ ] fail があれば修正タスク(QE-T24-F1 …)を PROGRESS に追加
    - [ ] 暗さの定数を変えた場合は `SMOKE` 緑(見た目の E2E の更新を含む)
  - 検証コマンド: (定数を変えた場合)`SMOKE` / `NODEPS`

### Phase 7 — 仕上げ(QE-T25 は QE-T23 完了後、QE-T26 は QE-T24・QE-T25 完了後。【要確認】#6)

- [ ] QE-T25 — 機能全体のセキュリティ確認とレビュー(`/security-scan`・`/review-sweep`)。指摘の修正は別タスク(QE-T25-F1 …)として PROGRESS に追加する(変更ファイル: `output/reports/security/SECURITY_quick-edits_<日時>.md`, `output/reports/review/REVIEW_quick-edits_<日時>.md` | 依存: QE-T23)
  - 確認項目: ARCH §12 の全項目(保存するのは `shrinkCopy` だけ・設定の書き込みは `SettingsStore` だけ・一時ファイル方式のまま / PNG の解析の境界(チャンク長・ファイルの残り・パニックしない)/ モザイクを弱めない(`captureSize`)/ 新しい文言は `textContent`、スタンプは固定の記号だけ / ログを足していない)/ `NODEPS` 出力なし / `git diff 52b2835 -- src-tauri/tauri.conf.json` が `width` の 1 行だけ / `STORAGE` 0 件 / `LAYER` / 1 キー切替が入力欄・IME・設定画面で効かないこと / 他社の製品名・サービス名が差分に無いこと(目視)
  - `/review-sweep` の観点: 正確性(取り消しの順序・大きさの変化・番号の詰め)、要件(FR・ARCH §15・UI の決定との対応)、テスト、docs の同期
  - 受け入れ基準:
    - [ ] Critical / High が 0 件(または修正タスクが PROGRESS にある)
    - [ ] レビューの MUST が 0 件(または修正タスクが PROGRESS にある)
  - 検証コマンド: `NODEPS` / `STORAGE` / `LAYER` / `git diff 52b2835 -- src-tauri/tauri.conf.json` / `SMOKE`
- [ ] QE-T26 — README・紹介ページ・ADR・ARCH・docs の仕上げ(PRD Phase 6)(変更ファイル: `README.md`, `.github/pages/index.html`, `docs/media/*`, `e2e/screenshots/landing.visual.ts`(必要時), `output/design/ADR_002_crop-undo-and-style-basis.md`, `output/design/ARCH_quick-edits.md`(§17「実装での決定」を追加), `docs/docs/*.md`, `project-config.md`(§2・§3・§11) | 依存: QE-T24, QE-T25)
  - README・紹介ページに 4 機能とキーの一覧(UI §7)を足す。画像は架空の画面で撮る(`docs/media/`)。他社の製品名を書かない、他製品との比較を書かない
  - ADR-002: ステータスに実装済みの旨と、実装で前提が変わった点(あれば)。ARCH §17: 実装での決定(QE-T01 の結果、暗さの最終値、`onObjectLimit` の形、`tauri.conf.json` の窓幅など)
  - 各タスクで更新してきた `docs/docs/*.md` の整合を確認し不足を埋める。`project-config.md` §2・§3 は変更なしを確認
  - 受け入れ基準:
    - [ ] `rg -n -e 'スタンプ' -e 'スポットライト' -e 'トリミング' -e '等倍' README.md .github/pages/index.html` で 4 機能が両方に載り、README にキーの一覧(UI §7)がある
    - [ ] 紹介ページを幅 1280px・390px で描画して横はみ出し 0・ページのエラー 0
    - [ ] `SMOKE` 緑、`NODEPS` 出力なし
  - 検証コマンド: 上記 `rg` / `npx playwright test --config=e2e/screenshots/playwright.config.ts e2e/screenshots/landing.visual.ts` / `SMOKE` / `NODEPS`

## 依存関係グラフ

```text
[0 実機]  T01 ─🚏─────────────────────→ T04
[1 キー]  T02 ──→ T03
[2 縮小]  T04 ──→ T05 ──┐
          T06 ──────────┼──→ T08 ──→ T09
          T07 ──────────┘
[3 スタンプ] T10 ──→ T11 ──→ T12 ──→ T13
[4 穴]       T14 ──────────→ T15 ──→ T16
                    (T11) ──┘
[5 切る]     T16 ──→ T17 ──┬──→ T18 ──┐
                           └──→ T19 ──┴──→ T20 ──→ T21 ──→ T22 ──→ T23
[6 実機]     T23 ──→ T24 ─🚏─┐
[7 仕上げ]   T23 ──→ T25 ────┴──→ T26

順序のための依存(ファイルの重なり・Phase の順): T03 → T08(main.ts)、T08 → T11(canvasState.ts)、T13 → T15(Phase 3 → 4)、T16 → T17(Phase 4 → 5)
```

(🚏 = 人間の確認で止まる箇所。ID の `QE-` は省略)

依存の一覧(グラフの読み取り補助):

| タスク | 依存 | 並行して進められる相手(変更ファイルが重ならない) |
| ------ | ---- | ------------------------------------------------ |
| QE-T01 | なし | T02・T06・T07・T10・T14 |
| QE-T02 | なし | T01・T06・T07・T10・T14 |
| QE-T03 | T02 | T01・T06・T07・T10・T14 |
| QE-T04 | T01(判定が「進む」) | T06・T07・T10・T14 |
| QE-T05 | T04 | T06・T07・T10・T14 |
| QE-T06 | なし | T01〜T05・T07・T10・T14 |
| QE-T07 | なし | T01〜T06・T10・T14 |
| QE-T08 | T05, T06, T07(と Phase 1) | T10・T14 |
| QE-T09 | T08 | T10・T14 |
| QE-T10 | なし | Phase 0〜2 のすべて・T14 |
| QE-T11 | T10(と Phase 2) | T14 |
| QE-T12 | T11 | T14 |
| QE-T13 | T12 | T14 |
| QE-T14 | なし | Phase 0〜3 のすべて |
| QE-T15 | T11, T14(と Phase 3) | — |
| QE-T16 | T15 | — |
| QE-T17 | T16 | — |
| QE-T18 | T17 | T19 |
| QE-T19 | T17 | T18 |
| QE-T20 | T18, T19 | — |
| QE-T21 | T20 | — |
| QE-T22 | T21 | — |
| QE-T23 | T22 | — |
| QE-T24 | T23 | T25 |
| QE-T25 | T23 | T24 |
| QE-T26 | T24, T25 | — |

推奨の実行順(逐次): T01(人間の撮影を依頼)→ T02 → T03 → T06 → T07 → T04(T01 の判定後)→ T05 → T08 → T09 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17 → T18 → T19 → T20 → T21 → T22 → T23 → T25 → T24(人間)→ T26

- T01 は人間の撮影待ちになりうるため、依頼したら T02 から進める。T04 だけが T01 の判定を待つ
- Phase 3・4 が終わった時点で「番号付きの手順画像を作って貼る」成功条件の大半が成り立つ(PRD §9)。山場は Phase 5(T17〜T23)

## テスト戦略

### ユニットテスト

- **TS(Vitest、コロケーション)**: 1 キー切替の判定(各キー・修飾キー・`repeat`・IME・入力欄・確認中・描画中・画像なし)と表の整合 / `shrunkSize`・`copyRatio` / IPC の応答の正規化 / スタンプの直径・記号の色・番号(置いた順・詰め・取り消し・記号を数えない・重ね順で変わらない)/ `spotlightShadeRects`(性質テスト: 互いに重ならない・面積の和が補集合と一致)/ 上限の焼き込みの選び方と 51 個目 / `shapeStyleDiagonal` と各ツールの大きさ(`styleBasis` 有無)/ `captureSize` / `normalizeCropRect`・`planCrop`・はみ出した注釈の移動 / `crop` の undo/redo(偽の `PixelStore` に `swapAll`。トリミングより前の手を続けて戻せる)/ `commandPixelBytes`・`trimUndoToBudget` / 帯の文言 / 設定画面の保存の結果
- **Rust(`cargo test`)**: `pixel_ratio_from_png` の境界(72 / 144 / ±2% / 無し / 単位 / 縦横 / 署名 / 長さの異常 / IDAT の後 / 途中で切れる)、`SettingsStore`(項目なし → オフ、オフは書かない、**ショートカットの変更で `shrinkCopy` が消えない**・逆も同じ、保存失敗で戻す)
- 方針: DOM が要るものは純粋関数に分けてテストし、DOM 自体は E2E で確かめる(jsdom は入れない。既存方針)

### E2Eテスト

- `e2e/tool-keys.spec.ts`(T02)・`shrink-copy.spec.ts`(T08・T09)・`stamp.spec.ts`(T13)・`spotlight.spec.ts`(T16)・`crop.spec.ts`(T23)。シナリオは各タスクの TDD 欄と ARCH §10.2
- コピー結果の確認は既存の IPC モックでクリップボードへ渡った RGBA の大きさ・画素を読む(`e2e/fixtures/canvasSnapshot.ts` の作法)
- 見た目: `e2e/screenshots/quickEdits.visual.ts`(スタンプ・穴・トリミングの表示)、`toolbar.visual.ts`(1 段・2 段)
- 既存 E2E: ツール名の変更(T02)・「キーを既定に戻す」(T09)・ツールバーの並び(T03)で壊れないことを各タスクの `SMOKE` で確認

### 手動確認(実機)

- T01(pHYs)と T24(成功条件・暗さ・縮めたモザイク・倍率・ドラッグの追従・日本語入力・窓幅)

## ドキュメント更新計画

一次更新は各結線タスク(`/implementing-features`)が最小差分で行う。並行可能なタスクは docs を触らない(共通ルール)。

### project-config.md

- §2(技術スタック)・§3(コマンド): 変更なし(依存もコマンドも増えない。T26 で確認)
- §11(既知の落とし穴): T05「設定の保存がファイル全体の書き換えで、項目を足すと他の項目が消えた(`SettingsStore` で 1 項目だけ変える)」/ T17「注釈の大きさを画像の今の大きさから毎回計算していた(大きさが変わる操作では `shapeStyleDiagonal()`、モザイクは `captureSize`)」(追記前に重複確認)

### docs/

- `docs/docs/project.md`: T02 ツールのキーの一覧 / T05 IPC コマンド表に `get_shrink_copy`・`set_shrink_copy`、`capture_screen` の `pixelRatio` / T23 ストア表に `cropSession`
- `docs/docs/architecture.md`: T08 `copyScale.ts`・`capture/pixel_ratio.rs` / T13 `stampShape.ts`・`styleBasis.ts`・`stampKindPicker.ts` / T16 `spotlight.ts` / T23 `crop.ts`・`cropSession.ts`・`cropTool.ts`・`cropBar.ts`・`toolKeys.ts`、各 E2E とテスト一覧
- `docs/docs/data-model.md`: T05 `settings.json` の `shrinkCopy` / T08 `CanvasImage.pixelRatio`・`HistoryItem.pixelRatio`・`CaptureResult.pixelRatio` / T13 `StampShape`・`stampKind` / T16 `SpotlightShape` / T23 `crop` コマンド・`captureSize`・`styleBasis`
- `docs/docs/development-patterns.md`: T05「設定は `SettingsStore` だけが書く」/ T13「番号は持たず `id` の順位で求める」/ T16「暗さは 1 本のパスで 1 回だけ塗る」/ T23「注釈の大きさは `shapeStyleDiagonal()`、モザイクの粗さは `captureSize`」
- `README.md`・`.github/pages/index.html`・ADR-002・ARCH §17: T26

## リスク・懸念事項

| リスク | 影響 | 対策(タスク) |
| ------ | ---- | -------------- |
| 撮影の PNG に pHYs が無い・値が違い、倍率が取れない | 中 | 最初に実機で確かめる(T01)。外れたら T04 を止めて人間に諮る(【要確認】#1)。倍率が不明なら縮めない側に倒れるため、今より悪くはならない |
| トリミングで画像の大きさが変わり、座標・大きさを持つ機能が壊れる | 高 | 下準備(T17・T18)→ 純粋関数(T19)→ コマンド(T20)→ UI(T21・T22)→ 組み合わせの E2E(T23)の順に分け、各段で既存テストを緑に保つ |
| 大きさの基準の置き換え(T17)で既存の見た目が微妙に変わる | 中 | `styleBasis` 無しで今と同じ値になるテストを先に書き、既存の見た目の E2E を `SMOKE` で通す |
| ツールボタンの名前の変更で既存 E2E が `exact: true` の箇所で落ちる | 低 | T02 で洗い出して直す(影響調査の 4 か所) |
| `canvas/` のツールから上限の通知を出すと `canvas/` → `ui/` の依存ができる | 中 | 通知はコールバックで `main.ts` から渡す(T12・T21、【要確認】#5) |
| `tauri.conf.json` を変えないとした ARCH §2 と、窓幅を広げる UI の決定が食い違う | 低 | 差分を `width` の 1 行に限り、T25 で確認、T26 で ARCH §17 に記録(【要確認】#3) |
| トリミングの取り消しが大きな画素を持ち、履歴を切り替えると古い手が取り消せなくなる | 中 | ADR-002 で許容済み(FR-007)。T20 で `trimUndoToBudget` の振る舞いをテストし、T23 で切替後に続きの操作ができることを E2E で確かめる |
| 50 個の上限の扱いを変えると、既存のテキスト・図形の追加にも `null` の経路ができる | 中 | T11 で呼び出し元 2 か所を `null` に対応させ、既存の上限のテストを緑に保つ。通知は全種類で同じ文言(UI §6) |
| 実機確認(T24)が人間の作業待ちで止まる | 中 | T25 は T23 の後に始められるようにする(【要確認】#6) |

## 【要確認】(ゲート 3 で人間が決める)

**決定(2026-10-10、人間)**: #1・#2 推奨(pHYs が想定外なら T04 だけ止めて相談、倍率 1 の外部画面が無ければ未確認で記録し T24 で確認)/ #3 `tauri.conf.json` は `width` の 1 行だけ変更を認める / #4 **変更ファイルが重ならないタスクは並行**で進め、届いた順に検証・コミット / #5 推奨(通知は main.ts からコールバックで渡す)/ #6 T25 は T23 の後に始める(T24 の実機確認を待たない)

| # | 項目 | 選択肢 | 推奨 | 影響タスク |
| - | ---- | ------ | ---- | ---------- |
| 1 | QE-T01 で pHYs が無い・値が想定と違う条件があったとき | **A**: QE-T04 を止め、結果を添えて ARCH §16 の代替(撮影の終わりの位置の画面の倍率を OS から取る)を人間に諮る。代替は既存の依存の機能の追加が要るおそれがあり、NFR-003 とも照らして決める / **B**: ARCH のまま進め、pHYs が無い条件では縮めない(今と同じ)ことを既知の制限として README に書く / **C**: 縮めてコピー(Phase 2)を見送る | **A**(ARCH §15 の方針どおり)。ただし外れたのが「ウィンドウの選択」など一部の条件だけなら B を併せて提案する。QE-T06・T07 は倍率の出どころに依存しないので止めない | T01・T04・T08 |
| 2 | 倍率 1 の外部の画面・2 つの画面をまたぐ範囲が手元で確かめられないとき | **A**: 倍率 2 の条件だけで QE-T04 に進み、倍率 1 の行は「未確認」と記録して QE-T24 / ゲート 4 で人間が確かめる / **B**: すべての条件が確かめられるまで QE-T04 を止める | **A**。倍率 1 の画像は縮めない(今と同じ)ので、取り違えても悪化しない。テストでは 72dpi の PNG を組み立てて境界を確かめる | T01・T04・T24 |
| 3 | 既定の窓幅の変更(UI 【要確認】#1 で決定)と、ARCH §2「`tauri.conf.json` は変更しない」の食い違い | **A**: `width` の 1 行だけの変更を認め、T25 で差分が 1 行であることを確かめ、T26 で ARCH §17 に記録する / **B**: 800px のまま(既定で 2 段に折り返す) | **A**。UI の決定が後で、権限・CSP には触れない。ARCH §2 の趣旨(権限・依存を増やさない)は保てる | T03・T25・T26 |
| 4 | 実装の進め方 | **A**: 既存どおり 1 タスクずつ逐次(「並行可能」は順番を入れ替えられる意味)/ **B**: 並行可能なタスクを別の作業ツリーで同時に進める | **A**。既存の運用と同じで、PROGRESS・docs の更新が衝突しない。B を選ぶ場合も表の「並行して進められる相手」の範囲に限る | 全体 |
| 5 | `canvas/` のツールから出す通知(上限の 51 個目・トリミングの確定)の渡し方(ARCH は「`shapeTools.ts` の通知」とだけ記載) | **A**: `bindShapeTools()`・`bindTextTool()`・`bindCropTool()` に `onObjectLimit` / `onCropped` のコールバックを渡し、`main.ts` がトーストを結ぶ / **B**: `documentState` に通知の購読口を足し、`ui/` 側が購読する | **A**。層の向き(`canvas/` → `ui/` 禁止)を守り、状態を増やさない。テストでは偽のコールバックで呼ばれたことを確かめられる | T12・T21・T22 |
| 6 | 仕上げの始め方(依頼の順は「実機確認 → セキュリティ・レビュー → 仕上げ」) | **A**: QE-T24(人間の実機確認)が終わってから QE-T25 を始める / **B**: QE-T25 は QE-T23 の後すぐ始め、QE-T24 と並行。QE-T26 は両方の後 | **B**。実機確認は人間の作業待ちで止まりやすい(自動マスキングの AM-T24 の前例)。T24 で変わりうるのは暗さの定数だけで、レビューの結論に影響しにくい | T24・T25・T26 |

- 上記以外の ARCH・UI の【仮定】(`SPOTLIGHT_SHADE` の最終値、`sips` の表示の扱い)は、実装・実機確認の中で確定し PROGRESS に記録する
- 版上げ・リリースは本タスク分解に含めない(QE-T26 の後に人間が決める)
