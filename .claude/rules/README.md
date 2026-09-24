# .claude/rules/ — パス別 / 言語別ルールの拡張ポイント

`.claude/rules/` は **Claude Code 公式のルール置き場**。ここに置いた `.md` は
再帰的に探索され、`CLAUDE.md` と同じ優先度でコンテキストに載る。

## 2 種類のルール

| 種類 | frontmatter | load タイミング | 使い分け |
| ---- | ----------- | --------------- | -------- |
| **always-on** | なし | 全セッションの起動時 | 常に効かせたい短いルール(例: コミット規約) |
| **path-specific** | `paths:` あり | 該当パスのファイルを Claude が触ったときだけ | 言語別・レイヤー別の詳細ルール |

> **重要**: `paths:` を書かないルールは**全セッションで常時 load される**。
> CLAUDE.md から切り出しただけでは軽量化にならないので、
> 汎用でないルールには必ず `paths:` を付けること。

### path-specific ルールの書き方

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "src/**/*.{ts,tsx}"
---

# API 開発ルール

- すべてのエンドポイントで入力バリデーションを行う
- エラーレスポンスは標準フォーマットに従う
```

`paths` は glob。ブレース展開(`{ts,tsx}`)も使える。

| パターン | マッチ対象 |
| -------- | ---------- |
| `**/*.ts` | 全ディレクトリの TypeScript ファイル |
| `src/**/*` | `src/` 配下すべて |
| `*.md` | プロジェクトルート直下の Markdown |
| `src/components/*.tsx` | 特定ディレクトリのコンポーネント |

## 同梱ルールの構成

| ファイル | 種類 | スコープ |
| -------- | ---- | -------- |
| `git-conventions.md` | always-on | 全セッション(コミットは常に発生しうる) |
| `document-management.md` | path-specific | `docs/**` `output/**` `input/**` `project-config.md` |
| `workflow-advanced.md` | path-specific | `src/**` `app/**` `lib/**` `packages/**` `tests/**` |
| `harness-authoring.md` | path-specific | `.claude/**` `CLAUDE.md` `AGENTS.md`(ハーネス自身を編集するとき) |
| `language-typescript.md.example` | path-specific(サンプル) | `**/*.{ts,tsx}` |
| `language-python.md.example` | path-specific(サンプル) | `**/*.py` |
| `path-backend.md.example` | path-specific(サンプル) | `backend/**/*` |

## サンプルの有効化(2 ステップ)

```bash
# 1. .example を外してコピー
cp .claude/rules/language-typescript.md.example .claude/rules/language-typescript.md

# 2. paths: と本文をプロジェクトに合わせて編集
vi .claude/rules/language-typescript.md
```

`CLAUDE.md` への追記は不要 — `paths:` にマッチしたときに自動で load される。

## 命名規則

| プレフィックス | 用途 | 例 |
| -------------- | ---- | -- |
| `language-*.md` | 言語 / フレームワーク別 | `language-typescript.md`, `language-python.md`, `language-swift.md` |
| `path-*.md` | 特定パス配下のみに適用するルール | `path-backend.md`, `path-frontend.md`, `path-mobile.md` |
| `rule-*.md` | 特定の技術トピックに対するルール | `rule-accessibility.md`, `rule-performance-budget.md` |

サブディレクトリ(`frontend/` `backend/` 等)も再帰的に探索される。
シンボリックリンクも解決されるため、複数プロジェクトで共通ルールを共有できる:

```bash
ln -s ~/shared-claude-rules .claude/rules/shared
```

## rules と skill の使い分け

| | `.claude/rules/` | `.claude/skills/` |
| --- | --- | --- |
| load 契機 | 起動時 or パス一致時(受動) | 呼び出し時 or 説明文一致時(能動) |
| 向くもの | 「常に守るべき制約」 | 「特定作業の手順」 |
| コスト | 常時 or 頻繁にコンテキストを消費 | 起動時のみ |

タスク固有の手順は rules ではなく skill に置く(公式ガイダンス)。

## 大規模リポジトリ / monorepo での使い方

| 課題 | 公式の解 |
| ---- | -------- |
| パッケージ固有の手順が他パッケージ作業時にも候補に載る | **per-directory skill**: `packages/<name>/.claude/skills/` に置く。そのディレクトリを触るときだけ候補になり、名前が衝突すると `/packages/<name>:skill` に自動で名前空間化される |
| 規約をどこに書くか | ディレクトリ所有者が保守する規約は `packages/<name>/CLAUDE.md`(そのディレクトリのファイルを読んだときに load)。散在するパスに同じ規約を効かせるなら本ディレクトリの path-scoped rule |
| 他チームの CLAUDE.md が読み込まれる | `.claude/settings.local.json` の `claudeMdExcludes`(絶対パスの glob) |
| worktree が重い | `worktree.sparsePaths` で必要なディレクトリだけ checkout |
| 生成物・vendored コードを読んでしまう | `permissions.deny` に `Read(./dist/**)` 等を追加して探索コストを下げる |
| skill が増えて description が切り詰められる | `/doctor` で一覧コストを確認し、不要な skill は `skillOverrides` で非表示、`skillListingBudgetFraction` で予算を調整 |

ルートの `CLAUDE.md` は横断ルールのみに保ち、パッケージ固有の情報を持ち込まない(pitfalls #1)。

## コンセプト整合

- `.claude/rules/` は汎用テンプレート層の一部(プロジェクト固有値は `project-config.md` や `docs/` に)
- ルールは 1 ファイル 50〜100 行を目安に(CLAUDE.md と同じ理由で肥大化を避ける)
- example は初期状態で**無効**(`.example` 拡張子がついている限り読まれない)
- ルールが増えすぎるとトークンコストが膨らむ。always-on は最小限、詳細は `paths:` で絞る
- 詳細は `.claude/pitfalls.md` の #1, #4 参照
