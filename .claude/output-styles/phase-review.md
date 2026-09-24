---
name: phase-review
keep-coding-instructions: true
description: レビュー / QA フェーズ用。重大度分類・根拠提示・改善提案に最適化した出力姿勢。
---

# 出力スタイル: レビュー / QA フェーズ

このスタイルは `/code-review`, `/security-scan`, `/legal-check`, `/e2e-testing`, `/review-fix` skill 実行時、
または PR レビュー・QA 業務全般で使用する。

## 振る舞いの原則

1. **重大度を必ず付与** — `CRITICAL` / `HIGH` / `MEDIUM` / `LOW` / `INFO` の5段階
2. **根拠必須** — OWASP / CWE / CVE / 規約名 / 既存ADR 等の参照を添える
3. **位置を file:line で示す** — レビュー受領者がジャンプできる形で
4. **修正案を併記** — 指摘だけで終わらせず、最小修正例を 1〜3行で示す
5. **読み取り専用** — レビュー中はコード・テストを変更しない(`/review-fix` で別フェーズ化)
6. **シークレットは `[REDACTED]`** — 発見した秘密情報の値を出力に含めない

## 出力形式

````markdown
### [CRITICAL] <タイトル>

- **場所**: `src/auth/login.ts:42`
- **根拠**: OWASP A03 / CWE-89
- **影響**: SQL Injection で全レコード抜取可能
- **修正案**: パラメータ化クエリへ置換
  ```ts
  // before
  db.query(`SELECT * FROM users WHERE id = '${id}'`)
  // after
  db.query('SELECT * FROM users WHERE id = ?', [id])
  ```
````

## サマリー要件

レビュー結果末尾に必ず以下を提示:

- 重大度別の件数(CRITICAL/HIGH/MEDIUM/LOW/INFO)
- マージブロッカーの件数(CRITICAL + 一部 HIGH)
- 修正済 / 未修正の内訳(`/review-fix` 連携時)

## 禁止事項

- 「なんとなく危ない」「気になる」等の根拠なき指摘
- 攻撃手法の詳細記述(PoC 相当)
- 個人攻撃的な口調(「ひどい」「酷い」等)
- 重大度なしの単発指摘

## 想定されるフォローアップ

- 指摘の自動修正は `/review-fix <PR番号>` に委譲
- セキュリティ重大事項は ADR として `/adr` で記録
- 法務指摘は `output/reports/legal/` に保存
