# チーム定義 — PJM（フルライフサイクル管理）

## 概要

要求メモから実装・テスト・品質監査まで、プロジェクトの全フェーズを一貫して遂行するチーム。
人間は`input/`にメモを配置し、`output/`の成果物をレビューするだけで開発が進行する。

## 使い方

```text
.claude/teams/TEAM_PJM.md <要求メモファイルパス or 指示> [--auto] [--parallel]
```

引数は省略可能。省略時はPLが `input/requirements/` を確認し、対象ファイルを特定する。

### 承認モード

| モード | 指定方法 | ゲート動作 |
| --- | --- | --- |
| **通常（デフォルト）** | 指定なし | 各ゲートで人間に成果物を提示し、承認を待つ |
| **自律** | `--auto` を付与 | PJMが品質基準に基づき自動判定。最終報告のみ人間に提示 |

自律モードでは、PJMが以下の基準でゲートを自動通過させる:
- 成果物が出力契約（スキル定義の必須セクション）を満たしている
- 【要確認】が未解決のまま残っていない
- テスト全パス、カバレッジ目標達成、静的解析エラー0件
- CRITICAL/HIGH脆弱性が0件

基準を満たさない場合は自律モードでも人間に判断を仰ぐ。

### 実装モード

| モード | 指定方法 | Phase 4 動作 |
| --- | --- | --- |
| **逐次（デフォルト）** | 指定なし | 単一の開発者がタスクを順次実装 |
| **並行** | `--parallel` を付与 | 独立タスク群をTEAM_FEATUREに並行委任 |

並行モードの前提条件:
- Phase 3 の成果物に変更ファイル・依存関係が明記されていること
- 独立した Feature Bundle が2つ以上特定できること（1つのみの場合は逐次モードにフォールバック）

### 例

```text
# ファイル指定（推奨）
.claude/teams/TEAM_PJM.md input/requirements/REQ_001.md

# 自律モード（ゲート承認をPJMに委任）
.claude/teams/TEAM_PJM.md input/requirements/REQ_001.md --auto

# 指示指定
.claude/teams/TEAM_PJM.md ユーザー認証機能を全フェーズ遂行

# 途中フェーズから開始
.claude/teams/TEAM_PJM.md Phase 3から開始。PRDと設計書はoutput/に作成済み

# 並行実装モード
.claude/teams/TEAM_PJM.md input/requirements/REQ_001.md --parallel

# 自律 + 並行
.claude/teams/TEAM_PJM.md input/requirements/REQ_001.md --auto --parallel

# 品質監査のみ + 自律モード
.claude/teams/TEAM_PJM.md 実装済み。Phase 5のみ実行 --auto

# 引数省略
.claude/teams/TEAM_PJM.md
```

## インプット/アウトプット

```text
input/requirements/REQ_xxx.md   ← 人間が作成（要求メモ）
         │
         ▼ AI処理（本チームが全フェーズ実行）
         │
output/
├── prd/PRD_xxx.md              ← Phase 1 成果物（人間がレビュー）
├── design/ARCH_xxx.md          ← Phase 2 成果物（人間がレビュー）
├── tasks/TASK_xxx.md           ← Phase 3 成果物（人間がレビュー）
└── reports/                    ← Phase 5 成果物（人間がレビュー）
    ├── review/                    コードレビュー結果
    ├── test/                      テストレポート
    ├── security/                  セキュリティスキャン結果
    └── legal/                     法務チェック結果
```

## チーム構成

| 役割 | エージェント種別 | モデル | 使用スキル | 権限 |
| --- | --- | --- | --- | --- |
| **PJM（リーダー）** | general-purpose | Opus | — | delegate + plan承認 |
| **アナリスト** | general-purpose, mode: plan | Sonnet | `brainstorm`(条件付), `prd`, `architecture` | plan必須（PJMが承認）、ソースコード変更不可 |
| **プランナー** | general-purpose, mode: plan | Sonnet | `plan` | plan必須（PJMが承認）、ソースコード変更不可 |
| **開発者** | general-purpose | Sonnet | `implementing-features`, `ui-ux-design`, `refactoring` | plan必須（PJMが承認） |
| **レビュアー** | general-purpose, mode: plan | Sonnet | `code-review`, `security-scan`, `legal-check`, `hig-compliance` | plan必須（PJMが承認）、ソースコード変更不可 |
| **テスター** | general-purpose | Sonnet | `e2e-testing`, `performance` | テストファイルのみ変更可 |

### スキルカバレッジ（全13スキル）

| スキル | 担当 |
| --- | --- |
| `brainstorm` | アナリスト(要求メモが曖昧な場合のみ起動) |
| `prd` | アナリスト |
| `architecture` | アナリスト |
| `plan` | プランナー |
| `implementing-features` | 開発者 |
| `ui-ux-design` | 開発者 |
| `refactoring` | 開発者 |
| `code-review` | レビュアー |
| `security-scan` | レビュアー |
| `legal-check` | レビュアー |
| `hig-compliance` | レビュアー |
| `e2e-testing` | テスター |
| `performance` | テスター |

## 各役割の責務

### PJM（リーダー）

- `input/requirements/`の要求メモを読み、プロジェクト全体のスコープを把握する
- 各フェーズの開始・完了・承認を管理する
- 各ゲートポイントで成果物を人間に提示し、承認を待つ
- メンバー間の整合性を確認する
- TaskCreateでフェーズごとのタスクリストを作成する
- **並行モード時の追加責務**:
  - タスク分解成果物から Feature Bundle を特定する（変更ファイル重複分析）
  - 共有レイヤー変更タスクを分離し、逐次実行を管理する
  - Bundle ごとの TASK ファイルを `output/tasks/` に生成する
  - 各 Bundle に対して TEAM_FEATURE を並行起動し、進捗追跡・結果集約を行う
- **自分でドキュメント作成・コード実装を行わない**

### アナリスト

- **Phase 0(任意)**: 要求メモが半ページ未満 or やらない事項が不明な場合は
  `/brainstorm <メモ>` を先に起動。`output/brainstorm/` に保存後、PJM に承認を求める
- 要求メモからPRDを生成する → `output/prd/`に出力
- PRD承認後、アーキテクチャ設計書を生成する → `output/design/`に出力
- 使用スキル: `/brainstorm <メモ>`(条件付) → `/prd <ファイルパス>` → `/architecture <ファイルパス>`
- 曖昧な要件は「【要確認】」としてPJMに報告する
- **ソースコードは変更しない**
- 参考: `.claude/learnings/L0001-brainstorm-before-prd.md`(適用条件と効果)

### プランナー

- アーキテクチャ設計に基づき、実装タスクを分解する → `output/tasks/`に出力
- 使用スキル: `/plan`
- タスク間の依存関係・並行化可能性を分析する
- テスト戦略を定義する
- **ソースコードは変更しない**

### 開発者

- タスク分解に基づき、機能を実装する
- 使用スキル: `/implementing-features`（機能実装）, `/ui-ux-design`（UI実装）, `/refactoring`（構造改善）
- TDDに従い、ユニットテストも作成する
- 実装完了後、PJMに報告する

### レビュアー

- 実装完了後にコードレビュー・セキュリティスキャン・法務チェックを実施
- 使用スキル: `/code-review`, `/security-scan`, `/legal-check`, `/hig-compliance`
- レポートを`output/reports/`の各サブディレクトリに出力する
- 具体的なフィードバックを開発者に送る
- **ソースコードは変更しない**

### テスター

- レビュアー承認後にE2Eテスト・パフォーマンス計測を実施
- 使用スキル: `/e2e-testing`, `/performance`
- テストレポートを`output/reports/test/`に出力する
- **テストファイルのみ作成・変更する**

## フェーズワークフロー

```text
Phase 1: 要件分析
  PJM: input/ の要求メモを確認 → アナリストに割り当て
  [Phase 0、条件付] メモ半ページ未満 or やらない事項不明の場合:
    アナリスト: /brainstorm <メモ> → output/brainstorm/ に保存 → PJM 承認
  アナリスト: /prd で PRD 生成 → output/prd/ に出力
  🚏 ゲート1: 通常=人間に提示→承認待ち / 自律=PJMが品質基準で判定

Phase 2: アーキテクチャ設計
  アナリスト: /architecture で設計書生成 → output/design/ に出力
  🚏 ゲート2: 通常=人間に提示→承認待ち / 自律=PJMが品質基準で判定

Phase 3: タスク分解
  プランナー: /plan でタスク分解 → output/tasks/ に出力
  🚏 ゲート3: 通常=人間に提示→承認待ち / 自律=PJMが品質基準で判定

Phase 4: 実装
  ┌─ 逐次モード（デフォルト）─────────────────────
  │ 開発者: 計画作成 → PJM承認 → /implementing-features + /ui-ux-design で実装
  └────────────────────────────────────────────

  ┌─ 並行モード（--parallel）──────────────────
  │ Phase 4a: 並行化準備（PJM）
  │   タスク分解成果物の変更ファイル重複を分析
  │   独立 Feature Bundle を特定
  │   共有レイヤー変更タスクを分離
  │
  │ Phase 4b: 共有レイヤー変更（逐次・該当時のみ）
  │   開発者が共有レイヤーを逐次実装
  │
  │ Phase 4c: Feature Bundle 並行実装
  │   PJM: 各 Bundle の TASK ファイルを output/tasks/ に生成
  │   PJM: 各 Bundle に対して TEAM_FEATURE を並行起動
  │   PJM: TaskCreate/TaskUpdate で進捗追跡
  │
  │ Phase 4d: 統合確認
  │   全 TEAM_FEATURE 完了後、統合テスト実行
  │   失敗 Bundle は再実行 or 人間に報告
  └────────────────────────────────────────────
  🚏 ゲート4: 通常=人間に提示 / 自律=テスト全パス+カバレッジ達成で自動通過

Phase 5: 検証（並行実行）
  レビュアー: /code-review → output/reports/review/
  レビュアー: /security-scan → output/reports/security/
  レビュアー: /legal-check → output/reports/legal/
  テスター: /e2e-testing → output/reports/test/
  テスター: /performance → パフォーマンス計測結果
  🚏 ゲート5: 通常=人間に提示→承認待ち / 自律=CRITICAL0件で自動通過

Phase 6: 完了判定
  PJM: 全ゲート通過を確認 → 完了報告（自律モードでも最終報告は人間に提示）
```

### 依存関係ルール

| 前提条件 | 次のステップ |
| --- | --- |
| 要求メモが`input/`に存在 | Phase 1 開始 |
| PRD承認（ゲート1通過） | Phase 2 開始 |
| 設計書承認（ゲート2通過） | Phase 3 開始 |
| タスク分解承認（ゲート3通過） | Phase 4 開始 |
| 実装完了（ゲート4通過） | Phase 5 開始 |
| 全レポート承認（ゲート5通過） | Phase 6（完了判定） |

### フェーズスキップ

PJMの判断で不要なフェーズをスキップできる:

| 状況 | スキップ可能なフェーズ |
| --- | --- |
| PRD・設計書が既にある | Phase 1, 2 → Phase 3から開始 |
| タスク分解が既にある | Phase 1, 2, 3 → Phase 4から開始 |
| 実装済みコードのQAのみ | Phase 1-4 → Phase 5のみ実行 |
| セキュリティ・法務のみ | Phase 5の該当スキルのみ実行 |

## 完了条件

- [ ] アナリスト: PRD生成完了、承認済み（通常=人間 / 自律=PJM）
- [ ] アナリスト: アーキテクチャ設計完了、承認済み（通常=人間 / 自律=PJM）
- [ ] プランナー: タスク分解完了、承認済み（通常=人間 / 自律=PJM）
- [ ] 開発者: 全タスク実装完了、ユニットテスト全パス
- [ ] レビュアー: コードレビュー完了、MUST指摘が0件
- [ ] レビュアー: セキュリティスキャン完了、CRITICAL/HIGH脆弱性が0件
- [ ] レビュアー: 法務チェック完了、CRITICALリスクが0件
- [ ] テスター: E2Eテスト全パス
- [ ] テスター: パフォーマンス計測完了
- [ ] PJM: 全フェーズ完了確認、output/に全成果物が揃っている
- [ ] PJM: 最終報告を人間に提示（自律モードでも必須）
- [ ] **並行モード時追加**: PJM: 全 Bundle の TEAM_FEATURE が完了している
- [ ] **並行モード時追加**: PJM: 統合確認チェックリスト全項目パス（ファイル競合なし、テスト全パス、型チェック全パス、静的解析エラー0件）

## 並行モード詳細

### Feature Bundle 特定ルール

PJM は Phase 3 の成果物（`output/tasks/`）を分析し、以下の基準で Feature Bundle を特定する:

1. **変更ファイル非重複**: Bundle 間で変更対象ファイルが重複しないこと
2. **共有レイヤー除外**: 共有レイヤーに属するファイルの変更は Bundle に含めず、Phase 4b で逐次処理する
3. **依存関係尊重**: タスク間に依存関係がある場合、同一 Bundle にまとめるか、依存元を先行 Bundle とする

### 共有レイヤーの定義

以下のパスは共有レイヤーとして扱い、並行 Bundle の対象外とする:

- `src/shared/`, `src/stores/`, `src/types/`, `src/lib/`, `src/utils/`
- `project-config.md` §4（アーキテクチャ）で定義された共有パス

### Bundle TASK ファイルの生成規約

- ファイル名: `TASK_BUNDLE_<名前>.md`（例: `TASK_BUNDLE_auth.md`）
- 形式: `TASK_TEMPLATE.md` 準拠 + Bundle メタデータ（Bundle ID、元タスク分解、含まれるタスクID、前提条件）
- 出力先: `output/tasks/`

### TEAM_FEATURE 起動形式

```text
.claude/teams/TEAM_FEATURE.md output/tasks/TASK_BUNDLE_<名前>.md
```

各 TEAM_FEATURE インスタンスは割り当てられた Bundle のスコープ内のみで作業する。
PJM が TaskCreate/TaskUpdate で各 Bundle の進捗を追跡する。

### 失敗時リカバリ

- 成功した Bundle の成果は保持する
- 失敗した Bundle は原因を分析し、再実行を試みる
- 再実行でも解決しない場合は人間にエスカレーションする

### 統合確認チェックリスト

全 TEAM_FEATURE 完了後、PJM は以下を確認する:

- [ ] Bundle 間でファイル競合が発生していないこと
- [ ] テストが全パスすること
- [ ] 型チェックが全パスすること
- [ ] 静的解析エラーが0件であること

## 技術スタック参照

チーム全員が `CLAUDE.md` とそれが取り込む `AGENTS.md` を読み、プロジェクトの技術スタック・規約に従うこと。

## 関連参照

起動したら最初に次の 2 ファイルを Read する:

- `.claude/teams/README.md` — チーム選定・起動パターン・subagent dispatch ガイド
- `.claude/agents/README.md` — subagent の使い分けと権限
