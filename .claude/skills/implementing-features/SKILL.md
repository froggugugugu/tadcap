---
name: implementing-features
description: >
  TDD で機能実装・バグ修正を行い、検証結果を証拠として示し、docs/・project-config.md・進捗ノートを同期する。
  「実装して」「機能追加」「バグ修正」「コンポーネント作成」の依頼や、タスク分解済みの作業に着手するときに使う。
argument-hint: "<タスクファイル or 指示>"
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git *), WebSearch, WebFetch, Agent, mcp__context7__resolve-library-id, mcp__context7__query-docs, mcp__plugin_context7_context7__resolve-library-id, mcp__plugin_context7_context7__query-docs
---

# Implementing Features

プロジェクトの開発標準に従い、TDDで機能実装・バグ修正・リファクタリングを行う。
`AGENTS.md`(共通ルール)と `CLAUDE.md` の方針を厳守すること。プロジェクト固有のコードパターンは [docs/development-patterns.md](../../../docs/development-patterns.md) を参照。

## 前提条件

| 参照ファイル | 用途 | スタブ時のフォールバック |
| ------------ | ---- | ----------------------- |
| `docs/project.md` | コマンド・技術スタック | `project-config.md` §1〜§3 を直接参照 |
| `docs/architecture.md` | ディレクトリ構成・テスト配置 | `project-config.md` §4 を直接参照 |
| `docs/data-model.md` | スキーマ定義 | コードベースの Zod スキーマを直接読み取る |
| `docs/development-patterns.md` | コード規約・落とし穴 | `project-config.md` §2, §11 を直接参照 |

このスキルは `docs/` ファイルの生成・更新も担う。スタブの場合は実行後に自動生成する。

## 基本姿勢

- 実務でそのまま使えるコードを書く（擬似コード禁止、TODOで逃げない）
- 仕様が曖昧な場合は実装前に質問する（推測で進めない）
- 設計を勝手に変えない、過剰な抽象化をしない
- 仕様書にない機能を追加しない
- ユーザーデータの暗黙的な削除・上書きをしない

## 使い方

```text
/implementing-features <タスクファイル or 実装指示>
```

引数は省略可能。省略した場合はユーザーに対話的に確認する。
タスクファイルを指定した場合はその内容を読み取り、要件と受け入れ基準を把握する。

### 例

```text
/implementing-features ユーザー認証機能を追加する
/implementing-features output/tasks/TASK_auth.md
/implementing-features .claude/tasks/TASK_001.md
```

### 出力先

- 実装コード: `src/` 配下（プロジェクトのディレクトリ構成に従う）
- テストコード: 各モジュールの `__tests__/` ディレクトリ
- カバレッジレポート: `testreport/coverage/`

### 他スキルとの連携

| 前工程 | 本スキル | 後工程 |
| ------ | -------- | ------ |
| `/plan` `/architecture` | `/implementing-features` | `/code-review` `/e2e-testing` |

## 設計原則

以下の原則に従う。プロジェクト固有の適用については `docs/development-patterns.md` を参照。

- **SRP**: 1コンポーネント=1表示責務、1ストア=1ドメイン、1関数=1計算。肥大化したらフック/アクション分割
- **OCP**: 既存コードの内部変更より、props/合成/新アクション追加で拡張する
- **LSP**: 派生型（Create/Update）は基底スキーマのサブセットであること
- **ISP**: propsは最小限、セレクタで必要フィールドのみ取得、型は用途別に分割
- **DIP**: レイヤールール遵守（上位→下位の一方向）、機能モジュール間は共有層経由
- **KISS**: ネスト3段以上は早期return/関数抽出で平坦化。汎用化より直接的な実装を優先
- **YAGNI**: 仕様書にない機能は実装しない。将来のための抽象化・フラグは作らない。未使用コードは削除
- **DRY**: 3箇所以上の重複で共通化を検討（Rule of Three）。2箇所の類似は無理に共通化しない

## 実装ワークフロー（TDD）

1. **仕様確認** — 曖昧な点があれば選択肢を示して質問
2. **テスト作成** — テストフレームワーク（`docs/project.md` 参照）で正常系・異常系・境界値を書く
3. **最小実装** — テストが通るコードを書く
4. **リファクタリング** — テストが通ったまま整理
5. **検証** — プロジェクトの検証コマンド（`docs/project.md` 参照）を実行し、結果（pass/fail 件数・エラー数）を証拠として報告に貼る
6. **ドキュメント更新** — 下記「ドキュメント同期」に従い `docs/` と `project-config.md` を更新
7. **進捗更新** — `output/tasks/PROGRESS.md` があれば、検証済みの機能だけ `passes` を ✅ にし、
   セッションログ（やったこと / 検証結果 / コミット / 申し送り / 却下した案）を追記する。
   1 セッションで扱うのは機能リストの未完了 1 件が原則（複数セッション引き継ぎ）

## 出力契約

### ゲート別出力仕様

#### 🚏 設計ゲート出力（実装前）

| フィールド | 型 | 必須 | 制約 |
| ---------- | -- | ---- | ---- |
| 要件解釈 | 箇条書き | ✅ | 受け入れ基準を1件1行で列挙 |
| 影響ファイル | テーブル（ファイル, 変更種別） | ✅ | 変更種別 ∈ {追加, 変更, 削除} |
| テスト方針 | 箇条書き | ✅ | テスト対象と期待動作を明記 |
| 【仮定】事項 | 箇条書き | 条件付き | 仕様が曖昧な場合のみ |

#### 🚏 実装ゲート出力（実装後）

| フィールド | 型 | 必須 | 制約 |
| ---------- | -- | ---- | ---- |
| テスト結果 | `X pass / Y fail` | ✅ | 数値のみ。失敗時は原因を1行で付記 |
| カバレッジ | `行: X% / 分岐: Y%` | ✅ | 目標との差分を明記 |
| 静的解析 | `エラー: X件 / 警告: Y件` | ✅ | 0件でも明記 |
| 依存方向 | `違反: X件` | 条件付き | 依存方向チェックが有効な場合 |
| 変更ファイル数 | 整数 | ✅ | |

#### 🚏 最終ゲート出力

実装チェックリスト（AGENTS.md 定義）の全項目を `[x]` / `[ ]` で提示する。

### 語彙制約

| 用語 | 定義 |
| ---- | ---- |
| 【仮定】 | 仕様に明記されていない前提条件 |
| pass / fail | テスト結果の状態 |
| 違反 | 依存方向ルールへの抵触 |
| 後方互換 | 既存データの読み込みが壊れないこと |

### 構造制約

- 実装コード出力は必ず **テストコード → 本体コード** の順（テストファースト）
- 各コードブロックにはファイルパスをコメントで付記
- テスト記述は `describe` / `it` の説明文を日本語で記述
- 品質レポートはプレーンテキスト（Markdownテーブル可）で出力し、JSON不可

## アーキテクチャ準拠

- プロジェクトのアーキテクチャパターン（`docs/architecture.md` 参照）に従う
- 状態管理のパターン（`docs/development-patterns.md` 参照）に従う
- バリデーションスキーマは型定義と一致させる
- ダークモード対応が必要な場合はセマンティックカラーを使用
- パスエイリアスは `project-config.md` の定義に従う

## データモデル変更時

- スキーマを先に定義する
- 既存データとの後方互換を維持する（optional追加）
- データ永続化層への影響を確認する

## ドキュメント同期

実装変更後、影響を受ける `docs/` ファイルと `project-config.md` を更新する。
ドキュメントの正確性は実装と同等の品質基準で扱う。

### docs/ の更新トリガー

| 変更内容                             | 更新対象                         |
| ------------------------------------ | -------------------------------- |
| ルート追加・変更・削除               | `docs/project.md`                |
| ストア追加・変更・削除               | `docs/project.md`                |
| npmスクリプト追加・変更              | `docs/project.md`                |
| 依存パッケージ追加・バージョン変更   | `docs/project.md`                |
| feature追加・削除・リネーム          | `docs/architecture.md`           |
| コンポーネント追加・削除             | `docs/architecture.md`           |
| テストファイル追加・削除             | `docs/architecture.md`           |
| 共有レイヤー変更                     | `docs/architecture.md`           |
| コードパターン・落とし穴の発見/変更  | `docs/development-patterns.md`   |
| スキーマのフィールド追加・変更       | `docs/data-model.md`             |
| バリデーションルール変更             | `docs/data-model.md`             |
| フォームスキーマ追加・変更           | `docs/data-model.md`             |

### project-config.md の更新トリガー

| 変更内容                                 | 更新対象セクション                       |
| ---------------------------------------- | ---------------------------------------- |
| 新しい落とし穴・アンチパターンの発見     | §11（既知の落とし穴）                    |
| 依存パッケージの追加・バージョン変更     | §2（技術スタック）                       |
| npmスクリプトの追加・変更                | §3（コマンド）                           |

## テストポリシー

- テストは「仕様を説明するもの」
- 重要なロジックには必ずテストケースを用意
- カバレッジ目標は `project-config.md` セクション6 に定義
- `describe` / `it` の説明文は振る舞いを明記
- カバレッジレポートは `testreport/coverage/` に出力し、結果を提示する

### カバレッジレポート出力

テスト実行時はカバレッジレポートを `testreport/coverage/` に出力する。
出力先の設定例（`project-config.md` §3 のテストフレームワークに合わせて設定）:

```bash
# Vitest の場合
# vite.config.ts の test.coverage に以下を設定:
#   reportsDirectory: 'testreport/coverage'

# Jest の場合
# jest.config.ts に以下を設定:
#   coverageDirectory: 'testreport/coverage'
```

## 依存方向の検証

実装完了時に依存方向チェックコマンド（`project-config.md` セクション4.4 に記載）を実行し、
依存方向ルールに違反していないことを確認する。

## Git操作

- `--no-verify` は使用禁止（pre-commit / pre-pushフックを迂回しない）
- フック失敗時はエラーの原因を修正する
- `--force` は原則禁止

## 禁止事項

- 仕様書にない機能の追加
- ユーザーデータの暗黙的な削除・上書き
- `--no-verify` によるフック迂回
- `docs/development-patterns.md` に記載されたアンチパターンの使用
- `output/tasks/PROGRESS.md` の機能行の削除・受け入れ条件の書き換え（`passes` とセッションログの更新のみ可）
- 検証コマンドを実行せずに機能を `passes` = ✅ にすること

## 関連参照

必要になったときだけ Read する:

- `.claude/quality-gates.md` — ゲート通過基準と定量計測表を確認するとき
- `.claude/rules/document-management.md` — docs/ と project-config.md の更新責務を確認するとき
- `.claude/rules/workflow-advanced.md` — 完了前検証や長期タスク引き継ぎの手順を確認するとき
- `.claude/pitfalls.md` — 既知の失敗パターンに当たりそうなとき(該当する節だけ読む)
