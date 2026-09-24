---
paths:
  - "docs/**/*.md"
  - "output/**/*.md"
  - "input/**/*.md"
  - "project-config.md"
---
# ドキュメント管理方針

> **path-specific rule**: docs/ · output/ · input/ · project-config.md に触れたときだけ自動 load される

> CLAUDE.md 肥大化防止のため切り出したルール。上の frontmatter に従って自動 load され、必要な skill からは `@import` でも明示参照できる。

## 人間が管理するファイル

- `project-config.md` — 技術選定・品質基準・ポリシー等、人間が決定すべきパラメータ
- `constitution.md`(repo ルート) — 不変原則 7 つ
- `input/requirements/` — 要求メモ(AI は読み取り専用)

## AI が管理するファイル

以下のファイルは AI が生成・メンテナンスする:

- `docs/project.md` — ルーティング・ストア一覧・コマンド・技術スタック
- `docs/architecture.md` — ディレクトリ構成・テスト一覧
- `docs/data-model.md` — スキーマ定義・バリデーションルール
- `docs/development-patterns.md` — コード規約・落とし穴・デザインシステム
- `output/`、`testreport/` 配下全般

## project-config.md の AI メンテナンス

各スキルは設計・実装の進行に伴い、以下のセクションを更新する:

| 更新トリガー | 対象セクション |
| ------------ | -------------- |
| 新しい落とし穴・アンチパターンの発見 | §11(既知の落とし穴) |
| 依存パッケージの追加・バージョン変更 | §2(技術スタック) |
| コマンドの追加・変更 | §3(コマンド) |

`project-config.md` と `docs/` の整合性を常に保つこと。

## project-config.md 更新の競合防止

| セクション | 一次更新責務 | ルール |
| ---------- | ------------ | ------ |
| §2(技術スタック) | `/implementing-features` | 他スキルは発見事項を報告し、一次更新者が集約 |
| §3(コマンド) | `/implementing-features` | 同上 |
| §4(アーキテクチャ) | `/implementing-features` | `/architecture` は `output/design/` に出力、採用後に反映 |
| §11(既知の落とし穴) | 全スキル(追記可) | 追記前に既存エントリの重複確認必須 |

## docs/ 更新の競合防止

| ファイル | 一次更新責務 | ルール |
| -------- | ------------ | ------ |
| `docs/project.md` | `/implementing-features` | ルーティング・ストア・コマンド変更時 |
| `docs/architecture.md` | `/implementing-features` | ディレクトリ構成・テスト配置変更時。`/architecture` は `output/design/` 経由で採用後反映 |
| `docs/data-model.md` | `/implementing-features` | スキーマ追加・変更時 |
| `docs/development-patterns.md` | `/implementing-features` | コード規約・落とし穴・デザインシステム変更時。他スキル(`/performance`, `/refactoring` 等)は発見事項を PL or 会話内で報告し、一次更新者が集約 |

チームコンテキストでは、PL が `project-config.md` および `docs/` の更新を一元管理する。メンバーは発見事項を PL にメッセージで報告し、PL が更新する。§11 への追記のみメンバーが直接実施可能(重複チェック必須)。
