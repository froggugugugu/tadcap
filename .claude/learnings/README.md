# `.claude/learnings/` — 成功パターン蓄積(`pitfalls.md` の対概念)

`pitfalls.md` が**失敗パターン集**なのに対し、`learnings/` は**成功パターン集**。
ECC(everything-claude-code)の instinct 機構にインスパイアされた「継続学習層」。

## なぜこれが必要か

`pitfalls.md` だけでは「何をしないか」しか伝わらない。
「何が**うまくいったか**」を残さないと、AI は過剰に保守的になり、検証済みの判断にも毎回確認を取りに来る。

成功パターンを confidence スコア付きで蓄積し、
将来のセッションが同じ判断点に来たときに**自動で参照**できるようにする。

## ファイル構造

```text
.claude/learnings/
├── README.md           # 本ファイル
├── TEMPLATE.md         # 新しい learning のテンプレ
└── L<NNNN>-<topic>.md  # 個別の learning(連番管理)
```

各 learning は次のフロントマター付き Markdown:

```yaml
---
id: L0001
topic: <短い主題>
confidence: 0.85         # 0.0-1.0(再現性の高さ)
sample_size: 3           # 観察された事例数
first_seen: 2026-04-01
last_confirmed: 2026-04-23
status: active           # active | deprecated | superseded
related: [L0002, P12]    # 他 learning(L)・pitfalls(P)への参照
---
```

## 運用ルール

### 追加するタイミング(when)

- ユーザーから「**いいね、その方針で**」と肯定的フィードバックを受けたとき
- 同じ判断パターンが **3 回以上**(別セッション含む)再現したとき
- 失敗パターン(pitfalls)を回避できた具体的手段が判明したとき

### 追加しないとき(when not)

- 当たり前すぎる事項(コードから読める)
- 1 回しか観察していない(sample_size=1)— 偶然の可能性が高い
- ユーザー固有の好み(`feedback` メモリに書くべき)

### 信頼度更新(confidence update)

- 適用して**成功** → confidence を +0.05(上限 0.95)
- 適用して**失敗** → confidence を -0.20、`status` を `deprecated` に近づける
- 6 ヶ月以上 `last_confirmed` が更新されなければ `status: stale` に下げる

## CLAUDE.md / pitfalls との役割分担

| 種類 | 何を書く | 更新頻度 | 場所 | git |
| ---- | -------- | -------- | ---- | --- |
| AGENTS.md | ツール共通の横断ルール(must) | 低 | `AGENTS.md`(ルート) | ✅ コミット |
| CLAUDE.md | Claude Code 固有の横断ルール(must) | 低 | `.claude/CLAUDE.md` | ✅ コミット |
| pitfalls.md | 失敗パターン(避けるべき) | 中 | `.claude/pitfalls.md` | ✅ コミット |
| learnings/ | 成功パターン(再利用すべき) | 高 | `.claude/learnings/L*.md` | ✅ コミット |
| auto memory | ユーザー個人の文脈 | 高 | `~/.claude/projects/<proj>/memory/` | ❌ **コミットされない** |

## auto memory との使い分け

Claude Code には**自動メモリ**が組み込まれている(既定で有効)。`learnings/` はこれを
置き換えるものではなく、**補完**する。決定的な違いは git に入るかどうか:

- **`learnings/` = チームの資産**。リポジトリにコミットされ、レビューを経て共有される。
  「このプロジェクトではこの手が有効だった」を**全員**に効かせたいときはこちら
- **auto memory = 個人の作業文脈**。`~/.claude/` 配下に保存され、コミットされない。
  Claude が自律的に書き、他のメンバーには一切共有されない

auto memory が保存する 4 種別(公式):

| type | 内容 |
| ---- | ---- |
| `user` | 役割・専門性・作業の好み |
| `feedback` | ユーザーからの指摘と、承認された進め方 |
| `project` | 進行中の作業・締切・コードや git 履歴から導けない決定事項 |
| `reference` | 外部リソースへのポインタ(Issue トラッカー、ダッシュボード等) |

コードから導ける事項(アーキテクチャ・ファイルパス・過去の修正)と、CLAUDE.md に
既に書いてある事項は auto memory に保存されない。

### どちらに書くかの判断

| 内容 | 書く場所 |
| ---- | -------- |
| 再現性が確認された技術的判断(sample_size ≥ 3) | `learnings/` |
| チームで合意した進め方 | `learnings/` または `CLAUDE.md` |
| 「このユーザーは TypeScript の型を厳密に書く」 | auto memory (`user`) |
| 「この人はコミット前に必ずテストを求める」 | auto memory (`feedback`) |
| 「Q3 までにこの機能を出す」 | auto memory (`project`) |

### 設定

```json
// .claude/settings.json（プロジェクト単位で無効化する場合）
{ "autoMemoryEnabled": false }

// 保存先を変える場合（絶対パスか ~/ 始まり）
{ "autoMemoryDirectory": "~/my-memory-dir" }
```

CI では実行の再現性のため `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` を設定する
(同梱の `claude-skills-ci.yml.template` は設定済み)。

> **注意**: auto memory はセッションをまたいで蓄積されるが、
> **書かれた時点の事実のスナップショット**でしかない。ファイル名・関数名・フラグに
> 言及するメモは、参照する前に現物を確認すること。

## 自動参照

- 各 skill の冒頭で「関連する learning があれば参照」と指示する(skill 側で `.claude/learnings/L0001-<topic>.md` 等を必要に応じて読む)
- セッション開始時にすべて読む必要はない(肥大化を避ける)
- `confidence >= 0.8` のもののみを「強い参考」として扱う

## 関連

- `.claude/pitfalls.md` — 失敗パターン
- `~/.claude/projects/<proj>/memory/` — Claude Code Auto Memory
- `AGENTS.md` — ツール共通の横断ルール
- `.claude/CLAUDE.md` — Claude Code 固有の横断ルール
