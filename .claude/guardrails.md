# ガードレール — 安全機構の全体像

本ファイルは、プロジェクトに適用されるすべての安全機構をまとめた参照文書。
`AGENTS.md` / `CLAUDE.md` の各セクションに分散するルールを一元的に把握できるようにする。

---

## フック一覧(16 スクリプト / settings 19 登録 + agent frontmatter 3 登録)

| フック | イベント | 対象 | 動作 | 説明 |
| ------ | -------- | ---- | ---- | ---- |
| `safety-check.sh` | PreToolUse | Bash | ブロック | 危険なシェルコマンドを検出・阻止 |
| `protect-files.sh` | PreToolUse | Edit\|Write\|NotebookEdit | ブロック | 機密ファイル・設定ファイルへの書き込みを阻止 |
| `scan-harness.sh` | PreToolUse | Skill | 警告/ブロック | ハーネス自身の SAST(secret 混入・constitution 改変・local deny の弱体化検出) |
| `user-prompt-submit.sh` | UserPromptSubmit | — | 警告/ブロック + 文脈注入 | 機密パターン検出。コンパクト直後は中核ルールを再注入 |
| `session-start.sh` | SessionStart | — | 警告 | project-config.md / docs/ / settings.local.json の存在チェック |
| `session-end.sh` | SessionEnd | — | 観測 | セッション終了サマリを `output/reports/sessions/<date>.md` に追記 |
| `commit-quality.sh` | PostToolUse | Bash (git commit) | 警告 | Conventional Commits 形式チェック・シークレット検出 |
| `console-warn.sh` | PostToolUse | Edit\|Write | 警告 | デバッグステートメント(console.log 等)の残存検出 |
| `verify-gate.sh track` | PostToolUse | Bash\|Edit\|Write\|NotebookEdit | 観測 | ソース編集 / 検証コマンド実行の時刻を記録(`testreport/.verify/`) |
| `verify-gate.sh gate` | **Stop** | — | 警告/差し戻し | 編集後に検証コマンドが無ければ standard=警告 / strict=1 回差し戻し(検証ゲート) |
| `verify-gate.sh task` | **TaskCompleted** | — | 警告/差し止め | 同条件でタスクの完了マークを standard=警告 / strict=exit 2 で差し止め(品質ゲート③の機械強制) |
| `permission-denied-log.sh` | **PermissionDenied** | `*` | 観測 | auto mode の分類器による拒否を記録(`testreport/denials/`) |
| `scope-guard.sh <scope>` | PreToolUse(**agent frontmatter**) | Edit\|Write\|NotebookEdit | ブロック | 書込可能な subagent の範囲外書込を阻止(doc-synchronizer=docs / doc-writer=output / test-writer=tests) |
| `post-failure-log.sh` | **PostToolUseFailure** | `*` | 観測 | ツール失敗時の構造化エラーログ(`testreport/failures/`) |
| `subagent-audit.sh` | **SubagentStart** | — | 観測 + 文脈注入 | 起動記録 + サブエージェントへガードレールを注入 |
| `subagent-audit.sh` | SubagentStop | — | 観測 | 完了記録(`testreport/agents/`) |
| `pre-compact-backup.sh` | PreCompact | — | 観測 | コンパクト直前の会話履歴バックアップ(`testreport/transcripts/`) |
| `post-compact-restore.sh` | **PostCompact** | — | 観測 + マーカー | 要約を保全し、再注入マーカーを設置 |
| `notify-claude.sh` | Stop / Notification | — | 通知(async) | タスク完了時の外部通知(ntfy) |

### コンパクト対策の 2 段構え

コンテキストのコンパクト後に指示が薄れる問題(pitfalls #21)への対策:

```text
PreCompact  → pre-compact-backup.sh   会話履歴を testreport/transcripts/ に退避
PostCompact → post-compact-restore.sh 要約を保全し .post-compact-pending を設置
                    ↓ (次の 1 プロンプトだけ)
UserPromptSubmit → user-prompt-submit.sh マーカーを回収して
                    additionalContext で中核ルールを再注入
```

> **なぜ 2 段か**: `PostCompact` は公式仕様上 **decision control を一切持たない**
> (`additionalContext` も返せない)side-effect 専用イベントである。
> 文脈を注入できるのは `UserPromptSubmit` 側なので、マーカーで橋渡しする。

### 検証ゲート(Stop フック)

公式ベストプラクティス「Claude に検証手段を与え、Stop フックで決定論的にゲートする」の実装。
「動くはず」で終わる trust-then-verify gap(pitfalls #19)を機械的に塞ぐ。

```text
PostToolUse → verify-gate.sh track   ソース編集 / 検証コマンドのタイムスタンプを記録
Stop        → verify-gate.sh gate    最後の編集より後に検証コマンドが無ければ:
                                        standard: systemMessage で人間に警告
                                        strict:   decision:block で 1 回だけ差し戻し
```

- 検証コマンドの判定: `npm test` / `vitest` / `jest` / `pytest` / `cargo test` / `go test` / `tsc` /
  `eslint` / `biome` / `playwright test` / `make test` など(スクリプト内 `VERIFY_PATTERNS`。プロジェクトに合わせて追記可)
- 対象外: `docs/` `output/` `input/` `.claude/` `.github/` と `.md` / `.json` / `.yaml` / `.toml` の編集
- `stop_hook_active: true`(自分の差し戻し後)と `background_tasks` 非空(待機中)は必ず通す(pitfalls #27)
- 会話内で柔軟な完了条件を判定させたいときは `/goal <条件>`(モデル評価、セッション限り)を併用する
- 回帰テスト: `bash scripts/validate-harness.sh --hooks` が全フックに hook JSON を流して exit code / 出力を検証する(CI でも実行)

### 実行環境ごとの挙動

フックはターミナル / IDE 拡張 / Desktop アプリ / Claude Code on the web の
**すべてで同じイベントが発火する**。ただし到達できる先が異なるため、
本テンプレートのフックは環境によって効き方が変わる。

| | ターミナル / IDE / Desktop | Claude Code on the web（クラウド） | CI（`claude -p`） |
| --- | --- | --- | --- |
| ローカルファイル | ✅ 永続 | ⚠️ **fresh clone**。`testreport/` はセッション終了で消える | ⚠️ ジョブ終了で消える（artifact 化が必要） |
| `notify-claude.sh`（ntfy 送信） | ✅ | ⚠️ 環境のネットワーク設定に依存（既定は制限あり） | ❌ 無意味（`BLUEPRINT_HOOK_PROFILE=minimal` で止める） |
| `session-end.sh` / `pre-compact-backup.sh` | ✅ | ⚠️ 出力は永続しない | ⚠️ 同左 |
| `safety-check.sh` / `protect-files.sh` | ✅ | ✅ | ✅ |
| MCP サーバー | `.mcp.json` | 環境ごとに設定したコネクタ | `.mcp.json`（`--bare` 時は読まれない） |
| 権限プロンプト | 対話 | 自律実行（プロンプトなし） | `--permission-mode` に従う |

**推奨設定**:

- クラウド / CI では `BLUEPRINT_HOOK_PROFILE=minimal` にする。
  観測系フックの出力が永続しない環境で書き込みコストだけ払うのを避けられる
- 監査ログを残したいクラウド実行では、`testreport/` を成果物として
  明示的に取り出す（CI なら `actions/upload-artifact`）
- クラウド環境ではネットワークアクセスが既定で制限される。
  `WebFetch` や外部 MCP に依存する skill は事前に環境設定を確認する

### 定期実行の選び方

「毎週セキュリティ監査を回す」のような定期実行には 3 つの選択肢があり、
**恒久性が大きく異なる**。

| | セッション内（`/loop`・`CronCreate`） | GitHub Actions `schedule` | Routines（クラウド） |
| --- | --- | --- | --- |
| セッション起動が必要 | **必要**（idle のときだけ発火） | 不要 | 不要 |
| 恒久性 | ⚠️ recurring は **7 日で失効** | ✅ | ✅ |
| 最小間隔 | 1 分 | 5 分（実際は遅延あり） | 1 時間 |
| ローカルファイル | ✅ | ✅（clone） | ❌（fresh clone） |
| 新規会話で消える | **消える** | — | — |

- **リポジトリの定期監査には GitHub Actions を使う**。同梱の
  `claude-scheduled-audit.yml.template` が週次で `/security-scan` と
  `/legal-check` を回し、結果を Issue に集約する
- `/loop` はセッション中の短期ポーリング（ビルド待ち等）に限る
- Actions の cron は `:00` を避ける（混雑して遅延しやすい）

### 組織展開(managed settings / OpenTelemetry)

個人が上書きできない組織ポリシーとして固定する場合は managed settings を使う。同梱の
`.claude/managed-settings.example.json` に deny / `disableBypassPermissionsMode` / sandbox /
OpenTelemetry(`CLAUDE_CODE_ENABLE_TELEMETRY` + OTLP エクスポータ)/ `requiredMinimumVersion` の例を置いている。
本テンプレートの `testreport/` ログは machine-local なので、チーム横断の利用量・skill 使用率は OTel で集約する
(`OTEL_LOG_TOOL_DETAILS=1` で skill 名が記録され、未使用 skill を特定できる)。

### Hook profile 切替

`BLUEPRINT_HOOK_PROFILE` 環境変数で挙動を切替可能
(`user-prompt-submit.sh` / `session-end.sh` / `scan-harness.sh` / `post-compact-restore.sh` / `subagent-audit.sh` /
`verify-gate.sh` / `permission-denied-log.sh` 対応):

| profile | 用途 | 挙動 |
| ------- | ---- | ---- |
| `minimal` | CI / 自動化 | パススルー(検査スキップ)。最小オーバーヘッド |
| `standard`(既定) | 通常開発 | 検出時は警告のみ(non-blocking) |
| `strict` | 高リスク作業 | 検出時に skill / プロンプトをブロック。未検証の終了を差し戻し |

`.envrc` や `direnv` で切り替えるのが推奨。

### フックの動作原則(公式仕様)

- **exit 2 = ブロック**。stderr がブロック理由として Claude に返る
  - 例外: `UserPromptSubmit` は `exit 0 + stdout JSON {"decision":"block","reason":"..."}` で差し戻す
- **exit 0 の stderr は debug log 止まり** — Claude にもユーザーにも届かない
  - 警告を Claude に伝えるには **stdout に `hookSpecificOutput.additionalContext` を出す**
  - 本テンプレートの警告系フックは共通の `emit_context()` でこれを実装している
- **stdout の解釈は先頭 1 文字で決まる**: `{` なら JSON、それ以外はプレーンテキスト
  - プレーンテキストが文脈として渡るのは `UserPromptSubmit` / `UserPromptExpansion` / `SessionStart` のみ
- **fail-open ポリシー**: JSON パース失敗・jq 不在時は操作を許可(作業を止めない)
- **`async: true`**: 外部通信など遅いフックはバックグラウンド実行にできる
  - ただし async フックは `decision` / `permissionDecision` / `continue` を返せない
  - 本テンプレートでは `notify-claude.sh`(ntfy 送信)のみ async
- フックは `--dangerously-skip-permissions` モードでも有効(多層防御)
- **Stop フックの差し戻しは 8 回連続で Claude Code に無視される**。`stop_hook_active` を見て 1 回で通す設計にする
- ハンドラの追加フィールド: `if`(権限ルール構文で発火条件を絞る。例 `"if": "Bash(git *)"`)/ `once`(初回成功後に解除)/
  `asyncRewake`(バックグラウンド実行し exit 2 で Claude を起こす)/ `args`(exec 形式)/ `statusMessage`

### イベント別の decision 可否(抜粋)

| イベント | 制御 |
| -------- | ---- |
| `PreToolUse` | `hookSpecificOutput.permissionDecision`(allow / deny / ask / defer) |
| `UserPromptSubmit` / `PostToolUse` / `PostToolUseFailure` / `Stop` / `SubagentStop` / `PreCompact` | トップレベル `decision: "block"` + `reason` |
| `SessionStart` / `Setup` / `SubagentStart` | **文脈注入のみ**(`additionalContext`)。ブロック不可 |
| `PostCompact` / `SessionEnd` / `Notification` / `FileChanged` 等 | **制御なし**。ログ・クリーンアップ等の副作用専用 |

### フックタイプの使い分け

| タイプ | 用途 | 例 |
| ------ | ---- | -- |
| `command` | シェルスクリプトを実行。パターンマッチ・ファイル検査等の決定論的チェック | safety-check.sh, protect-files.sh |
| `prompt` | AI に判断を委ねる。文脈依存の柔軟な判定が必要な場合 | 「この Bash コマンドは本番環境で安全か評価せよ」 |
| `http` | 外部エンドポイントに POST。集中管理・監査基盤との連携 | 組織共通の監査サーバー |
| `mcp_tool` | MCP ツールを直接呼ぶ | — |
| `agent` | subagent がツール(Read / Grep / Bash 等)で条件を検証してから判定 | Stop 時に「テストが全件通っているか実行して確認せよ」(実験的) |

- デフォルトは `command` を推奨(決定論的で高速)
- `prompt` / `agent` はコンテキスト依存の判断が必要な場合のみ(トークンを消費する)。`/goal` は prompt 型 Stop フックのセッション限定版
- 同一イベントに複数タイプを併用可能

### 未使用の公式フックイベント(拡張の余地)

本テンプレートで未使用だが、プロジェクト固有に追加できるイベント:

| イベント | タイミング | 用途例 |
| -------- | ---------- | ------ |
| `Setup` | `--init-only` / `-p --init` 実行時 | CI での依存インストール・定期クリーンアップ |
| `InstructionsLoaded` | CLAUDE.md / rules 読込時 | ルール適用の可観測性 |
| `PermissionRequest` | 権限ダイアログ発生時 | 組織ポリシーによる自動 allow/deny |
| `PreModelSwitch` / `PostModelSwitch` | `/model` 等でモデルを切り替える前後 | 高コストモデルへの切替の確認・監査(切替はキャッシュを無効化する) |
| `PostToolBatch` | 並列ツール実行の一括完了時 | バッチ単位の検証 |
| `TaskCreated` / `TaskCompleted` | タスク作成・完了時 | タスク命名規約の強制・品質ゲート |
| `TeammateIdle` | チームメイトが手待ちになったとき | エージェントチームの品質ゲート |
| `StopFailure` | ターンがエラー終了したとき | 失敗率の計測 |
| `FileChanged` | ファイル変更検知時 | 外部ツールとの同期 |
| `WorktreeCreate` / `WorktreeRemove` | worktree 作成・削除時 | 分離環境のセットアップ |
| `CwdChanged` / `DirectoryAdded` / `ConfigChange` | 作業ディレクトリ・設定変更時 | 環境変化の監査 |
| `MessageDisplay` | アシスタント出力の表示時 | 表示内容のマスキング |
| `Elicitation` / `ElicitationResult` | MCP のフォーム入力時 | 自動応答 |

`settings.json` に追加する形式:

```json
{
  "hooks": {
    "TaskCompleted": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "./scripts/gate-check.sh", "timeout": 30 }
        ]
      }
    ]
  }
}
```

---

## Deny ルール(settings.json)

### 破壊的シェル操作

| パターン | 目的 |
| -------- | ---- |
| `Bash(rm -rf *)` / `Bash(rm -rf /*)` / `Bash(rm -fr *)` | 再帰削除の防止 |
| `Bash(git push --force *)` / `Bash(git push -f *)` | 強制プッシュの防止 |
| `Bash(git reset --hard *)` | ハードリセットの防止 |
| `Bash(git clean -f *)` | 追跡外ファイル一括削除の防止 |
| `Bash(sudo *)` | 特権昇格の防止 |
| `Bash(chmod 777 *)` | 過剰な権限付与の防止 |
| `Bash(dd if=*)` / `Bash(mkfs*)` | ディスク破壊操作の防止 |
| `Bash(* --no-verify)` / `Bash(* --no-verify *)` | Git フック迂回の防止 |
| `Skill(skill:deploy)` / `Skill(skill:deploy-*)` / `Skill(skill:*-deploy)` | deploy 系 skill の起動禁止 |
| `Skill(skill:production-*)` / `Skill(skill:*-production)` | production 系 skill の起動禁止 |

> `Tool(param:value)` 形式で任意ツールのトップレベル入力パラメータを deny/ask できる。
> `Skill` の `skill` パラメータもその対象なので、高リスク skill を permission 層で止められる。
> `scan-harness.sh` は同じ判定を profile で緩められる運用層として二重化している。

### シークレットの読み取り禁止(新規)

`protect-files.sh` は `Edit`/`Write` 系しか見ないため、**読み取り**は permissions で塞ぐ。
`Read(...)` の deny は Edit/Write もあわせてブロックし、`cat` / `head` / `sed` 等
Claude Code が認識する Bash のファイルコマンドにも適用される。

| パターン | 目的 |
| -------- | ---- |
| `Read(./.env)` / `Read(./.env.*)` | 環境変数ファイル |
| `Read(./secrets/**)` | シークレット置き場 |
| `Read(.npmrc)` | レジストリトークン |
| `Read(credentials.json)` / `Read(service-account.json)` | クラウド認証情報 |
| `Read(id_rsa)` / `Read(id_ed25519)` / `Read(id_ecdsa)` / `Read(id_dsa)` | SSH 秘密鍵 |
| `Read(*.pem)` / `Read(*.key)` / `Read(*.p12)` / `Read(*.pfx)` / `Read(*.jks)` / `Read(*.keystore)` | 証明書・キーストア |
| `Edit(./.env)` / `Edit(./.env.*)` / `Edit(*.pem)` / `Edit(*.key)` | NotebookEdit も含めて改変を禁止 |

> **注意**: Read/Edit の deny は Claude の組み込みファイルツールと認識可能な Bash コマンドにしか効かない。
> Python / Node スクリプトが間接的に開くファイルまでは止まらない。
> OS レベルで完全に塞ぐには `sandbox` を有効化する(後述)。

### Ask ルール(確認を挟む操作)

`acceptEdits` / `bypassPermissions` でも**必ず確認を挟む**外向き・不可逆操作:

| パターン | 目的 |
| -------- | ---- |
| `Bash(git push *)` | リモートへの反映は毎回確認 |
| `Bash(gh pr merge *)` / `Bash(gh release *)` / `Bash(gh repo delete *)` | マージ・リリース・削除 |
| `Bash(npm publish *)` / `Bash(yarn publish *)` / `Bash(pnpm publish *)` | パッケージ公開 |
| `Bash(docker push *)` | イメージ公開 |
| `Bash(kubectl apply *)` / `Bash(kubectl delete *)` | クラスタ変更 |
| `Bash(terraform apply *)` / `Bash(terraform destroy *)` | インフラ変更 |
| `Bash(curl *)` / `Bash(wget *)` | 任意 URL への通信(URL 制限は WebFetch(domain:...) 側で行う) |

> `deny` > `ask` > `allow` の順で評価される。`settings.local.json` の allow に
> `Bash(git push *)` を書いても ask が優先される(意図的な設計)。

---

## 保護ファイル一覧

### シークレット・認証情報(protect-files.sh + deny ルール)

| ファイル / パターン | 理由 |
| -------------------- | ---- |
| `.env`, `.env.local`, `.env.production` 等 | 環境変数(シークレット含有の可能性) |
| `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa` | SSH 秘密鍵 |
| `credentials.json`, `service-account.json` | クラウド認証情報 |
| `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore` | 証明書・キーストア |
| `.claude/settings.json`, `.claude/settings.local.json` | Claude Code 設定 |

### ツールチェーン設定(protect-files.sh)

| ファイル / パターン | 理由 |
| -------------------- | ---- |
| `biome.json`, `biome.jsonc` | Biome リンター/フォーマッター設定 |
| `.eslintrc.*`, `eslint.config.*` | ESLint 設定 |
| `.prettierrc.*`, `prettier.config.*` | Prettier 設定 |
| `tsconfig.json`, `tsconfig.*.json` | TypeScript コンパイラ設定 |
| `.editorconfig` | エディタ設定 |

---

## 禁止操作(AGENTS.md / CLAUDE.md + safety-check.sh)

| 操作 | 理由 |
| ---- | ---- |
| `--no-verify` | Git フックの迂回は禁止 |
| `--force` (git push) | 履歴の破壊は原則禁止 |
| `sudo` | 特権昇格は禁止 |
| `curl \| bash` | リモートスクリプトのパイプ実行は禁止 |
| `chmod 777` | 過剰な権限付与は禁止 |
| `dd if=` / `mkfs` | ディスク操作は禁止 |

---

## 3 層防御モデル

```text
Layer 0: OS サンドボックス(任意 / settings.local.json で opt-in)
   └─ sandbox.enabled = true で Bash をサンドボックス実行。
      任意のサブプロセスによるファイル・ネットワークアクセスまで OS レベルで制限
  ↓
Layer 1: フック群(--dangerously-skip-permissions でも有効)
   ├─ PreToolUse: safety-check / protect-files / scan-harness(Skill)
   ├─ PostToolUse: commit-quality / console-warn
   ├─ PostToolUseFailure: post-failure-log
   ├─ UserPromptSubmit: user-prompt-submit
   ├─ SessionStart / SessionEnd: session-start / session-end
   ├─ SubagentStart / SubagentStop: subagent-audit
   ├─ PreCompact / PostCompact: pre-compact-backup / post-compact-restore
   └─ Stop / Notification: notify-claude(async)
  ↓
Layer 2: Deny / Ask ルール(settings.json — チーム共有)
   ├─ deny: 破壊的操作・シークレット読取を無条件で遮断
   └─ ask : 外向き・不可逆操作は権限モードに関わらず確認を挟む
  ↓ 通常モードで有効
Layer 3: Allow ルール(settings.local.json — 個人)
  ↓ 通常モードでのみ有効
meta : self-SAST(scan-harness.sh が constitution hash / secret 混入 / deny 弱体化を検出)
```

> Layer 1 にはブロック系(`safety-check.sh` / `protect-files.sh` / `scan-harness.sh`)
> + 観測系(`subagent-audit.sh` / `pre-compact-backup.sh` / `post-compact-restore.sh` /
> `post-failure-log.sh` / `session-end.sh`) + 警告系(`commit-quality.sh` /
> `console-warn.sh` / `user-prompt-submit.sh`) + 通知系(`notify-claude.sh`)が含まれる。
> 観測・通知系はブロックしないが、`--dangerously-skip-permissions` でも記録・通知が残る点で
> 防御機構の一部として機能する。

- Layer 0 は既定で無効。閉域運用や外部コード実行を伴うプロジェクトで有効化する
- Layer 1 は常に有効。最も信頼性の高い防御層
- Layer 2 は通常モードで自動適用。`ask` は `acceptEdits` / `bypassPermissions` でも効く
- Layer 3 はプロジェクト固有の許可ルール(テンプレートから設定)

### Layer 0 の有効化(任意)

```json
// .claude/settings.local.json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "allowedDomains": ["registry.npmjs.org", "github.com", "api.github.com"]
    }
  }
}
```

サンドボックス内で失敗するコマンドがある場合は `sandbox.excludedCommands` で個別に外す。
