# UI見直し(T19)監査・変更まとめ

日付: 2026-09-24
対象: Tadcap フロントエンド(`index.html` / `src/styles.css` / `src/ui/*.ts` / `src/main.ts`)
参照: 外部の一般的なUIデザイン監査観点(既存プロジェクト向けの改善チェックリスト)と、
抑えたエディトリアル系ミニマルUIの方向性(いずれも一般的な設計指針として適用し、
本ドキュメント・コード中に固有の製品名・リポジトリ名は記載しない)。
併せて社内の `ui-ux-design` / `hig-compliance` スキルの観点も参照した。

## 1. 監査(Before)で見つかった主な問題

| # | 問題 | 該当 |
| - | ---- | ---- |
| 1 | ボタンがすべて文字ラベルのみで、キャプチャ画像より先に「文字の塊」が目に入る(「主役はキャプチャ画像、UIは脇役」に反する) | `index.html` 旧構成、`.toolbar`/`.tool-toolbar` |
| 2 | 権限バナーの文言が3文構成で説明的(手順を逐一書き下している) | `permissionBanner.ts::permissionBannerMessage()` |
| 3 | フィードバック文言(`#capture-status`/`#clipboard-status`)が通常のツールバー内`<p>`として常設領域を占有し、常設の説明文のように見える | `index.html` 旧構成 |
| 4 | 空状態(画像未読込)に案内が無く、ただの空白 | `.canvas-area`(旧) |
| 5 | ツールバーが2本(キャプチャ系・編集ツール系)に分かれ、罫線・背景色が重複していた | `.toolbar` + `.tool-toolbar`(旧) |
| 6 | フォーカスリングが `outline: none` で全面的に除去され、キーボード操作時の可視フォーカスが無い(アクセシビリティ要件) | `button { outline: none; }`(旧) |
| 7 | ボタンにhover/active(押下)フィードバックが無い(クリックしても状態変化が分かりにくい) | `button`(旧) |
| 8 | **重大**: `.permission-banner { display: flex; ... }` がUA既定の `[hidden] { display: none }` を上書きし、`hidden` 属性を設定してもバナーが常時表示される(T13のE2Eで検出済み、`project-config.md` §11に記録済みの既知不具合) | `src/styles.css`(旧、`e2e/capture-flow.spec.ts`) |
| 9 | 履歴サイドバーの選択状態・ツールの選択状態など、強調に使う色が定義上バラバラになりうる構造(アクセント色の一元管理が無い) | `--arrow-color` のみ定義、UIの強調色は個別ハードコード |

## 2. 適用した変更

- **アイコン中心のツールバーへ統合**: `.toolbar` 1本に集約し、キャプチャ・矢印・モザイク・クリップボードコピーをすべてインラインSVGのアイコンボタン(`.icon-button`)にした。文言は `aria-label`/`title`(ツールチップ)に退避し、アクセシビリティツリー上の名前は維持(`e2e/capture-flow.spec.ts` の `getByRole(..., { name: "矢印" })` 等はセレクタ変更なしで通過)。
- **Canvasを主役に**: ツールバーの高さを固定40pxに圧縮、履歴サイドバー幅を120px→88pxに圧縮。Canvas周囲の余白も縮小し、相対的にCanvas領域の比率を拡大した。
- **アクセント色を1色に統一**: `--accent-color: var(--arrow-color)`(複製ではなく参照)を追加し、選択中ツール・選択中履歴サムネイル・フォーカスリングのすべてをこの1色に統一した。権限バナーの警告色(赤系)は「ブランドのアクセント」ではなくHIG準拠の意味的な状態色(エラー)として明確に区別している。
- **説明文の削減**: 権限バナーの文言を3文→1文に短縮(「システム設定を開く」への言及と再起動の可能性のみ残す。ユニットテストが要求する文言は維持)。
- **フィードバックをトースト化**: `#capture-status`/`#clipboard-status` をツールバー内の常設領域から、画面右下固定・空文字時は非表示(`:empty{display:none}`)のトースト表示に変更。テキスト内容・IDはそのまま(E2Eの `toHaveText` アサーションは無変更で通過)。
- **空状態の追加**: 画像未読込時にCanvas上へ「⌘⇧2 でキャプチャ」の一言のみを表示(説明文なし)。表示切替は既存の `isClipboardCopyEnabled()` 判定(`state.image !== null`)を再利用し、ロジックを重複させていない。
- **フォーカスリング・hover/active状態の追加**: `:focus-visible` でのみアクセント色のフォーカスリングを表示(マウス操作時は非表示)。アイコンボタンにhover(淡い背景)・active(縮小+濃い背景)のフィードバックを追加。
- **フォント**: `Inter, Avenir, Helvetica, Arial` → `-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial`(システムフォント)に変更。
- **絵文字不使用・装飾記号不使用**: 全文言・アイコンにemoji不使用。emダッシュ等の装飾記号も使用していない。
- **不具合修正(重大)**: `src/styles.css` に `[hidden] { display: none !important; }` を追加した。個別セレクタを `:not([hidden])` 化する対症療法ではなく、`!important` により `[hidden]` を詳細度に関わらず常に最優先させる一元的な対策とした(同種の不具合を他要素にも作らないため)。これにより `e2e/capture-flow.spec.ts` の権限バナーテスト(以前は既知の理由でfailしていた `toBeHidden()` の行)が正しくpassするようになった。

## 3. 変更していないもの

- `src/ipc/*`・`src/canvas/tools/*`(矢印・モザイクの計算)・`src/history/historyStore.ts` のロジックは無変更。
- 矢印の既定色 `#ff5c8a`(`--arrow-color`)の値そのものは無変更(E2Eがピクセル色で検証しているため)。
- ライトテーマ固定の方針は維持(`prefers-color-scheme` 対応は追加していない)。
- 依存パッケージの追加なし。

## 4. Before / After スクリーンショット

`e2e/screenshots/capture.visual.ts`(`npm run e2e:screenshots:before` / `npm run e2e:screenshots:after`、
既存の `e2e/fixtures/tauriMock.ts` IPCモックを再利用)で撮影。ファイル名は3状態共通:

| 状態 | Before | After |
| ---- | ------ | ----- |
| 空状態 | `output/reports/ui/before/01-empty.png` | `output/reports/ui/after/01-empty.png` |
| 画像表示+矢印・モザイク適用後+履歴あり | `output/reports/ui/before/02-canvas-history.png` | `output/reports/ui/after/02-canvas-history.png` |
| 権限バナー表示 | `output/reports/ui/before/03-permission-banner.png` | `output/reports/ui/after/03-permission-banner.png` |

Before の3枚すべてで権限バナーが(許可済みでも)常時表示されている点に注目(§2の不具合そのものの視覚的証拠)。
Afterでは空状態・履歴ありの2状態でバナーが正しく非表示になっている。

撮影スクリプトは `e2e/screenshots/` に配置し、ファイル名を `*.visual.ts`(`*.spec.ts`/`*.test.ts` ではない)に
することでルートの `playwright.config.ts`(`npm run e2e`)の既定 `testMatch` に一致させず、通常の
`npm run e2e` 実行時間には影響しない(専用の `e2e/screenshots/playwright.config.ts` からのみ実行される)。

## 5. 検証

- `npm run build` / `npm run test:run` / `cargo test` / `cargo clippy -- -D warnings` / `npm run e2e`:
  いずれもpass(件数・exit codeは実装タスクの最終報告を参照)。
- E2Eのセレクタ変更は無し(`aria-label`はテキストボタン時と同じ文言を維持したまま、可視文言をアイコンへ
  置き換えたのみ)。`e2e/capture-flow.spec.ts` は1箇所、権限バナー不具合が修正済みになった旨のコメント更新のみ行った(アサーション自体は無変更)。
