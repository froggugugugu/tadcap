# Claude Code Subagents — 使い分けガイド

`.claude/agents/` は、**単発タスクを専門家に委譲するための subagent 定義集**。
Claude Code は各 agent の `description` フィールドを解析して自動発動する。
明示的に呼び出すには `Agent` ツールで `subagent_type: <name>` を指定する。

## agent 一覧

| agent | 用途 | model | effort | tools | 書き込み権限 |
| ----- | ---- | ----- | ------ | ----- | ------------ |
| `explorer` | コードベース内の広範な探索 | `haiku` | low | Read / Grep / Glob | なし |
| `researcher` | 外部技術情報・公式 docs の調査 | `sonnet` | medium | Read / Grep / Glob / WebSearch / WebFetch / Context7 | なし |
| `planner` | 実装前の設計計画立案 | `sonnet` | high | Read / Grep / Glob | なし |
| `security-reviewer` | OWASP 準拠のセキュリティ監査 | `opus` | high | Read / Grep / Glob | なし |
| `performance-analyst` | 計測ファーストのボトルネック分析 | `sonnet` | high | Read / Grep / Glob / Bash | なし |
| `doc-synchronizer` | `docs/` 配下の**既存**ファイル同期 | `haiku` | low | Read / Edit / Write / Grep / Glob | `docs/` のみ |
| `doc-writer` | `output/` 配下に**新規**ドキュメント執筆 | `sonnet` | medium | Read / Edit / Write / Grep / Glob | `output/` のみ |
| `test-writer` | ユニット・E2E テスト作成 | `sonnet` | medium | Read / Edit / Write / Grep / Glob / Bash | テストファイルのみ |

全 agent に `memory: project` と `maxTurns` を設定済み(暴走防止 + セッションをまたいだ学習)。

## agent vs team vs skill の使い分け

| やりたいこと | 選ぶべきもの | 理由 |
| ------------ | ------------ | ---- |
| 複数役割の定常的な共同作業（PRD→設計→実装→検証） | **team** (`.claude/teams/TEAM_*.md`) | ロール分担と承認ゲートが整備済み |
| 決まった手順の実行（PRD 生成、コードレビュー等） | **skill** (`.claude/skills/*/SKILL.md`) | 入出力契約・成果物先が定義済み |
| 単発の専門調査・レビュー（車輪の再発明を防ぐ） | **agent** (`.claude/agents/*.md`) | コンテキストを隔離して軽量実行 |

3 つは競合せず補完する。たとえば `TEAM_PJM` の「レビュアー」が単発で `security-reviewer` agent を呼ぶ、というネスト運用も可能。

## 自動発動と明示呼び出し

- **自動発動**: Claude Code は親セッションのプロンプトと各 agent の `description` を照合して暗黙的に委譲する
- **明示呼び出し**: 親から `Agent` ツールで `subagent_type` を指定すると確実に特定の agent に委譲できる

明示呼び出しの例:

```text
Agent({
  description: "ログイン処理のセキュリティレビュー",
  subagent_type: "security-reviewer",
  prompt: "src/auth/ 配下を OWASP A01-A10 の観点でレビューし、CRITICAL/HIGH 指摘を返してください"
})
```

## 権限最小化の原則

各 agent の `tools` フィールドは**役割に必要な最小セット**に絞る。

- 探索系（`explorer`, `planner`）は書き込みを一切持たない
- 監査系は読取中心。Bash を持つのは計測コマンド実行が必要な `performance-analyst` のみ（`security-reviewer` は完全読み取り専用）
- 書き込み系（`doc-synchronizer`, `doc-writer`, `test-writer`）は対象パスを役割でスコープする
- `doc-synchronizer` / `doc-writer` は `permissionMode: acceptEdits` で権限確認を省く。代わりに frontmatter の
  `hooks.PreToolUse` に `scope-guard.sh docs` / `scope-guard.sh output` を登録し、範囲外への書込を exit 2 で止める。
  `test-writer` も `scope-guard.sh tests` でテストファイル以外への書込を止める。散文の制約だけで書込権限を渡さない

これにより、親セッションが広い権限を持っていても、agent 側では意図せぬファイル変更が起きない。

さらに `SubagentStart` フック(`subagent-audit.sh`)が、起動時に全 agent へハーネス共通の
ガードレール(出力先・シークレット禁止・根拠提示)を `additionalContext` で注入する。

## frontmatter で使える主なキー（公式仕様）

| キー | 用途 |
| ---- | ---- |
| `name` / `description` | 必須。`description` は発動条件を 1〜2 文で |
| `tools` / `disallowedTools` | 権限最小化。`tools` 省略時は継承 |
| `model` | `opus` / `sonnet` / `haiku` / `fable` / 固定 ID / `inherit`（既定） |
| `effort` | `low` / `medium` / `high` / `xhigh` / `max` |
| `permissionMode` | `default` / `acceptEdits` / `auto` / `dontAsk` / `bypassPermissions` / `plan` |
| `maxTurns` | 暴走防止の上限ターン数 |
| `memory` | `user` / `project` / `local` — セッションをまたいだ学習 |
| `skills` | 起動時に全文プリロードする skill 名 |
| `isolation` | `worktree` で一時 git worktree に隔離（既定ブランチから分岐） |
| `hooks` | この agent の実行中だけ有効なフック。書込範囲の強制(`scope-guard.sh`)に使う。project agent は workspace trust 後に有効 |
| `color` | `red` / `blue` / `green` / `yellow` / `purple` / `orange` / `pink` / `cyan` のみ |

> `isolation: worktree` は**既定ブランチから分岐**するため、作業中の差分をレビューさせたい
> 読み取り専用 agent には付けない（別のコードを監査してしまう）。

## モデル選定（project-config.md §13 と整合）

| Tier | エイリアス | 用途 | 例 |
| ---- | ---------- | ---- | -- |
| Critical | `opus` | セキュリティ・アーキ判断 | `security-reviewer` |
| Complex | `sonnet` | 設計・実装・テスト・調査・執筆 | `planner`, `performance-analyst`, `test-writer`, `researcher`, `doc-writer` |
| Operational | `haiku` | 探索・同期・繰り返し作業 | `explorer`, `doc-synchronizer` |

モデルは frontmatter の `model:` キーで指定する。**固定 ID ではなくエイリアスを使う**
（世代交代に追随でき、ID の陳腐化で agent が起動しなくなる事故を防げる）。
未指定時はセッションの既定モデルを継承する。

## 追加方法

新しい agent を増やすには:

1. `.claude/agents/<agent-name>.md` を作成
2. frontmatter に必須キーを記入:
   ```yaml
   ---
   name: <agent-name>
   description: 使用される条件を自然言語で 1〜2 文
   tools: Read, Grep, Glob   # カンマ区切り、権限最小化
   model: sonnet             # Tier に合わせたエイリアス
   effort: medium            # 推論深度
   maxTurns: 30              # 暴走防止
   memory: project           # セッションをまたいだ学習
   color: blue               # UI 識別用（公式 8 色から選ぶ）
   ---
   ```
3. 本文に役割・行動指針・制約を日本語で記述
4. agent 一覧表（本ファイル冒頭）にも 1 行追加

## コンセプト整合（プロジェクトブループリント原則）

- agent は `.claude/` 配下の**汎用テンプレート層**。プロジェクト固有のルールは `docs/` や `project-config.md` に
- agent は **CLAUDE.md 階層(`.claude/rules/*.md` を含む)と git status のスナップショットを既定で継承する**(Claude Code 公式仕様。ビルトインの `Explore` / `Plan` のみ両方をスキップして最小コンテキストで動く)。skill は `skills:` frontmatter で明示指定したもののみ全文プリロードされる — それ以外は `Skill` ツール経由で個別に呼び出せる
- agent は `input/`（人間入力）を書き換えない。成果物は `output/` か、agent ごとに定義されたスコープ内に

## 公式仕様の補足(2026-09 確認)

- **実行形態**: 対話セッションでは fork mode が既定で ON になり、subagent は**バックグラウンドで実行**される。
  結果は完了時に会話へ届く。`background: true` を書くと常時バックグラウンドを強制できる
- **継承するもの / しないもの**: CLAUDE.md 階層・`.claude/rules/`・git status は継承(ビルトインの `Explore` / `Plan` を除く)。
  会話履歴・親の auto memory・skill 本文は継承しない(skill は `skills:` で明示プリロード)
- **ネスト**: 公式には subagent が subagent を最大 5 階層まで spawn できるが、本テンプレートは constitution ④ により
  **agent の `tools` に `Agent` を含めない**(循環と暴走の防止)。並列 fan-out が必要なら team か dynamic workflows を使う
- **description の予算**: カスタム agent の description 合計が 15,000 トークンを超えると起動時に警告が出る。1〜2 文を守る
- **権限ルール**: `Agent(<name>)` で特定 agent を deny でき、`Agent(model:opus)` / `Agent(isolation:worktree)` のように
  パラメータ単位の deny / ask も書ける(`Tool(param:value)` 構文)
- **メモリ**: `memory: project` の学習は `.claude/agent-memory/<name>/` に保存され、**git にコミットされる**(チーム共有が目的)。
  個人限定にしたいときは `local`(`.claude/agent-memory-local/`、gitignore 済み)

## 落とし穴

- agent の `description` が長すぎると発動条件が曖昧になり誤発動を招く。**1〜2 文**に絞る
- tools に不要な権限を与えると「権限最小化」の原則が崩れる。迷ったら**外す**
- agent は親の作業メモリを共有しない。必要な情報は `prompt` に明示的に渡す
- `color` に公式 8 色以外（例: `magenta`）を書くと表示が壊れる
- `model` に存在しない ID を書くと起動に失敗する。エイリアスを使う

詳細は `.claude/pitfalls.md` を参照。
