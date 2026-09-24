---
name: security-scan
description: >
  依存 CVE・OWASP Top 10・シークレット混入・セキュリティヘッダーを監査し、output/reports/security/ に重大度別で報告する。
  「セキュリティスキャン」「脆弱性チェック」「npm audit」「シークレット検出」の依頼や、リリース前に使う。
argument-hint: "<対象範囲 or 指示>"
allowed-tools: Read, Glob, Grep, Bash(git *), Edit(output/**), Edit(testreport/**), WebSearch, WebFetch, mcp__context7__resolve-library-id, mcp__context7__query-docs, mcp__plugin_context7_context7__resolve-library-id, mcp__plugin_context7_context7__query-docs
disallowed-tools: Edit, NotebookEdit
effort: high
context: fork
background: false
---

# Security Scan

セキュリティスキャンツールを実行し、構造化された脆弱性レポートを出力するスキル。
OWASP ZAP（DAST）、依存パッケージ脆弱性スキャン、静的解析（SAST）、シークレット検出などを統合的に実施する。
`project-config.md` セクション10（セキュリティポリシー）を参照し、プロジェクト固有のポリシーに準拠する。

**免責事項**: 本スキルによるスキャンは自動化ツールに基づく参考情報であり、セキュリティ専門家によるペネトレーションテストの代替ではない。重要なシステムでは必ず専門家のレビューを受けること。

## 前提条件

`docs/` ファイルへの依存なし。`project-config.md` §10（セキュリティポリシー）を参照する。未記入の場合は OWASP Top 10 をデフォルト基準として使用する。

## 基本姿勢

- **ソースコードは一切変更しない**（読み取り専用）
- スキャン結果は再現可能であること（ツール・バージョン・設定を明記）
- 検出された脆弱性は重要度を明示する（CRITICAL / HIGH / MEDIUM / LOW / INFO）
- 偽陽性（False Positive）の可能性がある検出には明示的にマークする
- 修正の優先順位を明確にする

## 使い方

```text
/security-scan <対象範囲 or スキャン指示>
```

引数は省略可能。省略した場合はプロジェクト全体をスキャン対象とする。
ファイルパスやカテゴリを指定した場合はその範囲に限定してスキャンする。

### 例

```text
/security-scan プロジェクト全体のセキュリティスキャン
/security-scan src/features/assignment/
/security-scan 依存パッケージのみ
```

### 出力先

- デフォルト: 会話内でレポートを提示
- ファイル出力: `output/reports/security/SECURITY_<日時>.md`（`output/`ディレクトリが存在する場合）
- ツール出力: `testreport/security/`

### 他スキルとの連携

| 前工程 | 本スキル | 後工程 |
| ------ | -------- | ------ |
| `/implementing-features` | `/security-scan` | （最終工程） |

## スキャンカテゴリ

5カテゴリ(SCA / SAST / DAST / シークレット検出 / セキュリティヘッダー分析)を実施する。
各カテゴリの実行コマンド・チェック項目・判定基準は [references/scan-categories.md](references/scan-categories.md) を参照。

1. **依存パッケージ脆弱性スキャン(SCA)** — 既知の脆弱性(CVE)を持つ依存パッケージを検出
2. **静的アプリケーションセキュリティテスト(SAST)** — OWASP Top 10ベースでソースコードを静的検出
3. **動的アプリケーションセキュリティテスト(DAST)** — OWASP ZAPで稼働中アプリケーションをスキャン
4. **シークレット検出** — gitleaks/trufflehogでソースコード・Git履歴の機密情報を検出
5. **セキュリティヘッダー・設定分析** — CSP等の必須HTTPヘッダーを検証

## スキャンワークフロー

1. **スコープ確認** — スキャン対象（全体 / 特定カテゴリ / 特定ファイル）を確認
2. **環境確認** — 必要なツールのインストール状況を確認
3. **ツール実行** — カテゴリ別にスキャンツールを実行
4. **結果分析** — スキャン結果を解析し、偽陽性を識別
5. **🚏 レポートゲート** — 構造化されたレポートを出力

### ツール可用性への対応

スキャンツールがインストールされていない場合:

1. インストール手順を提示する（ユーザーの判断を待つ）
2. ツールなしで実行可能な範囲（Grepベースの検索、`npm audit`）で簡易スキャンを実施する
3. 簡易スキャンの限界を明記する

## 出力契約

### セクション定義

| セクション | 必須 | 制約 |
| ---------- | ---- | ---- |
| 免責事項 | ✅ | 定型文。変更不可 |
| スキャン概要 | ✅ | 対象範囲・使用ツール・スキャン日時を必ず含む |
| エグゼクティブサマリー | ✅ | 検出件数の重要度別集計。非技術者にも理解可能な概要 |
| 検出事項 | ✅ | CRITICAL→HIGH→MEDIUM→LOW→INFO の順。0件でも見出しは残す |
| 依存パッケージサマリー | 条件付き | SCAを実施した場合 |
| DAST結果サマリー | 条件付き | DASTを実施した場合 |
| 推奨アクション | ✅ | 優先度順に番号付き。修正難易度（低/中/高）を付記 |
| 次回スキャン推奨事項 | ✅ | 追加すべきツール・スキャン範囲の拡大提案 |

### 重要度定義

| レベル | 判定基準 | 対応期限の目安 | CVSS相当 |
| ------ | -------- | -------------- | -------- |
| **CRITICAL** | 即座に悪用可能な脆弱性。認証バイパス、RCE、機密情報の公開露出 | 即時対応 | 9.0〜10.0 |
| **HIGH** | 悪用にはある程度の条件が必要だが、深刻な影響を与えうる脆弱性 | 1週間以内 | 7.0〜8.9 |
| **MEDIUM** | 限定的な条件下で悪用可能、または影響が中程度の脆弱性 | 次回リリースまで | 4.0〜6.9 |
| **LOW** | 悪用が困難、または影響が軽微な脆弱性 | 計画的に対応 | 0.1〜3.9 |
| **INFO** | セキュリティ上のベストプラクティスからの乖離。直接的な脆弱性ではない | 任意 | - |

### 検出事項の記述フォーマット

```text
- [ ] **[重要度]** `検出場所` 脆弱性の概要。
  **CVE/CWE**: 該当する場合に記載。
  **影響**: 悪用された場合の具体的な影響。
  **修正案**: 具体的な修正方法。
  **修正難易度**: 低 / 中 / 高。
  **偽陽性の可能性**: あり / なし（ありの場合は根拠を記載）。
```

### 語彙制約

| 用語 | 定義 |
| ---- | ---- |
| SCA | Software Composition Analysis。依存パッケージの脆弱性スキャン |
| SAST | Static Application Security Testing。ソースコードの静的解析 |
| DAST | Dynamic Application Security Testing。稼働アプリケーションへの動的スキャン |
| CVE | Common Vulnerabilities and Exposures。公開された脆弱性の識別番号 |
| CWE | Common Weakness Enumeration。ソフトウェアの弱点分類 |
| CVSS | Common Vulnerability Scoring System。脆弱性の重要度スコア（0.0〜10.0） |
| 偽陽性 | False Positive。実際には脆弱性ではない検出結果 |
| パッシブスキャン | 通常のリクエスト/レスポンスを観察するのみ（侵入的でない） |
| アクティブスキャン | 意図的に攻撃パターンを送信して脆弱性を検証する |

### 構造制約

- 検出事項にはCVE/CWE番号を可能な限り付記する
- 修正案は具体的なコード変更またはコマンドで記述する
- 偽陽性の判定根拠を明記する
- スキャンに使用したツールのバージョンを必ず記録する

**PASS条件**: 全検出事項に CVE/CWE(該当時)・影響・修正案・修正難易度・偽陽性判定が揃っている / CRITICAL/HIGH に推奨アクションが番号付きで対応している / スキャンツールのバージョンが記録されている。

## レポートフォーマット

雛形は [references/report-template.md](references/report-template.md) にある。必要になったときに読み、そのままコピーして埋める。

## ツール導入ガイド

最小構成: `npm audit`（追加インストール不要）。
推奨構成: gitleaks + OWASP ZAP + semgrep。

```bash
# gitleaks（シークレット検出）
# https://github.com/gitleaks/gitleaks#installing
brew install gitleaks  # macOS
# または GitHub Releases からバイナリをダウンロード

# OWASP ZAP（DAST）
# Docker 経由で利用（インストール不要）
# docker run --rm ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t <URL>

# semgrep（SAST）
# https://semgrep.dev/docs/getting-started/
pip install semgrep
# または brew install semgrep
```

## 禁止事項

- ソースコードの変更（テストファイルも含む）
- 本番環境へのアクティブスキャンの実行（開発/ステージング環境のみ）
- スキャンツールの無断インストール（ユーザーの確認を取る）
- 脆弱性情報の過小評価（不明な場合は高めに評価する）
- 検出された機密情報のレポートへの転記（マスクする）
- 「問題なし」の断定（「スキャン範囲内で検出なし」と表現する）

## 関連参照

必要になったときだけ Read する:

- `.claude/guardrails.md` — フック・deny ルールの挙動を確認するとき
- `.claude/permissions-guide.md` — 権限モードと allow / ask / deny の設計を確認するとき
- `.claude/quality-gates.md` — ゲート通過基準と定量計測表を確認するとき
- `.claude/pitfalls.md` — 既知の失敗パターンに当たりそうなとき(該当する節だけ読む)
