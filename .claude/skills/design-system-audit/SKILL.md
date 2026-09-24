---
name: design-system-audit
description: >
  デザイントークン(余白・タイポグラフィ・色・サイズ)を比率原則で監査し、不整合を記録して標準化する。
  「デザイントークン」「余白統一」「デザインがバラバラ」「デザイン整合性監査」の依頼で使う。Web / Qt / モバイルに対応。
argument-hint: "<対象ディレクトリ or 指示>"
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git *), Agent, WebSearch, WebFetch
---

# Design System Audit スキル

UIシステム全体のデザイン整合性を定義・検証・保管するためのスキル。  
**デザインシステムエンジニア** / **フロントエンドアーキテクト** 視点で、数値に基づく設計原則を提供する。

---

## このスキルでできること

| 用途 | 説明 |
|------|------|
| **新規設計ガイドライン** | 比率原則に基づくデザイントークン定義と適用ルール |
| **既存画面の整合性監査** | 観点別チェックリストで不整合を検出・記録 |
| **Claude Code指示テンプレート** | 実装時に渡す標準化プロンプトの生成 |

### 他スキルとの連携

| 前工程 | 本スキル | 後工程 |
| ------ | -------- | ------ |
| `/ui-ux-design`（デザインレビュー） | `/design-system-audit` | `/implementing-features`（トークン適用） `/hig-compliance`（UI 一貫性） |

---

## STEP 1: デザイントークンの定義

### 比率体系の選択

まず **ベースサイズ** と **スケール比率** を決める。

| 比率名 | 値 | 向いている用途 |
|--------|-----|----------------|
| **黄金比** | 1.618 | 余裕あるレイアウト・読み物系UI |
| **白銀比** | 1.414 | 日本的バランス・コンパクトUI |
| **Major Third** | 1.250 | 情報密度が高い業務系UI |
| **Perfect Fourth** | 1.333 | 汎用・中間的バランス |

> **推奨**: 業務ツール・車載HUDなど視認性重視の用途は **白銀比(1.414)** または **Major Third(1.250)** が扱いやすい。

### スペーシングトークン（余白・間隔）

ベースを `base = 8px`（または任意の基準値）とし、スケールを展開する。

```
space-1 = base × 0.5   =  4px   （最小余白・アイコン内側など）
space-2 = base × 1     =  8px   （関連要素間）
space-3 = base × 1.5   = 12px   （グループ内余白）
space-4 = base × 2     = 16px   （セクション内標準余白）
space-5 = base × 3     = 24px   （セクション間）
space-6 = base × 4     = 32px   （ブロック間・大余白）
space-7 = base × 6     = 48px   （画面端マージン等）
space-8 = base × 8     = 64px   （大見出し前後等）
```

比率スケール版（黄金比ベース・base=8px）：
```
space-1 =  5px  (8 ÷ 1.618)
space-2 =  8px  (base)
space-3 = 13px  (8 × 1.618)
space-4 = 21px  (13 × 1.618)
space-5 = 34px  (21 × 1.618)
space-6 = 55px  (34 × 1.618)
```

### タイポグラフィトークン

ベースフォントサイズを `base = 14px` または `16px` とする。

```
text-xs   = base ÷ ratio²
text-sm   = base ÷ ratio
text-md   = base             （本文）
text-lg   = base × ratio     （小見出し）
text-xl   = base × ratio²    （見出し）
text-2xl  = base × ratio³    （大見出し・画面タイトル）
text-3xl  = base × ratio⁴    （ヒーロー・数字強調）
```

白銀比(1.414)、base=14px の場合の例：
```
text-xs  =  7px
text-sm  = 10px
text-md  = 14px
text-lg  = 20px
text-xl  = 28px
text-2xl = 40px
text-3xl = 56px
```

### コンポーネントサイズトークン

```
button-height-sm  = space-6         (32px相当)
button-height-md  = space-7         (48px相当)
button-height-lg  = space-7         (48px相当)
button-padding-x  = space-4 〜 5    (16〜24px)

input-height      = button-height-md と揃える
icon-size-sm      = 16px
icon-size-md      = 24px
icon-size-lg      = 32px

border-radius-sm  = 4px
border-radius-md  = 8px
border-radius-lg  = 16px
border-radius-full= 9999px
```

### タイトル・ヘッダー位置の統一ルール

```
画面タイトル
  - フォントサイズ: text-2xl 固定
  - 上余白（画面端〜タイトル）: space-6 または space-7
  - 下余白（タイトル〜コンテンツ）: space-5
  - 水平位置: left-align (業務系) / center (ウィザード・モーダル)

セクション見出し
  - フォントサイズ: text-xl
  - 上余白: space-6
  - 下余白: space-4

サブ見出し
  - フォントサイズ: text-lg
  - 上余白: space-5
  - 下余白: space-3
```

---

## STEP 2: 整合性監査チェックリスト

既存画面を評価する際は以下の観点で確認する。  
→ 詳細チェックリストは [references/audit-checklist.md](references/audit-checklist.md) を参照。

### 監査カテゴリ一覧

| # | カテゴリ | 主な確認内容 |
|---|----------|--------------|
| A | **スペーシング** | 余白がトークン値に沿っているか |
| B | **タイポグラフィ** | フォントサイズ・ウェイト・行間の一貫性 |
| C | **コンポーネント** | ボタン・入力・アイコンの高さ・形状の統一 |
| D | **タイトル・見出し位置** | 画面ごとのタイトル上下位置・水平位置の統一 |
| E | **カラー** | カラートークン外の色が使われていないか |
| F | **グリッド・整列** | 要素の左端・右端の揃い |
| G | **比率の遵守** | スケールから外れた例外値がないか |
| H | **インタラクション** | ホバー・フォーカス・無効状態の統一 |

### 不整合の記録フォーマット

```
[監査記録]
画面名: ___________
日付: ___________

| カテゴリ | 場所 | 問題内容 | 現在値 | 正しい値 | 対応優先度 |
|----------|------|----------|--------|----------|------------|
| A | ボタン下余白 | space-3(12px)になっている | 12px | 16px(space-4) | 中 |
| D | 画面タイトル上余白 | 画面によって20〜40pxでバラバラ | 可変 | 32px(space-6)固定 | 高 |
```

---

## STEP 3: Claude Code 指示テンプレート

### 新規コンポーネント実装時

雛形は [references/templates.md](references/templates.md) の「新規コンポーネント実装時」にある。必要になったときに読み、そのままコピーして埋める。

### 既存画面の修正指示時

```
以下の整合性問題を修正してください。

【修正対象: スペーシング】
- [箇所]: [現在値]px → [正しい値]px (token: space-N)

【修正対象: タイトル位置】
- 全画面のタイトル上余白を 32px に統一する
- ファイル対象: [ファイルパス]

【確認事項】
- 修正後、他の要素とのバランスが崩れていないか確認する
- 修正は最小限にとどめ、関係のない箇所は変更しない
```

---

## STEP 4: デザインシステム保管ドキュメントの生成

プロジェクトの `design-system.md` または `DESIGN_TOKENS.md` に以下の構造で保管する。

雛形は [references/templates.md](references/templates.md) の「STEP 4: デザインシステム保管ドキュメントの生成」にある。必要になったときに読み、そのままコピーして埋める。

---

## 出力契約

| 成果物 | 必須 | 制約 |
| ------ | ---- | ---- |
| デザインシステム保管ドキュメント | ✅ | STEP 4の構造(基本原則/デザイントークン/画面ごとのルール/監査ログ)を満たす |
| 不整合の記録(監査時) | 条件付き | STEP 2で問題を検出した場合のみ、カテゴリ別記録フォーマットで出力 |

**PASS条件**: カテゴリA〜HすべてがSTEP 2でチェック済み / 検出した不整合は現在値・正しい値・対応優先度が記録フォーマットに揃っている / スケール比率からの逸脱がある場合は理由が明記されている。

---

## 参考ファイル

詳細な監査チェックリストは → [references/audit-checklist.md](references/audit-checklist.md)  
比率の数値計算参考は → [references/ratio-reference.md](references/ratio-reference.md)

## 関連参照

必要になったときだけ Read する:

- `.claude/quality-gates.md` — ゲート通過基準と定量計測表を確認するとき
- `.claude/pitfalls.md` — 既知の失敗パターンに当たりそうなとき(該当する節だけ読む)
