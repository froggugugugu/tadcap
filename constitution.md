# Constitution — 不変原則(Inviolable Principles)

このファイルは `project-blueprints` リポジトリの**変えてはいけない 7 原則**を定義する。
`project-config.md`(可変パラメータ)の上位に位置し、AI が破ろうとした場合は
`scan-harness.sh` フックが検知する。

> 変更が必要な場合は、PR で明示的に議論し、`.claude/.constitution.sha256` も同時更新すること。
> AI が単独で書き換えることは禁止。

---

## 1. 人間と AI の責務分離は崩さない

`project-config.md` は人間が決定する。`docs/`、`output/`、`testreport/` は AI が生成する。
この境界を曖昧にしない。

- **人間管理**: `project-config.md`、`input/requirements/`、`constitution.md`(本ファイル)
- **AI 管理**: `docs/`(プロジェクト派生情報)、`output/`(成果物)、`testreport/`(ツール生データ)

## 2. 日英 2 言語ミラーを維持する

`project-blueprint/`(日本語)と `project-blueprint-en/`(英語)は構造的に同期する。
片方への変更は他方にも反映する。文言は翻訳でよく、内容(章立て・ファイル数・機能)は同一に保つ。

## 3. 5 つの品質ゲートを削減しない

PRD 完了 / 設計完了 / タスク分解完了 / 実装完了 / 検証完了の 5 点は、人間の介入機会として残す。
人間の介入は任意だが、ゲートそのものを削ってはならない。

## 4. 三層分離(skill / team / agent)を守る

- **Skill**: 1 つのフェーズ単位の作業手順(`.claude/skills/`)
- **Team**: 複数 skill を組み合わせるオーケストレーション(`.claude/teams/`)
- **Agent**: 単発の専門家委任(`.claude/agents/`)

層を混ぜない。skill が team を呼ぶ、agent が agent を spawn する、等の循環は禁止。

## 5. 3 層防御を弱体化しない

Layer 1: フック(常時有効) / Layer 2: deny ルール(共有) / Layer 3: allow ルール(個人)。
`--dangerously-skip-permissions` でも Layer 1 は有効。フック群を停止・無効化する変更は禁止。
新しい hook を追加する変更は許容。

## 6. 常時 load する指示(CLAUDE.md + AGENTS.md)は合計 200 行以内を目安、220 行を超えたら切り出し

肥大化するとルールが埋もれて遵守率が落ちる(pitfalls.md #1, #18)。
Claude Code は `CLAUDE.md` と、その冒頭の `@AGENTS.md` で取り込む `AGENTS.md`(ツール共通ルール)を毎セッション全文読むため、
2 ファイルの**合計**で数える。片方へ移すだけでは削減にならない。

- **目安**: 合計 200 行以内
- **ハード上限**: 合計 220 行(超過したら次回の編集で必ず切り出し)
- **切り出し先**: `.claude/rules/<topic>.md`(`paths:` 付き)、`.claude/skills/<name>/SKILL.md`、`docs/<topic>.md`
- **判定**: 1 つのトピックが 20 行を超えたら切り出し候補。`@import` は毎セッション全文 load され削減にならないため、
  パスと読む条件の記述で参照する

## 7. シークレットは絶対にコミットしない

`.env*`、秘密鍵、API トークンは `protect-files.sh` で保護される。
`scan-harness.sh` がハーネス内のシークレット混入も検出する。
仮に検出された場合は、即座に履歴ごと削除し、該当キーをローテーションする。

---

## 変更プロトコル

1. 本ファイルの変更を提案する PR を作成
2. **PR 内で**以下のコマンドで hash を再計算し、`.claude/.constitution.sha256` を
   同 PR にコミットする(別 PR で後追い禁止):

   ```bash
   # Linux / GNU coreutils
   sha256sum constitution.md | cut -d' ' -f1 > .claude/.constitution.sha256
   # macOS / BSD (sha256sum 不在環境のフォールバック)
   shasum -a 256 constitution.md | cut -d' ' -f1 > .claude/.constitution.sha256
   ```

3. レビューで合意 → マージ

`scan-harness.sh` は本ファイルの hash 不一致を検出したら strict プロファイルで
skill 起動をブロックする(standard プロファイルでは警告のみ)。

---

## 関連ドキュメント

- `@project-blueprint/project-config.md` — 可変パラメータ(13 セクション)
- `@project-blueprint/AGENTS.md` — ツール共通の開発ルール(Claude Code は CLAUDE.md から取り込む)
- `@project-blueprint/.claude/CLAUDE.md` — Claude Code 固有の開発ガイド
- `@project-blueprint/.claude/guardrails.md` — 3 層防御の詳細
- `@project-blueprint/.claude/pitfalls.md` — 失敗パターンと対策
