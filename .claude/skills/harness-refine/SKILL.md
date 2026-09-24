---
name: harness-refine
description: >
  .claude/ ハーネス(skill・agent・team・rules・フック設定)を最新の公式ベストプラクティスで自己採点・補正し、日英ミラーを同期する。
  「ハーネス補正」「ベストプラクティス準拠」「ハーネス自己点検」の依頼で使う。手動起動のみ。
argument-hint: "<対象ディレクトリ or 補正指示(省略可)>"
allowed-tools: Read, Glob, Grep, Bash(ls *, find *, wc *, diff *, grep *, git *), Edit, Write, WebFetch, WebSearch, Agent, mcp__context7__resolve-library-id, mcp__context7__query-docs, mcp__plugin_context7_context7__resolve-library-id, mcp__plugin_context7_context7__query-docs
effort: high
disable-model-invocation: true
---

# Harness Refine — 自己強化型ベストプラクティス補正(Round 0 リフレッシュ + 2 ラウンド固定)

ハーネス構成(`project-blueprint/` および `project-blueprint-en/`)を、
**Claude Code 公式ベストプラクティス**(毎回 Round 0 で再取得)と
**`constitution.md` 7 原則** の両方を rubric として
**自己採点 → 自己強化 → セルフレビュー** を **2 ラウンド** 回して構造補正するメタスキル。

実装コード、`docs/` 内容、`output/` 成果物、`testreport/` 生データは対象外。**テンプレート骨格のみ**を扱う。

## 自己強化メカニズム(本スキルの核)

本スキルは rubric を凍結せず、走るたびに自律的に強くなる。3 つの機構で実現する:

1. **Round 0 リフレッシュ**(非破壊): 公式一次ソース(下記「ベストプラクティス基準ソース」)を
   WebFetch / Context7 で再取得し、最新ガイダンスとの差分を **今回ラウンドの暫定採点基準**に反映する。
   訓練データだけで判断しない。
2. **adaptive ループ**: 過去レポート(`output/reports/harness-refine/`)を読み、
   **未解決課題**と **2 回以上再発した指摘**を抽出して優先補正対象へ昇格する(失敗をループでなく学習に変える)。
3. **rubric 自己進化**: Round 0 で新しい公式ベストプラクティスを発見したら **新規採点項目を提案**する。
   ただし `constitution.md` に触れる変更は自動採用せず、必ず人間承認を得る。

## 前提条件

| 参照 | 用途 | 改変 |
| ---- | ---- | ---- |
| `constitution.md`(repo ルート) | 7 不変原則(rubric の上位条件) | ❌ 改変禁止 |
| `project-config.md` §1 / §4-§10 / §12 / §13 | 人間決定領域 | ❌ 改変禁止 |
| `project-config.md` §2 / §3 / §11 | AI 可変領域 | ⚠️ 構造のみ可(値は触らない) |
| `project-config.md` §13 | Opus/Sonnet/Haiku tier 戦略(採点 11 で参照) | ❌ 改変禁止(参照のみ) |
| `AGENTS.md` | ツール共通の横断ルール(`CLAUDE.md` と合わせて原則 ⑥ の行数に数える) | ✅ |
| `.claude/CLAUDE.md` | Claude Code 固有の横断ルール(原則 ⑥: `AGENTS.md` と合わせて ≤200 行目安) | ✅ |
| `.claude/skills/*/SKILL.md` | スキル骨格(frontmatter / pipeline / description) | ✅ |
| `.claude/agents/*.md` | 単発専門家定義(最小権限 / 単一責務) | ✅ |
| `.claude/teams/TEAM_*.md` | オーケストレーション | ✅ |
| `.claude/hooks/*.sh` | 3 層防御 Layer 1 | ❌ 本スキルでは触らない(別 PR で議論) |
| `.claude/rules/*.md` | パス / 言語別ルール拡張 | ✅(`.example` 規約を維持) |
| 過去レポート(`output/reports/harness-refine/`) | adaptive ループの学習入力 | 読取のみ |
| 公式ドキュメント | 最新 best practice | WebFetch / Context7 MCP |

## 基本姿勢(改変境界 — MUST 守れ)

| 領域 | 可否 | 補足 |
| ---- | ---- | ---- |
| `constitution.md` | ❌ | 改変は別 PR + `.constitution.sha256` 更新が必須(原則範囲外) |
| `project-config.md` §1 / §4-§10 / §12 / §13 | ❌ | 人間決定領域 |
| `project-config.md` §2 / §3 / §11 | ⚠️ | 構造的整形のみ。値の改変は禁止 |
| `.claude/CLAUDE.md` + `AGENTS.md` | ✅ | 合計 200 行を超えない(220 行ハード上限)。`@AGENTS.md` の取り込みを消さない。AGENTS.md に行頭 `@` を書かない |
| `.claude/{skills,agents,teams,rules,output-styles}/` | ✅ | name 衝突 / 循環参照を作らない |
| `.claude/hooks/*.sh` | ❌ | スクリプト本体の編集は禁止(原則 ⑤) |
| `docs/`, `output/`, `testreport/` 内容 | ❌ | 本スキル対象外(`output/reports/harness-refine/` のみ書く) |
| `input/requirements/` | ❌ | 人間入力 |

破ろうとした場合は **即停止して人間に確認**。`scan-harness.sh` フックが検知する場合もある。

## 使い方

```text
/harness-refine <対象ディレクトリ or 補正指示(省略可)>
```

引数を省略した場合は `project-blueprint/` と `project-blueprint-en/` 全体を対象とする。代表的な起動例:

- 「ハーネスを補正して」「ベストプラクティス準拠で再構築して」「セルフリファインして」
- 「.claude/ の構造を見直したい」「skill / agent / team の配置を点検したい」
- 「project-blueprint と project-blueprint-en の整合性を整えて」

## 全体ワークフロー(Round 0 + 2 ラウンド固定 — 3 ラウンド目は禁止)

```text
Round 0(非破壊・自己強化)        ラウンド 1                          ラウンド 2
  ┌─────────────────┐              ┌─────────────┐                    ┌─────────────┐
  │ 公式 BP 再取得   │              │ 1-A 自己採点 │                    │ 2-A 自己採点 │
  │ 過去レポート学習 │ ── rubric ─→ │   (rubric)   │                    │  (差分中心)  │
  │ ルーブリック差分 │   差分注入    └─────┬────────┘                    └─────┬────────┘
  └─────────────────┘                      ▼                                  ▼
                                     ┌─────────────┐                    ┌─────────────┐
                                     │ 1-B 自己強化 │ ─ 日英ミラー適用 → │ 2-B 自己強化 │ ─ 日英ミラー →
                                     └─────┬────────┘                    └─────┬────────┘
                                           ▼                                  ▼
                                     ┌─────────────┐                    ┌─────────────┐
                                     │ 1-C レビュー │ (code-reviewer)    │ 2-C レビュー │ (code-reviewer)
                                     └─────┬────────┘                    └─────┬────────┘
                                           └──────► R2 入力 ───────────────┘
                                                                              ▼
                                                                       最終レポート出力
```

- **Round 0** で **最新ベストプラクティス取得 + 過去レポート学習**(ファイルは一切編集しない)
- ラウンド 1 で **大枠補正**(命名揺れ、配置ミス、frontmatter 欠落、ミラー乖離など)
- ラウンド 2 で **R1 残課題 + 二次効果**(`@import` 切れ、CLAUDE.md スキル一覧との不整合、リンク 404)
- 各ラウンドのレビューは `pr-review-toolkit:code-reviewer` agent に委任して **独立判定**を取る
- ラウンド 2 で承認に届かなければ **人間にエスカレーション**(自動 3 ラウンド禁止)

## Round 0 — ベストプラクティス・リフレッシュ(自己強化プリフライト / 非破壊)

ファイルを **一切編集しない**。調査と差分生成のみ。手順:

1. **最新公式ガイダンスの取得**: 末尾「ベストプラクティス基準ソース」の URL を WebFetch、
   ライブラリ系は Context7 で取得する。取得失敗時は **degraded モード**として訓練データ + 過去レポートで継続し、
   その旨を会話とレポートに明示する(無言で訓練データに退行しない)。
2. **過去レポート学習**: `output/reports/harness-refine/REFINE_*.md`(あれば最新 2〜3 件)を読み、
   (a) **未解決課題** (b) **2 回以上再発した指摘** を抽出する。
3. **ライブ・ルーブリック差分の生成**: 取得した最新ガイダンスを下記 15 項目 rubric と突き合わせ、
   - 既存項目の判定基準が古ければ **今回ラウンドの暫定基準**として更新する
   - 公式に新しい強い推奨があれば **新規採点項目候補**として記録する
   - 再発課題は **優先補正対象**へ昇格する
4. **人間承認ゲート**: 新規採点項目の追加提案、または `constitution.md` に波及する変更は、
   **採用前に人間へ提示して承認を得る**(自動編集禁止)。

Round 0 の出力(会話 + 最終レポートに記載):「取得ソースと取得可否」「再発課題リスト」「今回適用する rubric 差分」。

## ラウンド 1 — 大枠補正

### 1-A. 自己採点(15 項目 × 0/1/2 点 = 30 点満点)

採点は **acceptance checklist 方式**(spec-kit 流): 各項目の 2 点条件を満たすかを YES/NO で判定し、根拠を添える。

**A 群 — constitution / 構造の不変条件**

| # | 項目 | 0 点 | 1 点 | 2 点 |
| - | ---- | ---- | ---- | ---- |
| 1 | constitution 7 原則の遵守 | 違反あり | 形式上遵守 | + `scan-harness.sh` でテスト化 |
| 2 | CLAUDE.md + AGENTS.md ≤200 行(原則 ⑥) | 220 行超 | 200-220 行 | 200 行以下 + 真の削減は path-scoped `rules/` で実現(`@import` は context を減らさない点を理解) |
| 3 | skill frontmatter 規約 | name / description 欠落 | 全項目あり | + allowed-tools(最小権限)/ context / argument-hint 整備 |
| 4 | 三層分離(skill ⇄ agent ⇄ team, 原則 ④) | 循環 / 混在あり | 直線的 | + `agents/README.md` に選定ガイド |
| 5 | 3 層防御維持(原則 ⑤) | hook 削除あり | 同数維持 | + 各 hook の責務 header コメントあり |
| 6 | 日英ミラー同期(原則 ②) | ファイル数 / 構造に差 | ファイル数一致 | + 章立て・行数まで一致(機械 diff で乖離 0) |
| 7 | rules オプトイン方式 | `.example` なし or 直読み込み | `.example` あり | + 命名規約(`language-*`, `path-*`, `rule-*`)厳守 |
| 8 | 5 品質ゲート(原則 ③) | 削減あり | 5 ゲート存在 | + 各 skill がゲート基準(`.claude/quality-gates.md`)を読む条件つきで参照(行頭 `@` で添付しない) |

**B 群 — Anthropic 公式ベストプラクティス + GitHub TOP5 エッセンス**

| # | 項目 | 0 点 | 1 点 | 2 点 |
| - | ---- | ---- | ---- | ---- |
| 9 | pipeline 連携・発見可能性(superpowers 流) | 前後工程記載なし / dead-skill あり | 一部記載 | 全 skill に「前 → 本 → 後」表 + どの導線からも孤立した skill なし |
| 10 | 公式 best-practice 準拠 | 古い形式 | 一部準拠 | Round 0 取得の最新形式に準拠 |
| 11 | skill description 品質(三人称 / 何を + いつ) | 一人称・二人称 or 曖昧 | 三人称 | + ≤1024 字(目安 300)/ 主用途が先頭 / 制約・引数説明を含まない / 重複トリガーなし |
| 12 | progressive disclosure | SKILL.md 肥大(>500 行)/ 冗長な背景説明 | ≤500 行 | + 行頭 `@` 添付なし / 詳細は `references/` に 1 階層 / 100 行超の参照に目次 |
| 13 | agent 最小権限・単一責務 | 読取専門 agent に Write/Edit / 多責務 | tools allowlist あり | + read-only 系は Write 無し / 書込可能 agent は frontmatter hooks で書込範囲を強制 / 要約のみ返す契約を明記 |
| 14 | モデル tier 配置(§13 / BMAD 流) | tier 記載なし | tier 記載あり | + 計画系=高 tier / 機械的作業=低 tier の妥当配置 |
| 15 | eval-first / 受け入れチェックリスト | 検証観点なし | 出力契約あり | + 全 skill に `evals/evals.json`(典型 + 境界の 2 ケース以上・検証可能な assertions) |

**目標**(将来の項目追加でも壊れない %): ラウンド 1 で **≥80%(≥24/30)**、ラウンド 2 で **≥95%(≥28/30)**。

採点根拠は会話内に **必ずファイルパス + 行番号**で提示する(「なんとなく低い」は禁止)。
項目 10 / 11 / 12 の判断は Round 0 で取得した最新公式ガイダンスを基準にする。

### 1-B. 自己強化(補正)

スコア 0 / 1 点の項目を補正する。優先順(Round 0 で昇格した再発課題を最優先):

1. **constitution 違反**: 即停止 → 人間確認(自動修正禁止。違反内容を箇条書きで提示)
2. **CLAUDE.md + AGENTS.md 行数超過**: トピックを `.claude/rules/<topic>.md` に切り出し → 真に context を削るなら path-scoped 化
3. **frontmatter 欠落 / 命名揺れ / description 品質**: 三人称・トリガー明示・最小権限 allowlist に統一
4. **三層分離違反**: 該当呼び出しを単方向に矯正(skill → agent は可、agent → team は禁止)
5. **ミラー乖離**: 不足側にコピーし、文言は既存 `README-en.md` のトーンで翻訳
6. **`.example` 規約違反**: 実体ファイルを `.example` に戻すか、命名規約に揃える

**ミラー適用ルール**:

- 日本語側で 1 ファイル変更したら **同じターンで英語側にも適用**(片側だけで完了させない)
- 構造は完全一致、文言のみ翻訳。章立て番号・テーブル列・コードブロックは bit-identical
- 英語版にだけある体裁要素(セミコロン区切り等)は維持

### 1-C. セルフレビュー(独立判定)

`Agent` 経由で `pr-review-toolkit:code-reviewer` を **1 回呼ぶ**。渡すコンテキスト:

- ラウンド 1 で行った全 Edit / Write の `git diff`
- `constitution.md` 7 原則の遵守チェックを明示依頼
- 日英ミラー差分(`diff -r project-blueprint/.claude/skills/ project-blueprint-en/.claude/skills/` の結果)

レビュー結果(MUST / SHOULD / CONSIDER)はラウンド 2 入力に集約。

## ラウンド 2 — 残課題と二次効果(adaptive)

### 2-A. 自己採点(差分中心 + 解消率)

ラウンド 1 で **1 点以下** だった項目を再採点。加えて以下を新規スコア対象に追加:

- ラウンド 1 Edit の副作用(`@import` 切れ、参照リンク 404、CLAUDE.md スキル一覧との不整合)
- ミラー側に取りこぼした変更
- code-reviewer の指摘(MUST は必ず採点へ反映)
- **解消率トラッキング**: Round 0 で抽出した再発課題が今回解消されたか(再発 3 回目以上は人間エスカレーション候補)

### 2-B. 自己強化(クロージング)

- 残スコアを 2 点に引き上げる微修正のみ。新規大規模変更はしない
- `@import` リンク全件の存在確認:

  ```bash
  grep -rh '^@\.claude' project-blueprint/ project-blueprint-en/ | sort -u | \
    while read line; do
      path="${line#@}"
      test -e "project-blueprint/$path" || echo "MISSING(JP): $path"
      test -e "project-blueprint-en/$path" || echo "MISSING(EN): $path"
    done
  ```

- `CLAUDE.md` スキル一覧表の rebuild(`.claude/skills/*/SKILL.md` の `name:` と突き合わせ)
- ファイル数差を 0 に:

  ```bash
  diff <(cd project-blueprint && find .claude -type f | sort) \
       <(cd project-blueprint-en && find .claude -type f | sort)
  ```

### 2-C. セルフレビュー(最終)

再度 `pr-review-toolkit:code-reviewer` を呼ぶ。判定:

| レビュー判定 | 次アクション |
| ------------ | ------------ |
| **承認** | 最終レポート生成 → スキル終了 |
| **条件付き承認** | 残 MUST 修正可能か確認 → 可なら修正、不可なら人間エスカレーション |
| **要修正** | **即停止して人間エスカレーション**(ラウンド 3 への自動継続は禁止) |

## 出力契約

### 最終レポート(必須)

`output/reports/harness-refine/REFINE_<YYYY-MM-DD>_<HHMM>.md` に出力:

雛形は [references/report-template.md](references/report-template.md) にある。必要になったときに読み、そのままコピーして埋める。

### 会話への提示

- Round 0 開始時に「取得する公式ソースと過去レポート学習結果」を明示
- 各ラウンド開始時に「これからラウンド N の採点を行います」と明示
- 採点結果は **1 行 1 項目** で表示(箇条書き)
- 補正は **何を / なぜ / どこを** を都度報告(silent edit 禁止)
- ミラー適用は **JP → EN を同一ターンで報告**

## 他スキルとの連携

| 前工程 | 本スキル | 後工程 |
| ------ | -------- | ------ |
| (なし — メタスキル) | `/harness-refine` | `/code-review`(コード側) / `/refactoring`(コード側) |

`/refactoring` はソースコード再構成、本スキルはハーネス骨格再構成と役割が異なる。混同しないこと。

## 禁止事項

- `constitution.md` の改変(全文 immutable)
- `project-config.md` §1 / §4-§10 / §12 / §13 の改変
- `.claude/hooks/*.sh` 本体の改変(原則 ⑤)
- 日英ミラーの **片側だけ**更新して完了とすること(原則 ②)
- `--no-verify` / `--force` を使った git 操作
- **3 ラウンド以上の自動ループ**(ラウンド 2 で承認得られなければ人間判断)
- Round 0 でのファイル編集(Round 0 は非破壊・調査専用)
- 新規採点項目や constitution 波及変更を **人間承認なしで自動採用**すること
- ソースコード / `docs/` 内容 / `output/`(本スキル成果以外) / `testreport/` への変更
- 採点根拠を伴わないスコア提示 / Round 0 取得失敗を無言で訓練データに退行させること

## ベストプラクティス基準ソース(Round 0 で再取得 — 公式一次ソース優先)

| ソース | 用途 | rubric 対応 |
| ------ | ---- | ----------- |
| platform.claude.com/docs `agents-and-tools/agent-skills/best-practices` | SKILL.md / frontmatter / progressive disclosure / eval-first | 3, 11, 12, 15 |
| code.claude.com/docs `best-practices` | 検証手段の付与 / plan → code / 敵対的レビュー / auto mode / 失敗パターン | 9, 10, 15 |
| code.claude.com/docs `sub-agents` / `skills` / `hooks` / `permissions` / `settings-reference` | 公式 enum・既定値(fork mode / bundled skill 上書き / `Tool(param:value)` ルール等) | 3, 5, 10, 13 |
| code.claude.com/docs `memory` / `context-window` / `prompt-caching` / `costs` | CLAUDE.md 行数 / 起動時 load コスト / キャッシュ無効化要因 / compact 指示 | 2, 12 |
| claude.com/blog `steering-claude-code-skills-hooks-rules-subagents-and-more` | CLAUDE.md / rules / skills / hooks / subagents / output styles の使い分け | 4, 10 |
| code.claude.com/docs `whats-new`(直近 8 週) | 新機能・既定値変更の検知(rubric 自己進化の入力) | 全項目 |
| agentskills.io `specification` / `skill-creation/evaluating-skills` | description 上限 / `evals/evals.json` 形式 / assertion の書き方 | 11, 15 |
| claude.com/blog `a-harness-for-every-task-dynamic-workflows-in-claude-code` | workflow パターン(fan-out / adversarial verify / loop-until-done) | 4, 9 |
| anthropic.com/engineering `writing-tools-for-agents` | ツール定義の明確さ・トークン効率 | 10, 11 |
| anthropic.com/engineering `effective-context-engineering-for-ai-agents` | コンテキスト curation / sub-agent 隔離 | 12, 13 |
| anthropic.com/engineering `effective-harnesses-for-long-running-agents` | 起動オリエンテーション / 検証ループ | 9, 15 |
| GitHub: spec-kit / BMAD-METHOD / SuperClaude / agent-os / superpowers | acceptance checklist / モデル tier / standards 集約 / discoverability | 9, 14, 15 |

> 取得に失敗したソースは degraded として明示し、当該 rubric 項目は前回基準で暫定採点する。

## 関連参照

必要になったときだけ Read する:

- `.claude/guardrails.md` — フック・deny ルールの挙動を確認するとき
- `.claude/quality-gates.md` — ゲート通過基準と定量計測表を確認するとき
- `.claude/rules/workflow-advanced.md` — 完了前検証や長期タスク引き継ぎの手順を確認するとき
- `.claude/pitfalls.md` — 既知の失敗パターンに当たりそうなとき(該当する節だけ読む)
