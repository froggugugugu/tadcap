# 開発ガイド(Claude Code)

ツール共通の開発ルールは `AGENTS.md`(次の行で取り込む)。本ファイルには Claude Code 固有の仕組み(skill / team / subagent / フック / 権限)だけを書く。

@AGENTS.md

> **"core" として軽量化**(Pro 契約 friendly)。詳細な手順は skill / team / agent が必要時に Read する(skill の行頭 `@` は起動時に全文添付されるため使わない)。
> 各行は「消すと Claude が間違えるか?」で判定して残す(公式ガイド)。ツール共通の規則は `AGENTS.md` に書く。

## スキル一覧(全引数省略可)

| スキル | 用途・トリガー |
| ------ | -------------- |
| `/brainstorm <要求メモ>` | `/prd` 前段の Socratic 質問駆動(読取専用) |
| `/prd <ファイル>` | 要求メモから PRD 生成(読取専用) |
| `/architecture <ファイル>` | 要求メモからシステムアーキテクチャ設計(読取専用) |
| `/plan <説明 or ファイル>` | 設計ドキュメント生成(読取専用) |
| `/adr <判断タイトル>` | 設計判断の経緯・根拠を ADR に記録 |
| `/implementing-features <タスク>` | TDD による機能実装・バグ修正 |
| `/ui-ux-design <対象>` | デザインシステム準拠の UI/UX 設計・レビュー・実装 |
| `/hig-compliance <対象>` | Apple HIG 準拠のシステム横断 UI 一貫性チェック |
| `/design-system-audit <対象>` | デザイントークン整合性監査・標準化 |
| `/e2e-testing <対象機能>` | Playwright E2E テスト作成 |
| `/code-review <対象>` | コードレビュー(読取専用)。同梱の bundled 版は `/review` |
| `/security-scan <対象>` | 脆弱性スキャン・OWASP / CVE 監査(読取専用) |
| `/legal-check <対象>` | OSS ライセンス・プライバシー・知財チェック(読取専用) |
| `/performance <対象>` | 計測ファーストのパフォーマンス最適化 |
| `/refactoring <対象>` | 大規模コード再構成・責務移動 |
| `/review-fix <PR番号>` | CodeRabbit/Copilot レビュー指摘の自動修正(手動起動のみ) |
| `/harness-refine <対象 or 指示>` | ハーネス骨格の自己採点 → 強化 → セルフレビュー(手動起動のみ / 日英ミラー同期必須) |

各 skill は詳細(`pitfalls.md` 等)を必要時に Read し、期待動作の基準を `evals/evals.json` に持つ。同梱 skill も併用する:
`/verify`(実アプリで動作確認)/ `/btw`(文脈を汚さない脇質問)/ `/goal <完了条件>`(条件を満たすまで継続)/ `/batch`(大量ファイル並列変更)。

## チームテンプレート

`.claude/teams/` 配下の `TEAM_*.md` を起動すると multi-agent 編成で動く:

- フルライフサイクル: `TEAM_PJM.md`(推奨)
- 機能開発: `TEAM_FEATURE.md` / 品質保証: `TEAM_QA.md`
- 設計: `TEAM_PLANNING.md` / デザイン: `TEAM_DESIGN.md` / リファクタ: `TEAM_REFACTOR.md`

team は起動時に `.claude/teams/README.md` と `.claude/agents/README.md` を Read する。差分の網羅レビューは saved workflow `/review-sweep`。
`.claude/teams/` は `full` プロファイル(`setup.sh` の既定)でのみ同梱。`minimal` / `standard` では個別 skill のみ使える。

- Agent Teams は `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` で有効化(既定は無効)
- `teammateMode` は teammate の**表示先**(`in-process` / `auto` / `tmux` / `iterm2`)。
  リポジトリを分離したいときは subagent の `isolation: worktree` を使う
- PJM チームは `input/` を読み `output/` に成果物生成、PL がタスク分解・割り当て

## ルール階層(`.claude/rules/`)

- `paths:` なし = 全セッション常時 load(`git-conventions.md` のみ)
- `paths:` あり = 該当ファイルを触ったときだけ load(`document-management.md` / `workflow-advanced.md` / `harness-authoring.md`)
- 言語別・レイヤー別ルールは `.example` をコピーし `paths:` を編集して有効化する
- タスク固有の手順は rules ではなく skill に置く。「毎回必ず X」は指示ではなくフックにする

## 品質ゲートの仕組み

- 各 phase skill は `.claude/quality-gates.md` のゲート基準を必要時に参照する
- `verify-gate.sh` がソース編集後の未検証終了(Stop)と完了マーク(TaskCompleted)を検知する(standard=警告 / strict=差し止め)
- 各 skill は `evals/evals.json`(典型 + 境界)を持つ。skill を変えたら `/skill-eval skill=<名>` で with / without の pass rate を比べる

## ツール利用方針

- 調査: コードは Glob/Grep、ドキュメントは 1) `docs/` → 2) WebFetch 公式 → 3) Context7 MCP → 4) WebSearch。Playwright MCP: E2E デバッグ・ビジュアル確認 / draw.io MCP: 図表

## セキュリティ(多層防御)

- **多層防御**: sandbox(Layer 0・任意) → フック(Layer 1) → deny/ask(Layer 2) → allow(Layer 3)
- **`--no-verify` 禁止 / `--force` 付きの push は原則禁止**。安全に関わる禁止事項は `AGENTS.md` と重複しても本ファイルに置く(分類器が import 先を読むかは公式に記載が無い)
- `.env` / 秘密鍵 / `*.pem` は `Read()` deny で読み取り自体を遮断し、外向き・不可逆操作(push / merge / publish / apply)は `ask` で毎回確認
- auto mode(Pro/Max/Team の既定モード)でも `ask` は必ず確認され、`deny` は分類器より前に効く。分類器は本ファイルも読む
- フックは `--dangerously-skip-permissions` でも有効。`scan-harness.sh` が `constitution.md` の改変を検知する
- SessionStart フックが起動時に `project-config.md` / `docs/` / `settings.local.json` をチェックし、`output/tasks/PROGRESS.md` があれば冒頭を注入する
- 詳細(deny ルール一覧、保護ファイル、権限設計)は `.claude/guardrails.md` と `.claude/permissions-guide.md`

## フェーズ別出力スタイル

`.claude/output-styles/` に 4 種同梱し `/output-style <名>` で切替(いずれも `keep-coding-instructions: true`): 要件定義 `phase-prd` / 設計 `phase-design` /
実装 `phase-implementation` / レビュー `phase-review`。`statusLine`(`.claude/statusline.sh`)が現在のスタイルとフェーズを自動表示。

## ワークフロー制御

### 1. 計画ファースト

非自明タスク(3+ ステップ or アーキテクチャ判断)は計画モードで開始。差分を 1 文で説明できる作業は計画を省く。検証ステップも計画に含める。

### 2. サブエージェント戦略

定義集と使い分けは `.claude/agents/README.md`(常時 import しない)。書込可能な 3 agent は `scope-guard.sh` が書込範囲を強制する。
メインコンテキストを圧迫しないよう subagent を積極活用。1 subagent = 1 task。subagent は既定でバックグラウンド実行され要約だけが戻る。
実装後は fresh context のレビュー subagent(`/code-review`)に「正確性・要件に影響する gap のみ」を報告させる。

### 3. コンテキスト保全

`/rewind` でファイル・会話をチェックポイントから復元できる(`fileCheckpointingEnabled`)。無関係なタスクの前に `/clear`。
同じ修正を 2 回繰り返したら `/clear` して指示を書き直す。コンパクト時は PreCompact でバックアップし、
PostCompact が置いたマーカーを次プロンプトで回収して中核ルールを再注入する(詳細は `.claude/guardrails.md`)。

### 4. 詳細手順(必要時のみ load)

自己改善ループ / 完了前検証 / 自律バグ修正 / タスク管理 / 長期タスクの詳細は `.claude/rules/workflow-advanced.md`(ソースを触ると自動 load)。

## コンパクト時の指示(Compact instructions)

コンパクト(要約)では次を必ず保持する: 変更したファイル一覧 / 実行した検証コマンドと結果 /
未完了タスクと次の一手 / 採用・却下した設計判断 / 出力先(`output/`)の規約。ツール出力の生データは捨ててよい。

## プロジェクト固有情報(常時 load)

@docs/project.md              <!-- 技術スタック・コマンド・ルーティング -->
@docs/architecture.md          <!-- ディレクトリ構成・テスト一覧 -->
@docs/data-model.md            <!-- スキーマ・バリデーション -->
@docs/development-patterns.md  <!-- コード規約・パターン -->
