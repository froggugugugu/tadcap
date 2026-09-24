# AGENTS.md

コーディングエージェント共通の開発ルール(ツール非依存)。主系の Claude Code は `CLAUDE.md` の `@AGENTS.md` で取り込み、
Codex / Cursor は既定で読む。Copilot / Gemini CLI などは設定で読ませる(`project-config.md` §13.7)。
Claude Code 固有の仕組み(skill / team / subagent / フック / 権限)は `CLAUDE.md` に書く。

## 全般

- 必ず日本語で応対する
- 重要な決定事項は定期的にマークダウンファイルに記録する
- **完了報告には証拠を添える**(テスト出力・実行コマンドと結果・スクリーンショット)。証拠のない「完了」は禁止
- 着手前に `docs/` の `project.md` / `architecture.md` / `data-model.md` / `development-patterns.md` を読む(Claude Code は自動 load)。無い or stub(5 行未満)なら `project-config.md` の該当セクションを参照する

## 開発原則

- 仕様が曖昧な場合は推測で進めず、選択肢を 1〜2 つ提示して確認する
- ユーザーデータの削除・上書きは仕様で明示要求された場合のみ
- 保存値と表示値が区別されるならデータモデルと UI で分離する
- 決定論的であること(丸めモード・フォーマット・集計スコープを明確に)
- 過剰設計を避ける — 現要件に必要な最小限の複雑さで実装
- コードから読み取れる情報をドキュメントに重複させない
- 実装前に既存コード・パターン・公式ドキュメントを確認する。外部サービスは CLI(`gh` / `aws` / `gcloud` 等)を優先する

## ドキュメント管理(短縮版)

- **人間管理**: `project-config.md`(13 セクション) / `input/requirements/` / `constitution.md`(repo ルート)
- **AI 管理**: `docs/*.md`(プロジェクト派生情報) / `output/`(成果物) / `testreport/`(ツール生データ)
- **AI が更新可能なセクション**: `project-config.md` §2(技術スタック)/ §3(コマンド)/ §11(既知の落とし穴)のみ。§1 / §4-§10 / §12 / §13 は人間決定領域(改変不可)
- **一次更新責務**: `docs/*.md` と `project-config.md` §2/§3 は実装タスク(`/implementing-features`)が集約。他タスクは発見事項を報告
- **詳細**(競合防止表 / docs 更新の細則): `docs/`・`output/` を編集する前に `.claude/rules/document-management.md` を読む

## アーキテクチャガバナンス

- レイヤー間の依存方向制限。詳細は `project-config.md` §4.4
- 依存方向違反は検出コマンド(`project-config.md` 記載)で確認
- 循環依存は禁止

## 品質基準・ゲート

- TDD(`project-config.md` §6 で有効化時)、ユニット + E2E。カバレッジ目標は `project-config.md` §6
- **5 つの品質ゲート**: PRD / 設計 / タスク分解 / 実装 / 検証(各 phase で人間介入可)。基準は `.claude/quality-gates.md`
- **検証手段を先に用意する**: 着手前に pass/fail を返すチェック(テスト / ビルド / lint / スクリーンショット比較)を決め、完了時にその結果を貼る

## 実装ワークフロー

要件確認 → 影響調査 → テスト設計 → **🚏 設計ゲート** → 実装 → リファクター → **🚏 実装ゲート** → セルフレビュー → **🚏 最終ゲート**

- 同一ファイルの同時編集は禁止。共有レイヤー変更は逐次
- 複数セッションにまたがる作業は `output/tasks/PROGRESS.md`(雛形 `.claude/tasks/PROGRESS_TEMPLATE.md`)で引き継ぐ。
  1 セッション 1 機能、着手前にスモークテスト、終了時はテスト緑 + コミット + PROGRESS 更新

## 実装チェックリスト(提出前)

- [ ] データモデル/スキーマ変更を明記、UI 動作(編集 vs 読取)を定義
- [ ] コアアルゴリズム(丸め・書式・集計)を明確化
- [ ] 受け入れ基準との対応 / 既存テスト破壊なし / エッジケース考慮
- [ ] 実装変更に伴い `docs/` 更新、依存方向違反なし、`--no-verify` 不使用
- [ ] 検証コマンドの実行結果(pass/fail 件数・エラー数)を報告に添付

## コミュニケーション規約

- 技術的判断には根拠を添える / 仕様変更は影響範囲を提示してから着手
- レビュー指摘は修正内容と理由をセットで回答 / 不確実な仮定は「【仮定】」と明示

## セキュリティ

- ユーザー入力は必ずバリデート / 依存 CVE を定期確認
- `.env` / 秘密鍵 / `*.pem` は読まない・コミットしない
- 外向き・不可逆操作(push / merge / publish / apply)は毎回人間に確認する
- `project-config.md` §10 にプロジェクト固有ポリシーを定義

> **不変原則**(`constitution.md` で全文管理): ①人間↔AI 責務分離 / ②日英 2 言語ミラー / ③5 品質ゲート維持 /
> ④三層分離(skill/team/agent) / ⑤3 層防御維持 / ⑥CLAUDE.md + AGENTS.md ≤200 行 / ⑦シークレット禁止

## Git 操作

- `--no-verify` 禁止 / `--force` 原則禁止 / フック失敗時はフックを無効化せず原因修正
- Conventional Commits 必須。コミット前に `.claude/rules/git-conventions.md` を読む(Claude Code は常時 load)

## Claude Code 以外で使うとき

- 利用エージェントの役割と書込範囲は `project-config.md` §13.7 に従う。そこで `yes` になっていなければ読取専用で振る舞う
- `.claude/` の安全装置(フック・deny/ask ルール・書込範囲の強制)は Claude Code でしか動かない。上記のセキュリティ規則と Git 規則を自分で守る
- `/prd` などのスラッシュコマンドは使えない。同じ手順が `.claude/skills/<名前>/SKILL.md` にあるので、
  依頼されたら読んで従う。subagent などの Claude Code 固有機能は、手元で順に実行する形に読み替える
