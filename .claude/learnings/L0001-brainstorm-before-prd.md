---
id: L0001
topic: 要求メモが曖昧なときは /brainstorm を /prd の前に必ず挟む
confidence: 0.85
sample_size: 4
first_seen: 2026-04-15
last_confirmed: 2026-04-26
status: active
related: [P19]
---

# L0001 — 要求メモが曖昧なときは /brainstorm を /prd の前に必ず挟む

## 文脈(context)

ユーザーが `input/requirements/REQ_*.md` に短い要求メモ(数行 〜 半ページ)を置いて
「PRD を作って」と依頼するケース。メモには「成功条件」「やらないこと」「ターゲットユーザー」が
明示されていないことが多い。AI がそのまま `/prd` を起動すると、推測で機能が膨らんだ PRD が
出来上がり、後段の設計フェーズで戻り作業が発生する。

## 観察された成功パターン(observation)

- **input**: 半ページ未満の要求メモ、または抽象的な機能希望の一文
- **decision**: `/prd` ではなく `/brainstorm <メモ>` を先に起動して、
  Socratic 質問で「動機 / ユーザー / 成功条件 / やらない選択肢 / 撤退条件 / 制約 / 代替案」を
  3 ラウンド以内に詰める。`output/brainstorm/BRAINSTORM_<topic>_<date>.md` を起点に PRD へ。
- **outcome**: PRD 作成時間は微増(+10-15 分)するが、設計レビュー戻り回数が
  平均 3 回 → 0-1 回に激減。Phase 2(設計ゲート)通過率が体感で 2 倍以上。

## なぜこれが効くのか(why)

PRD は「要件の集合」として記述されるが、要件を抽出するには**前提の合意**が先行しなければ
ならない。`/brainstorm` は意図的に「コードもドキュメントも書かない」制約で、AI が
推測で機能を膨らませる誘惑を断ち切り、ユーザー側の言語化を促す。これは spec-kit の
`/clarify` フェーズ、BMAD の analyst persona、superpowers の brainstorming skill が
すべて採用している共通パターンであり、複数 OSS で再現確認済み。

## 適用条件(applicability)

**参照すべき(must)**:

- 要求メモが半ページ未満
- メモ内に「やらない」項目が無い
- ステークホルダー / 成功指標が不明
- 大規模機能追加(複数 skill にまたがる作業)の起点

**参照すべきでない(must not)**:

- バグ修正(`/implementing-features` を直接起動)
- リファクタリング(`/refactoring` を直接起動)
- 単純な UI 微調整(`/ui-ux-design` を直接起動)
- 要求メモが既に PRD レベルに精緻化されている(`/prd` の手戻りリスクが低い)

**関連 skill / phase**:

- 前段: なし(PRD パイプラインの最上流)
- 後段: `/prd` → `/architecture` → `/plan` → `/implementing-features`
- 並行: 設計判断が出始めたら `/adr` で記録

## 反証 / 失敗事例(counter-examples)

- 1 件: 要件メモが 3 ページの完全仕様書だったケースで `/brainstorm` を挟むと
  「すでに合意済み事項を蒸し返した」とユーザーから指摘。→ 適用条件「メモが半ページ未満」を
  追加して回避。

## 改訂履歴

| 日付 | 変更 | confidence 変化 |
| ---- | ---- | --------------- |
| 2026-04-15 | 初登録(2 事例観察) | — (0.50) |
| 2026-04-22 | 3 事例目で再現、PRD 戻り削減を確認 | 0.50 → 0.65 |
| 2026-04-26 | 4 事例目、本テンプレートに `/brainstorm` skill として実装 | 0.65 → 0.85 |
