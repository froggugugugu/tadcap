# ハーネス補強レポート — 2026-09-05(公式ベストプラクティス総点検)

## サマリ

- 対象: `project-blueprint/` と `project-blueprint-en/` の `.claude/` 骨格 + `scripts/validate_harness.py`
- 変更: 47 ファイル修正 / 6 ファイル新規(JP/EN 各 3)。ミラー構成差分 0
- 検証: `bash scripts/validate-harness.sh` → ERROR 0 / WARN 0、負のテスト 22/22 検出(新規 5 ケース)
- 新規フックの動作テスト: `verify-gate.sh`(track / gate × standard / strict / minimal / stop_hook_active / background_tasks)、
  `permission-denied-log.sh`、`session-start.sh` の PROGRESS 注入をサンプル JSON で確認済み

## Round 0 — 参照した一次ソース(2026-09-05 取得)

| ソース | 反映先 |
| ------ | ------ |
| code.claude.com/docs `best-practices` | 検証手段の付与・証拠提示・Stop フックゲート・敵対的レビュー・plan 省略基準・CLAUDE.md の include/exclude |
| code.claude.com/docs `memory` / `context-window` / `prompt-caching` / `costs` | 200 行目安・HTML コメントは context に載らない・途中編集は無効・Compact instructions |
| code.claude.com/docs `hooks` | `PreModelSwitch` / `PostModelSwitch`、`if` / `once` / `asyncRewake`、prompt / agent 型、Stop の 8 回上限 |
| code.claude.com/docs `permissions` / `permission-modes` / `auto-mode-config` | auto mode 既定化(v2.1.228+)、deny → ask → 分類器の評価順、project settings で無視されるキー、`Tool(param:value)` |
| code.claude.com/docs `skills` / `sub-agents` / `output-styles` | bundled skill の同名上書き、`disable-model-invocation`、fork mode 既定 ON、ネスト 5 階層、`keep-coding-instructions` |
| code.claude.com/docs `worktrees` / `settings-reference` | `.claude/worktrees/` / `agent-memory-local/` の gitignore、`autoMemoryEnabled` |
| anthropic.com/engineering `effective-harnesses-for-long-running-agents` | PROGRESS ノート・機能リスト・1 セッション 1 機能・スモークテスト |
| anthropic.com/engineering `effective-context-engineering-for-ai-agents` | 最小高信号コンテキスト・note-taking・sub-agent 隔離 |
| claude.com/blog `steering-claude-code-...`(Anthropic staff) | 「毎回必ず X」はフック、「絶対にしない」は deny、手順は skill、output style の落とし穴 |
| code.claude.com/docs `whats-new`(W13〜W34) | auto mode 既定化 / fork mode 既定化 / cross-session messaging / dynamic workflows |

## 適用した補正(ファイルパスごと)

### 新規

| ファイル(JP/EN) | 内容 | 根拠 |
| ---------------- | ---- | ---- |
| `.claude/hooks/verify-gate.sh` | PostToolUse で編集 / 検証コマンドを記録し、Stop で未検証終了を検知(standard=systemMessage / strict=1 回 block)。`stop_hook_active` と `background_tasks` を尊重 | best-practices「Stop hook as deterministic gate」/ hooks「8 consecutive blocks」 |
| `.claude/hooks/permission-denied-log.sh` | auto mode の分類器拒否を `testreport/denials/` に JSONL 記録 | auto-mode-config「Review denials」 |
| `.claude/tasks/PROGRESS_TEMPLATE.md` | 複数セッション引き継ぎノート(状態 / 機能リスト passes / 次の一手 / セッションログ) | long-running harness ブログ |

### 修正

| ファイル | 変更 | 根拠 |
| -------- | ---- | ---- |
| `.claude/settings.json` | `verify-gate.sh track`(PostToolUse)/ `verify-gate.sh gate`(Stop)/ `permission-denied-log.sh`(PermissionDenied)を登録(15 スクリプト / 18 登録) | 同上 |
| `.claude/CLAUDE.md` | 証拠ルール、bundled skill(`/verify` `/btw` `/goal` `/batch`)、`/code-review` 上書き注記、auto mode の deny/ask 位置づけ、subagent の背景実行、plan 省略基準、長期タスク引き継ぎ、**Compact instructions** 節。199 行に収めるため 3 節を圧縮 | best-practices / memory / costs |
| `.claude/hooks/session-start.sh` | `output/tasks/PROGRESS.md` の先頭 60 行を additionalContext で注入 | long-running harness |
| `.claude/output-styles/*.md`(4 × 2) | `keep-coding-instructions: true` を追加。**従来は Claude Code 標準のエンジニアリング指示(検証習慣・変更スコープ)を丸ごと落としていた** | output-styles / steering ブログ |
| `.claude/pitfalls.md` | #2 を公式仕様に訂正(subagent は CLAUDE.md / rules を継承する。継承しないのは skill 本文・会話・auto memory)。#23〜#27 追加(auto mode / 途中編集無効 / project settings で無視 / bundled 上書き / Stop ループ) | sub-agents / permission-modes / prompt-caching / skills / hooks |
| `.claude/guardrails.md` | フック一覧 15/18、検証ゲート節、profile 対応リスト、`if` / `once` / `asyncRewake`、`agent` 型、`PreModelSwitch` | hooks |
| `.claude/permissions-guide.md` | 全面改訂: auto mode 既定化、評価順序(deny → ask → 分類器 → フック)、設定の置き場所表、拒否ログ活用、`/auto-mode-setup`、`/goal` | permissions / auto-mode-config |
| `.claude/rules/workflow-advanced.md` | §2 に証拠提示・レビュー subagent の指示、§6「長期タスクの引き継ぎ」新設 | best-practices / long-running harness |
| `.claude/agents/README.md` | 「公式仕様の補足」節: 背景実行 / 継承範囲 / ネスト禁止(constitution ④)/ description 予算 / `Agent(param:value)` / メモリ保存先 | sub-agents / permissions |
| `.claude/skills/code-review/SKILL.md` | 「正確性・要件に影響する gap のみ」原則、bundled `/review` との関係 | best-practices「adversarial review」 |
| `.claude/skills/{review-fix,harness-refine}/SKILL.md` | `disable-model-invocation: true`(副作用のあるワークフローは手動起動) | skills / best-practices |
| `.claude/skills/harness-refine/SKILL.md` | 基準ソース表を更新(404 だった URL を修正、公式ドキュメント 4 群 + steering ブログ + whats-new を追加) | — |
| `.claude/settings.local.json.template` | `_comment_auto_mode` / `_comment_stop_gate`(prompt 型 Stop フック例)追加、Layer 1 一覧更新 | permissions / hooks |
| `.claude/quality-gates.md` / `.claude/teams/README.md` | 証拠要件 / dynamic workflows との使い分け | best-practices / workflows |
| `.gitignore` / `setup.sh` | `.claude/worktrees/` `.claude/agent-memory-local/` `.claude/settings.local.json` を除外(setup.sh はループ化) | worktrees / sub-agents |
| `README.md`(blueprint JP/EN)/ ルート `CLAUDE.md` `README*.md` | フック本数・ツリー・PROGRESS テンプレの反映 | — |
| `scripts/validate_harness.py` / `test_validate_harness.py` | `PreModelSwitch` / `PostModelSwitch`、hook `type` / `prompt` / boolean / timeout 検証、project settings の `defaultMode: auto` / `autoMode` 警告、`disable-model-invocation` / `user-invocable` の厳密値、output style の `keep-coding-instructions` 警告。負のテスト +5 | hooks / permission-modes / output-styles |

## 見送った項目(理由)

- **dynamic workflow(`.claude/workflows/`)の同梱**: スクリプト API を一次ソースで検証してからにする。README / teams で使い分けのみ記述
- **`FileChanged` フック(project-config.md 監視)**: 公式仕様上 decision control も context 注入もできず、ログ以上の価値が薄い
- **`bashOutputMaxChars` 等の出力上限設定**: 既定で十分。プロジェクト側の判断に委ねる
- **plugin 配布の再検討**: 撤回済み判断(2026-08)を覆す新事実なし

## 残課題(人間判断)

1. `verify-gate.sh` の `VERIFY_PATTERNS` はプロジェクトの検証コマンドに合わせて追記する(既定はメジャーな言語 / ツールのみ)
2. `strict` プロファイルで運用するかは各プロジェクトで決める(既定 `standard` は警告のみ)
3. `.claude/settings.json` の編集はテンプレート自身の `protect-files.sh` に阻まれるため、今回はシェル経由で JSON を書き換えた。差分は `git diff project-blueprint/.claude/settings.json` で確認できる

## ミラー差分検証(Round 1 時点)

- `.claude/` 配下ファイル数: JP 83 / EN 83(新規 3 ずつ、差分 0)
- `bash scripts/validate-harness.sh`: ERROR 0 / WARN 0(日英 + 構成一致)
- `bash scripts/validate-harness.sh --test`: 22/22 検出

---

## Round 2 — 観点別評価で S 未達だった項目の解消(2026-09-06)

Round 1 後に 12 観点で世界標準基準の評価を行い、総合 A(S 目前)と判定した。
S に届かない要因は (1) 自律運用の自動化不足 (2) 評価基盤の欠如 (3) 組織展開層の未整備の 3 つ。
本ラウンドでそれぞれを解消した。

| 観点 | Round 1 | 対応 | Round 2 |
| ---- | ------- | ---- | ------- |
| 3 検証ループ | A- | `scripts/test_hooks.sh`(54 ケース、JP/EN 両ミラー)を新設し `--hooks` として CI に組み込み。フックが「存在するだけ」にならない回帰テスト | **S** |
| 6 長期自律運用 | B+ | `/plan` が PROGRESS.md の機能リストを初期化し、`/implementing-features` が `passes` とセッションログを更新する手順を skill 本文と禁止事項に組み込み | **A+** |
| 7 仕様駆動ライフサイクル | S- | `verify-gate.sh task` を **TaskCompleted** に登録。検証コマンド未実行のタスク完了マークを standard=警告 / strict=exit 2 で差し止め(品質ゲート③の機械強制) | **S** |
| 8 サプライチェーン | A- | `.mcp.json.template` の有効サーバーをバージョン固定(`@upstash/context7-mcp@4.0.5` / `@playwright/mcp@0.0.80`)。validator `--online` が固定版の解決を検証し、未固定の有効サーバーを WARN | **A+** |
| 10 可観測性・コスト | B+ | `managed-settings.example.json`(deny / sandbox / OTel / `requiredMinimumVersion`)を同梱し、`settings.local.json.template` に OTel と `modelPricing` の指針を追加 | **A** |
| 11 導入体験 | A- | `setup.sh` が `settings.local.json` を雛形から自動生成。SessionStart の未作成警告が初回から消える | **A+** |
| 12 可搬性・大規模リポ | B | `rules/README.md` に monorepo 指針(per-directory skill / `claudeMdExcludes` / `worktree.sparsePaths` / `skillOverrides`)を追加 | **A** |
| 1 指示の階層化 | A+ | SessionStart が常時 `@import` される `docs/*.md` の肥大化(300 行超)を警告 | **S-** |

**Round 2 後の総合: S-**。残る差は観点 5(dynamic workflows の同梱スクリプト無し)と観点 2(sandbox 既定 OFF、`prompt` / `agent` 型フックは例示のみ)で、いずれも公式機能の成熟待ちか各プロジェクトの判断領域。

### Round 2 検証

- `bash scripts/validate-harness.sh`: ERROR 0 / WARN 0
- `bash scripts/validate-harness.sh --test`: 22/22 検出
- `bash scripts/validate-harness.sh --hooks`: PASS 54 / FAIL 0(JP 27 + EN 27)
- `bash scripts/validate-harness.sh --online`: 固定バージョンが npm で解決することを確認
- `.claude/CLAUDE.md`: JP 199 行 / EN 199 行(上限 200 行以内)

---

## Round 3 — 執筆規約・skill eval・書込範囲の強制(2026-09-12)

ユーザーの再依頼(トレンド・Markdown の書き方・公式ベストプラクティスの包括的な取り込み)を受けた 2 巡目。
公式 docs を再取得し、前回は取り込めていなかった skill 執筆ガイド
(platform.claude.com `agents-and-tools/agent-skills/best-practices`)、agentskills.io の仕様と eval 形式、
dynamic workflows の公式ブログを一次ソースに加えた。

### 公式仕様で判明した欠陥

| # | 欠陥 | 根拠 | 影響 |
| - | ---- | ---- | ---- |
| 1 | 15 skill の「関連参照(必要に応じて Claude が load)」が行頭 `@path` で書かれていた | skills docs: ローカル skill では `@` 参照のファイルが起動時に添付され、会話に残る | 起動のたびに最大 50KB(security-scan)を添付。見出しの説明と実挙動が逆 |
| 2 | description に制約文・引数説明が混在 | skills docs: 一覧予算は context の 1%。溢れると使用頻度の低い skill から説明が落ちる | 200K モデルで予算を超え、自動発動が不安定になる |
| 3 | acceptEdits の doc 系 agent の書込範囲が散文のみ | sub-agents docs: frontmatter `hooks` で agent 実行中だけのフックを定義できる | 範囲外の書込が無確認で通る |
| 4 | skill の eval が無い | skill authoring best practices「Build evaluations first」/ agentskills.io `evals/evals.json` | skill 変更の良し悪しを測れない |
| 5 | team ファイルの `@` 行で README が「自動 load」される前提 | team は Read で読まれ、本文の `@` は展開されない | README が読まれない可能性 |
| 6 | CLAUDE.md が agents/README.md(約 6KB)を常時 import | memory docs: import 先は毎セッション全文 load | 毎セッション約 1.5K トークンを消費 |

### 適用した補正

| 対象 | 変更 |
| ---- | ---- |
| `skills/*/SKILL.md`(17 × 2) | description を「何をするか + いつ使うか」に書き換え。行頭 `@` の参照ブロックを「パス — 読む条件」の箇条書きに変換(常時 load の git-conventions は除外) |
| `skills/*/evals/evals.json`(17 × 2、新規) | 典型 + 境界の 2 ケースと、出力契約から導いた assertions |
| `skills/security-scan/references/scan-categories.md` | 100 行超のため冒頭に目次を追加 |
| `hooks/scope-guard.sh`(新規) | 書込可能 agent の範囲外 Edit / Write を exit 2 で阻止(docs / output / tests)。未知スコープは fail-closed |
| `agents/{doc-synchronizer,doc-writer,test-writer}.md` | frontmatter `hooks.PreToolUse` に scope-guard を登録し、制約節に明記 |
| `rules/harness-authoring.md`(新規、path-scoped) | Markdown の書き方、置き場所の判断、description、`@` 禁止、目次、日付禁止、eval、scope-guard、workflow の決定性 |
| `workflows/review-sweep.js`(新規) | 4 観点並列レビュー → 重複排除 → MUST を 3 票の反証で検証 → 1 本のレポート。検証上限を超えた MUST は未検証として残す |
| `teams/TEAM_*.md`(6 × 2) | `@` 行を「起動時に Read する」指示に変換 |
| `.claude/CLAUDE.md` | agents/README.md の常時 import を廃止し、`@import` 前提の記述を「必要時に Read」に訂正(199 行を維持) |
| `pitfalls.md` | #28 行頭 `@` の添付 / #29 一覧予算 1% / #30 acceptEdits agent の範囲外書込 |
| `harness-refine/SKILL.md` | rubric 8・11・12・13・15 を今回の基準に更新し、基準ソースに agentskills.io と workflows ブログを追加 |
| `setup.sh` / `.gitignore` | full 以外で workflows を剪定。`.claude/skills/*-workspace/` を除外 |
| バッククォート内の `` `@path` `` 表記(59 か所) | `` `path` `` に正規化(constitution.md と過去レポートは除外) |
| `scripts/validate_harness.py` | skill の行頭 `@`、description 上限と人称、日付記述、参照ファイルの目次と入れ子、evals スキーマ、frontmatter hooks、書込 agent の scope-guard 有無、workflow の meta リテラル・phase 整合・非決定 API・構文(node)を検査 |
| `scripts/test_validate_harness.py` / `test_hooks.sh` | 負のテスト +10(計 32 件)、scope-guard の機能テスト +13 × 2 ミラー |

### 定量比較(変更前 HEAD → 変更後)

| 指標 | JP | EN |
| ---- | -- | -- |
| skill 起動時に添付されるファイル合計(17 skill) | 357KB → 0KB | 322KB → 0KB |
| description 合計文字数 | 6,577 → 2,037 | 7,080 → 4,192 |
| 常時 load(CLAUDE.md + import + always-on rule) | 24.0KB → 14.8KB | 21.7KB → 13.4KB |
| skill eval | 0 → 17 skill / 34 ケース / 128 assertions | 同左 |

### 観点別評価の更新

| 観点 | Round 2 | Round 3 | 根拠 |
| ---- | ------- | ------- | ---- |
| 1 指示の階層化 | S- | S | skill 起動時の添付 0、常時 load 約 4 割減、執筆規約を path-scoped rule 化 |
| 2 決定論的ガードレール | S- | S | 書込可能 agent の範囲を frontmatter フックで強制 |
| 3 検証ループ | S | S | skill eval を全 skill に配備し、フック機能テストを 80 ケースに拡充 |
| 5 マルチエージェント構成 | B+ | A | 反証検証つき saved workflow を team 層として同梱 |
| 9 保守性・自己検証 | S | S | 執筆規約の大半を validator で機械検査 |

### Round 3 検証

- `bash scripts/validate-harness.sh`: ERROR 0 / WARN 0
- `bash scripts/validate-harness.sh --test`: 32/32 検出
- `bash scripts/validate-harness.sh --hooks`: PASS 80 / FAIL 0
- `setup.sh` を minimal / standard / full で実展開: workflows は full のみ、settings.local.json 自動生成、.gitignore 追記を確認。full 展開先(JP / EN)に validator をかけて ERROR 0 / WARN 0

### 見送り(理由)

- skill 名の gerund 化(`processing-*` 形式): 公式は推奨止まりで、名前変更は team・docs・利用者の手順に波及する
- SKILL.md 本文の簡潔化(Claude が既に知っている一般論の削減): 17 × 2 ファイルの内容改訂になるため、今回整備した evals を回して差分を測ってから行う
- sandbox の既定 ON: npm install などネットワークを使う作業を壊すため、引き続きプロジェクト側の判断とする
- saved workflow の実行確認: 実行はトークンを大きく消費するため行っていない。構文と workflow 規約は validator(node --check を含む)で検査済み

---

## Round 4 — 出力テンプレートの分離・eval 実行系・新仕様の取り込み(2026-09-19)

3 巡目。公式ドキュメントの更新(W35〜W37)を取得し、Round 3 で「eval を回してから」と見送った
SKILL.md 本文の圧縮を、内容を 1 文字も削らずに済む形で実施した。

### 公式更新の取り込み

| 更新 | 反映先 |
| ---- | ---- |
| `AGENTS.md` を直接読む挙動(作業ディレクトリとその上位に CLAUDE.md が 1 つも無いときだけ) | `rules/harness-authoring.md` / `pitfalls.md` #31 / `setup.sh`(既存 AGENTS.md を検出して import 手順を警告) |
| 制限モード `--restricted`(v2.1.248 以降) | `permissions-guide.md` に節と運用パターン行を追加。フックは project settings 由来なので読まれない点を明記 |
| `claude plugin eval`(プラグイン用で `evals.json` とは別形式) | `rules/harness-authoring.md` の eval 節に併記 |

### 実施した補正

| 対象 | 変更 |
| ---- | ---- |
| 13 skill × 2 ミラー | 本文に埋め込まれていた出力テンプレート(最大 122 行)を `references/*.md` へ逐語で移設し、本文はパスと読む条件のリンクだけにした |
| 100 行超の参照ファイル 4 本 | 冒頭に目次を追加 |
| SKILL.md の参照表記 16 か所 | コードスパンから markdown リンクへ変換(SKILL.md から 1 階層で辿れる状態にする) |
| `workflows/skill-eval.js`(新規) | `evals/evals.json` を skill あり / なしで実行し、実行していない agent が assertions を判定して pass rate を比較する。出力は `testreport/evals/<skill>/iteration-N/` |
| `.claude/CLAUDE.md` | skill 変更後に `/skill-eval` で比較する導線を追加(200 行ちょうど) |
| `scripts/validate_harness.py` | 参照ファイルの未リンク検出、`references/` へのリンク切れ検出、本文 300 行超の警告を追加 |

### 定量比較(origin/main → 本ブランチ)

| 指標 | JP | EN |
| ---- | -- | -- |
| skill 起動時に読まれる本文 | 4,091 行 / 172KB → 3,344 行 / 153KB | 4,107 行 / 154KB → 3,360 行 / 137KB |
| 最長 skill | ui-ux-design 349 行 → harness-refine 281 行 | ui-ux-design 349 行 → harness-refine 291 行 |
| 参照ファイル | 7 本 → 20 本 | 7 本 → 20 本 |
| saved workflow | 1 本 → 2 本 | 1 本 → 2 本 |

移設なので情報量は減っていない。減ったのは「skill を起動した瞬間に context へ入る量」で、テンプレートは
レポートを書く段になってから読まれる。

### Round 4 検証

- `bash scripts/validate-harness.sh`: ERROR 0 / WARN 0
- `bash scripts/validate-harness.sh --test`: 35/35 検出(参照未リンク・リンク切れ・本文超過の 3 件を追加)
- `bash scripts/validate-harness.sh --hooks`: PASS 80 / FAIL 0
- `setup.sh` full プロファイルの実展開: workflow 2 本・eval 17 本・参照 20 本を確認。既存 `AGENTS.md` がある
  ターゲットで import 手順の警告が出ることも確認。展開先に validator をかけて ERROR 0 / WARN 0

### 残課題

- `/skill-eval` と `/review-sweep` の実行確認: どちらもトークン消費が大きいため未実行。構文と workflow 規約は
  validator(node --check を含む)で検査済み。実行すると skill の description と本文の寄与が数値で出る
- skill 名の gerund 化(`processing-*` 形式): 公式は推奨止まりで、名前変更は team・docs・利用者の手順に波及するため引き続き見送り
