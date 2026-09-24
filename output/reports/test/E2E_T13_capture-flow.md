# E2E テスト結果 — T13 E2Eテスト基盤(Playwright + IPCモック)

- 対象: `e2e/capture-flow.spec.ts`
- 実行コマンド: `npm run e2e`(= `playwright test`、ブラウザ chromium のみ)
- 実行日: 2026-09-24

## 結果

| テスト | 結果 | 備考 |
| ------ | ---- | ---- |
| キャプチャ→矢印描画→モザイク適用→クリップボードコピーで履歴に1件表示・選択される | pass | 矢印色(`#FF5C8A`付近)の画素検出・モザイク前後のピクセル変化・クリップボード書込回数(`plugin:clipboard-manager\|write_image`)・履歴サイドバー選択状態まで一連で検証 |
| 画面収録権限が未許可(permission_denied)の場合、キャプチャ実行時に権限バナーが表示される | fail | **アプリ本体の既知の不具合**により失敗(下記参照)。E2Eハーネス自体の不具合ではない |

- 合計: 1 pass / 1 fail(実行時間 約6.3秒、2並列ワーカー)
- レポート: `testreport/e2e/index.html`
- トレース確認: `npx playwright show-report testreport/e2e`

## fail の原因(アプリ本体の不具合、未修正)

`src/styles.css:57-66` の `.permission-banner { display: flex; ... }` が、ブラウザ既定の
UAスタイルシートのルール `[hidden] { display: none }` を上書きしてしまう(CSSのカスケードは
詳細度が同じでも著者(author)オリジンがUAオリジンより常に優先されるため)。そのため
`src/ui/permissionBanner.ts` が `container.hidden = true/false` を切り替えても、バナーは
常に可視状態(`display: flex`)のままになる。

実ブラウザ(chromium)で `getComputedStyle()` により再現確認済み:
`{"hiddenAttr":true,"display":"flex","visibility":"visible"}`

この不具合は本タスク(E2Eテスト基盤整備・テスト作成)のスコープ外であり、テスターの
書込範囲(`src/**` を含まない)にも該当しないため修正していない。詳細・再現手順・
提案する対策は `project-config.md` §11(既知の落とし穴)の最終行、および
`e2e/capture-flow.spec.ts` 内の該当コメントに記載した。

修正案(参考): `.permission-banner { display: flex; ... }` を
`.permission-banner:not([hidden]) { display: flex; ... }` に変更する、または
JS側で `hidden` 属性ではなく専用のCSSクラス(例: `.permission-banner--visible`)を
明示的に切り替える。修正後は `e2e/capture-flow.spec.ts` の該当テストを再実行して
グリーンになることを確認すること。

## スモークテスト(実行結果)

| コマンド | exit code |
| -------- | --------- |
| `npm run build` | 0 |
| `npm run test:run`(Vitest、13 files / 128 tests） | 0 |
| `cargo test --manifest-path src-tauri/Cargo.toml`(60 tests） | 0 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | 0 |
