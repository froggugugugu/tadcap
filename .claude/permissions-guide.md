# Permissions Guide — allowlist / auto mode / sandbox の 3 階層運用

Claude Code は許可承認の煩わしさを下げる仕組みを 3 つ用意している。
本テンプレートではプロジェクトの成熟度に応じて段階的に採用することを推奨する。

| 階層 | 役割 | リスクモデル | 推奨フェーズ |
| ---- | ---- | ------------ | ------------ |
| **allowlist** | 既知の安全コマンド・MCP を明示許可 | ホワイトリスト方式。穴あきは確実に拒否 | 全フェーズ(基礎) |
| **auto mode** | 分類器モデルが各操作を審査し、危険なものだけ止める | 黒リスト方式 + 動的判断。誤判定リスクあり | Pro / Max / Team では**既定**。境界を deny / ask で補強して使う |
| **sandbox** | OS レベルのファイルシステム / ネットワーク隔離 | コンテナ・名前空間で物理的に遮断 | 信頼境界が低いタスク |

> 詳細仕様: [permissions](https://code.claude.com/docs/en/permissions) /
> [permission-modes](https://code.claude.com/docs/en/permission-modes) /
> [auto-mode-config](https://code.claude.com/docs/en/auto-mode-config) /
> [sandboxing](https://code.claude.com/docs/en/sandboxing)

## 1. allowlist(基礎)

`settings.local.json` の `permissions.allow` で運用する。本テンプレートには
`settings.local.json.template` として雛形を同梱済み。プロジェクト固有のコマンド
(ビルドツール / DB CLI 等)を追加するときは:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run *)",
      "Bash(npx vitest *)",
      "Bash(gh pr *)",
      "mcp__context7__*"
    ]
  }
}
```

### ベストプラクティス

- **deny / ask は `settings.json`(共有)**、**allow は `settings.local.json`(個人)** に分離
- `Bash(rm *)` のような広パターンは禁止。常に具体的サブコマンドで列挙
- MCP は `mcp__<server>__<tool>` の単位で許可。ワイルドカードは慎重に
- ファイルパス権限は `Read(path)` / `Edit(path)` だけが評価される(`Write(path)` は無視、pitfalls #22)
- deny / ask では `Tool(param:value)` でパラメータ単位の指定もできる
  (例: `Agent(isolation:worktree)`、`Skill(skill:deploy-*)`)
- 1 行追加のたびに「これを通すと何が起きるか」を確認
- project settings の allow ルールは、そのフォルダを **trust した後**にだけ効く(deny / ask は常に効く)

## 2. auto mode

Pro / Max / Team プランの対話セッションでは **auto mode が既定の権限モード**(v2.1.228 以降)。
分類器モデルが各ツール呼び出しを審査し、スコープ外への昇格・未知のインフラ操作・
敵対的入力起因の操作だけをブロックする。`claude -p`(非対話)と Enterprise / API キーの既定は
従来どおり Manual(`default`)。

### 評価順序(重要)

```text
permissions.deny  → 分類器より前に絶対ブロック(ユーザー意図でも上書き不可)
permissions.ask   → auto mode でも必ず確認ダイアログ(分類器は自動承認できない)
分類器            → 上記に該当しない操作を審査
フック(Layer 1)   → どのモードでも常に発火
```

本テンプレートの `settings.json` はこの前提で設計されている:
`git push` / `gh pr merge` / `publish` / `kubectl apply` 等の外向き操作は `ask` に置いてあるため、
auto mode でも毎回人間の確認を通る。

### 設定の置き場所(公式仕様の落とし穴)

| 書く内容 | 効く場所 | 効かない場所 |
| -------- | -------- | ------------ |
| `permissions.deny` / `permissions.ask` | 全 settings(project 含む) | — |
| `permissions.defaultMode: "auto"` | `~/.claude/settings.json`、managed | **project / local settings では無視**(pitfalls #25) |
| `autoMode.environment` / `hard_deny` / `soft_deny` / `allow` | `~/.claude/settings.json`、managed | **project / local settings では無視** |
| `disableAutoMode: "disable"` | 任意の settings | — |

- 組織のリポジトリ・バケット・内部ドメインが「外部」扱いされて拒否されるときは、
  `/auto-mode-setup` で `autoMode.environment` の下書きを生成し、個人の settings に保存する
- 分類器は **CLAUDE.md も読む**。「force push しない」等のプロジェクト固有の禁止事項は
  CLAUDE.md 本体に書けば Claude と分類器の両方を同時に導ける。`@AGENTS.md` など import 先を分類器が読むかは
  公式に記載が無いため、安全に関わる禁止事項は `AGENTS.md` だけに置かない

### 拒否履歴の活用

`PermissionDenied` フック(`permission-denied-log.sh`)が分類器の拒否を
`testreport/denials/<session>.jsonl` に記録する。

- 正当な操作が繰り返し拒否される → `settings.local.json` の allow に追加
- 自社インフラが外部扱い → `autoMode.environment` に記述
- `-p`(非対話)で分類器が連続拒否しても実行は止まらない。拒否理由をログで確認し、上記で修正する

### 注意点

- 分類器は完全ではない。allowlist より「緩い」防御として位置付け、deny / ask / フックで境界を固定する
- 本テンプレートのフック層(safety-check / protect-files / verify-gate)は auto mode でも有効
- 完了条件まで自走させたいときは auto mode と `/goal <条件>` を組み合わせる

## 3. sandbox

`claude --sandbox` または `/sandbox` でセッション中に有効化。OS レベルでファイル
システムとネットワークを隔離する。共有設定に入れる場合は `settings.json` の `sandbox` キー
(`settings.local.json.template` の `_comment_sandbox` に雛形)。

### 推奨用途

- **未知 / 不信頼コードの実行**: GitHub Issue から拾った PoC スクリプトの試行
- **依存関係の動的検証**: `npm install` 直後の不審パッケージの挙動確認
- **CI から取得した変更のレビュー実行**: 外部 PR の動作確認

### 制約

- ファイル書き込みはサンドボックス内に限定される(リポジトリ外への影響を防ぐ)
- ネットワークは allowlist 形式で許可。デフォルトは閉鎖
- パフォーマンスオーバーヘッドあり(数 % 〜)
- auto mode とは独立に動作し、併用できる(plan mode では auto-allow が承認範囲を広げない)

## 4. 制限モード(`--restricted`)

`claude --restricted` で起動すると、共有マシンで評価ハーネスが `claude` を駆動するような状況を想定した最小権限で始まる。

- コマンドやコードを実行する組み込みツールと `WebFetch` が既定から外れる(`--tools` で個別に挙げたものだけ戻る)
- ファイル系ツールは working directory に限定される
- 設定は managed settings と `--settings` だけを読む(個人・プロジェクトの settings は読まない)
- `bypassPermissions` は拒否され、auto mode の分類器も保護パスへの書込を承認できない

本テンプレートのフックはプロジェクトの `settings.json` に登録されているため、制限モードでは読まれない。
制限モードで評価を回すときは、ガードレールをフックに頼らず `--tools` と working directory で絞る。

## 推奨運用パターン

| シーン | 推奨設定 |
| ------ | -------- |
| 開発初期(セットアップ直後) | auto mode(既定)+ 共有 deny / ask。allow を追加しながら分類器の拒否ログを観察 |
| 安定運用フェーズ | auto mode + `/goal` で長時間タスクを自走。`strict` プロファイルで検証ゲートを差し戻し化 |
| 高リスク調査(脆弱性検証等) | sandbox を有効化し、別ワークツリー(`--worktree`)で実行 |
| CI / GitHub Actions | `--permission-mode dontAsk` + `--allowedTools` の厳密な allowlist + `--max-turns N` |
| 共有マシンで評価ハーネスを回す | `claude --restricted` + `--tools` で必要なツールだけを明示 |
| コンテナ内の完全無人実行 | `--dangerously-skip-permissions`(コンテナ / VM 必須。deny とフックはこのモードでも有効) |

## 3 層防御モデルとの整合

本テンプレートのガードレール(`.claude/guardrails.md`)は 3 層防御を採る:

```text
Layer 1: フック(常時有効、--dangerously-skip-permissions でも有効)
  ↓
Layer 2: deny / ask ルール(settings.json、共有。auto mode の分類器より前 / 上位)
  ↓
Layer 3: allow ルール(settings.local.json、個人)
```

permissions-guide のスコープは **Layer 2 + Layer 3**。Layer 1 のフックはこの 3 階層
とは独立して常に動作するため、「auto mode で誤って通った」操作もフックでブロックされる。

## 関連ドキュメント

- `.claude/guardrails.md` — フック・deny ルール・保護ファイル一覧
- `.claude/pitfalls.md` — #23 auto mode / #25 project settings の無視 / #27 Stop フック
- `settings.local.json.template` — 雛形(ビルドツール別の差し替えパターン・auto mode / Stop ゲートの注記込み)
- `managed-settings.example.json` — 組織ポリシーとして固定する場合の例(deny / sandbox / OpenTelemetry)
