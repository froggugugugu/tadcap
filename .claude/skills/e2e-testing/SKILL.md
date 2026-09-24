---
name: e2e-testing
description: >
  Playwright で E2E テスト(Page Object・テストデータ・安定化)を作成・保守し、結果を testreport/e2e/ と output/reports/test/ に残す。
  「E2E テスト」「シナリオテスト」「ユーザーフローのテスト」の依頼や、機能実装後の検証で使う。
argument-hint: "<対象機能 or 指示>"
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git *), Agent, WebSearch, WebFetch, mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot, mcp__playwright__browser_click, mcp__playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_take_screenshot
---

# E2E Testing

Playwright によるE2Eテストの実装スキル。ユーザー視点の主要シナリオを自動化し、リグレッションを防ぐ。
プロジェクト固有のシナリオ・Page Object・テストデータは [docs/development-patterns.md](../../../docs/development-patterns.md) を参照。

## 前提条件

| 参照ファイル | 用途 | スタブ時のフォールバック |
| ------------ | ---- | ----------------------- |
| `docs/project.md` | テストコマンド・技術スタック | `project-config.md` §3, §8 を直接参照 |
| `docs/development-patterns.md` | E2Eパターン・テストデータ | `project-config.md` §8, §11 を直接参照 |

## テスト対象の方針

E2Eテストは **画面をまたぐユーザー操作フロー** を検証する。

- ✅ 対象: ページ遷移、フォーム操作→結果確認、機能間連携、データ永続化（リロード後の保持）
- ❌ 対象外: 個別バリデーションルール（単体テスト）、コンポーネント描画詳細（コンポーネントテスト）、サードパーティライブラリ内部の挙動

## 使い方

```text
/e2e-testing <対象機能 or テスト指示>
```

引数は省略可能。省略した場合はユーザーに対話的に確認する。
ファイルパスを指定した場合はその機能を対象としたE2Eテストシナリオを設計する。

### 例

```text
/e2e-testing アサイン管理のフロー全体をテストする
/e2e-testing src/features/assignment/
/e2e-testing output/tasks/TASK_e2e_assignment.md
```

### 出力先

- テストコード: `e2e/` 配下
- ツール出力: `testreport/e2e/`（Playwrightレポート・トレース）
- サマリー出力: `output/reports/test/`（`output/`ディレクトリが存在する場合）

### 他スキルとの連携

| 前工程 | 本スキル | 後工程 |
| ------ | -------- | ------ |
| `/implementing-features` `/ui-ux-design` | `/e2e-testing` | `/code-review` |

## 実装ワークフロー

1. **シナリオ定義** — 何を検証するか明確にする（[docs/development-patterns.md](../../../docs/development-patterns.md) のシナリオ一覧を参照）
2. **テストデータ準備** — ヘルパー関数でデータを注入（[docs/development-patterns.md](../../../docs/development-patterns.md) 参照）
3. **Page Objectで操作を記述** — テスト本体は「何を検証するか」に集中
4. **実行・確認** — E2Eテストコマンド（`docs/project.md` 参照）を実行
5. **レポート出力** — テストレポートを `testreport/e2e/` に出力し提示。トレース確認の操作方法・コマンドも提示

## ファイル配置

```
e2e/
├── <feature>.spec.ts         # テストファイル（機能単位）
├── fixtures/
│   └── test-data.ts          # テストデータ生成ヘルパー
└── pages/
    ├── BasePage.ts            # 共通操作（ナビゲーション、ダイアログ、トースト）
    └── <Feature>Page.ts       # 機能別Page Object
```

## ロケータ戦略（優先順）

1. `getByRole` — アクセシビリティベース（最も安定）
2. `getByLabel` — フォーム要素
3. `getByText` — 表示テキスト
4. `getByTestId` — 上記で困難な場合
5. CSSセレクタ — 複雑なUIコンポーネントの最終手段

## 安定性ルール

- Playwrightの自動待機を活用（`expect(...).toBeVisible()` 等のアサーション）
- **`waitForTimeout` は禁止**（フレーキーテストの原因）
- 各テストは `beforeEach` でデータを初期化（テスト間の実行順序に依存しない）
- ページ遷移後は `waitForLoadState('networkidle')` で安定化

## Page Object 設計原則

- **BasePage** に共通操作（ナビゲーション、ダイアログ開閉、トースト確認）を集約
- **機能別Page** は BasePage を継承し、その画面固有の操作を追加
- テスト本体からはPage Objectのメソッドのみ呼び出す（ロケータ直接操作は避ける）

## テストコマンド

テストコマンドは `docs/project.md` に記載。一般的なパターン:

```bash
npm run e2e                    # 全E2Eテスト
npm run e2e:ui                 # UIモード（デバッグ向き）
npx playwright test e2e/<file> # 特定ファイル
npx playwright test --grep "<テスト名>" # テスト名でフィルタ
npx playwright show-report --reporter-dir testreport/e2e  # レポート表示
```

## レポート出力設定

Playwright設定ファイル（`playwright.config.ts`）で `testreport/e2e/` にレポートを出力する:

```typescript
// playwright.config.ts
export default defineConfig({
  reporter: [
    ['html', { outputFolder: 'testreport/e2e', open: 'never' }],
  ],
  outputDir: 'testreport/e2e/results',
})
```

## 出力契約

### テスト実装出力仕様

| フィールド | 型 | 必須 | 制約 |
| ---------- | -- | ---- | ---- |
| シナリオ定義 | 箇条書き | ✅ | 検証対象のユーザーフローを自然言語で記述 |
| テストコード | TypeScriptファイル | ✅ | `e2e/` 配下に配置 |
| Page Object | TypeScriptファイル | 条件付き | 新規画面操作がある場合 |
| テストデータ | TypeScript関数 | 条件付き | 新規データパターンが必要な場合 |
| 実行結果 | テーブル | ✅ | テスト名, 結果(pass/fail), 実行時間 |

### テストコード構造制約

```typescript
// 必須構造
test.describe('[機能名]', () => {
  test.beforeEach(async ({ page }) => {
    // データ初期化
    // ページ遷移
  })

  test('[日本語のシナリオ説明]', async ({ page }) => {
    // Arrange: Page Object経由の初期操作
    // Act: テスト対象の操作
    // Assert: 期待結果の検証
  })
})
```

- `test.describe` / `test` の説明文は日本語
- `waitForTimeout` は使用禁止（代わりにアサーションベースの待機）
- ロケータ優先順: `getByRole` > `getByLabel` > `getByText` > `getByTestId` > CSS

### 実行結果レポートフォーマット

```markdown
## E2Eテスト結果

| テスト | 結果 | 実行時間 |
| ------ | ---- | -------- |
| [シナリオ名] | pass / fail | Xs |

- 合計: X pass / Y fail
- レポート: `testreport/e2e/index.html`
- トレース確認: `npx playwright show-report testreport/e2e`
```

### 語彙制約

| 用語 | 定義 |
| ---- | ---- |
| シナリオ | ユーザー視点の操作フロー（画面をまたぐ一連の操作） |
| Page Object | 画面操作を抽象化するクラス。ロケータ詳細を隠蔽する |
| フレーキー | 実行のたびに結果が変わる不安定なテスト |
| シードデータ | テスト用に注入する初期データ |

## チェックリスト

- [ ] 各テストが独立（beforeEachでデータ初期化）
- [ ] Page Objectで操作を抽象化
- [ ] `waitForTimeout` を使っていない
- [ ] ロケータがRole/Label/Textベース
- [ ] データ永続化（リロード後）のテストがある
- [ ] 機能横断シナリオがある
- [ ] E2Eテストが安定してパスする

## 関連参照

必要になったときだけ Read する:

- `.claude/quality-gates.md` — ゲート通過基準と定量計測表を確認するとき
- `.claude/pitfalls.md` — 既知の失敗パターンに当たりそうなとき(該当する節だけ読む)
