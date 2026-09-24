# セキュリティスキャン ツール導入ガイド

このファイルはセキュリティスキャンツールの導入手順をまとめたリファレンスです。
スキル定義（`SKILL.md`）から参照されます。

## 最小構成（ツール追加なし）

以下はNode.jsプロジェクトなら追加インストール不要で実行可能:

```bash
npm audit                                    # 依存パッケージ脆弱性
```

Grepベースの簡易SASTも追加インストール不要で実行可能。

## 推奨構成

| ツール | カテゴリ | インストール |
| ------ | -------- | ------------ |
| npm audit | SCA | 標準搭載 |
| gitleaks | シークレット検出 | `brew install gitleaks` or GitHub Releases |
| OWASP ZAP | DAST | `docker pull ghcr.io/zaproxy/zaproxy:stable` |
| semgrep | SAST | `pip install semgrep` or `brew install semgrep` |

## CI/CD 統合

```yaml
# GitHub Actions の例
security-scan:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: npm audit --audit-level=high
    - uses: zaproxy/action-baseline@v0.14.0
      with:
        target: 'http://localhost:3000'
    - uses: gitleaks/gitleaks-action@v2
```
