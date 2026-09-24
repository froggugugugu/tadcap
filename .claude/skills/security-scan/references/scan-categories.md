# スキャンカテゴリ詳細

## 目次

- 1. 依存パッケージ脆弱性スキャン(SCA)
- 2. 静的アプリケーションセキュリティテスト(SAST)
- 3. 動的アプリケーションセキュリティテスト(DAST)
- 4. シークレット検出
- 5. セキュリティヘッダー・設定分析

`security-scan` が実施する5カテゴリの実行コマンド・チェック項目・判定基準。

## 1. 依存パッケージ脆弱性スキャン(SCA)

既知の脆弱性(CVE)を持つ依存パッケージを検出する。

```bash
# npm 標準
npm audit --json > testreport/security/npm-audit.json
npm audit

# より詳細な分析(プロジェクトにインストールされている場合)
# npx snyk test
# trivy fs --scanners vuln .
```

### チェック項目

- [ ] 直接依存(dependencies)の脆弱性を確認した
- [ ] 間接依存(devDependencies含む)の脆弱性を確認した
- [ ] CRITICAL/HIGH の脆弱性にパッチ適用可能か確認した
- [ ] 脆弱性のあるパッケージが本番ビルドに含まれるか確認した

### 判定基準

| 条件 | 判定 |
| ---- | ---- |
| CRITICAL/HIGH が0件 | PASS |
| CRITICAL/HIGH があるが本番ビルドに含まれない(devDependencies のみ) | WARNING |
| CRITICAL/HIGH が本番ビルドに含まれる | FAIL |

## 2. 静的アプリケーションセキュリティテスト(SAST)

ソースコード内のセキュリティ上の問題を静的に検出する。

### 検出対象(OWASP Top 10 ベース)

| 脆弱性カテゴリ | CWE | OWASP Top 10 |
| -------------- | --- | ------------ |
| クロスサイトスクリプティング(XSS) | CWE-79 | A03:2021 |
| インジェクション | CWE-89, CWE-78 | A03:2021 |
| 機密情報の露出(ハードコードされた認証情報) | CWE-798 | A02:2021 |
| 安全でないコード実行(動的コード評価) | CWE-95 | A08:2021 |
| 入力バリデーション不備 | CWE-20 | A03:2021 |
| 暗号化の不備 | CWE-327 | A02:2021 |

### Grepベースの簡易検出

ツールが未導入の場合、OWASP CWEパターンに該当するコードをソースコード内で検索する:

- **CWE-79 (XSS)**: 安全でないHTML挿入API(innerHTML系、フレームワーク固有の raw HTML 挿入等)
- **CWE-798 (ハードコード認証情報)**: ソースコード内の password, secret, api_key, token リテラル
- **CWE-95 (動的コード評価)**: 文字列からコードを動的に生成・実行する関数

```bash
# セキュリティツールが導入されている場合
# npx semgrep --config auto src/
```

### チェック項目

- [ ] CWE-79(XSS)パターンをスキャンした
- [ ] CWE-798(ハードコード認証情報)をスキャンした
- [ ] CWE-95(動的コード評価)パターンをスキャンした
- [ ] ユーザー入力のバリデーション状況を確認した
- [ ] OWASP Top 10の主要カテゴリをカバーした

## 3. 動的アプリケーションセキュリティテスト(DAST)

稼働中のアプリケーションに対してセキュリティスキャンを実施する。

### OWASP ZAP

```bash
# OWASP ZAP Docker(Baseline Scan: パッシブスキャン、高速)
docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \
  -t <TARGET_URL> \
  -J zap-report.json \
  -r zap-report.html

# OWASP ZAP Docker(Full Scan: アクティブスキャン、詳細)
docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-full-scan.py \
  -t <TARGET_URL> \
  -J zap-report.json \
  -r zap-report.html

# API Scan(OpenAPI/Swagger定義がある場合)
docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-api-scan.py \
  -t <OPENAPI_SPEC_URL> \
  -f openapi \
  -J zap-api-report.json
```

### 前提条件

- Docker がインストールされていること
- 対象アプリケーションが起動していること(開発サーバー or ビルド済みプレビュー)
- ネットワークアクセスが可能であること

### スキャンモード選択

| モード | コマンド | 所要時間 | 用途 |
| ------ | -------- | -------- | ---- |
| Baseline | `zap-baseline.py` | 1〜2分 | CI/日常チェック(パッシブスキャンのみ) |
| Full | `zap-full-scan.py` | 10〜30分 | リリース前の詳細スキャン |
| API | `zap-api-scan.py` | 5〜15分 | API仕様ベースのスキャン |

### チェック項目

- [ ] 対象URLに対してスキャンを実行した
- [ ] セキュリティヘッダーの設定を確認した
- [ ] CSP(Content Security Policy)の設定を確認した
- [ ] Cookie属性(Secure, HttpOnly, SameSite)を確認した

## 4. シークレット検出

ソースコードやGit履歴に含まれる機密情報を検出する。

```bash
# gitleaks(Git履歴を含むスキャン)
gitleaks detect --source . --report-path testreport/security/gitleaks.json --report-format json

# gitleaks(ステージング済みファイルのみ)
gitleaks protect --staged --report-path testreport/security/gitleaks-staged.json

# trufflehog(Git履歴スキャン)
trufflehog git file://. --json > testreport/security/trufflehog.json
```

### 検出対象

- APIキー・アクセストークン
- パスワード・認証情報
- 秘密鍵(SSH, PGP)
- データベース接続文字列
- クラウドプロバイダーの資格情報(AWS, GCP, Azure)
- `.env` ファイルのコミット

## 5. セキュリティヘッダー・設定分析

HTTP応答ヘッダーとアプリケーション設定のセキュリティを検証する。

### 必須ヘッダー

| ヘッダー | 推奨値 | 目的 |
| -------- | ------ | ---- |
| `Content-Security-Policy` | 適切なディレクティブ | XSS・データインジェクション防止 |
| `X-Content-Type-Options` | `nosniff` | MIME スニッフィング防止 |
| `X-Frame-Options` | `DENY` or `SAMEORIGIN` | クリックジャッキング防止 |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | HTTPS 強制 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | リファラー情報漏洩防止 |
| `Permissions-Policy` | 必要なAPIのみ許可 | ブラウザ機能の制限 |
