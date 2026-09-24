# 落とし穴集 — Claude Code 協調開発で踏みやすい失敗パターン

AI 協調開発で頻出する失敗事例と対策をまとめる。
実際に発見したプロジェクト固有の落とし穴は `project-config.md` §11 や `docs/development-patterns.md` に追記する。
本ファイルは **テンプレート横断の普遍的な落とし穴** に絞る。

## 運用上の落とし穴

### 1. CLAUDE.md の肥大化

| 項目 | 内容 |
| ---- | ---- |
| **現象** | CLAUDE.md が長くなるほど、書いた指示が守られなくなる |
| **原因** | 200 行を超えると重要度の低い指示に埋もれて参照精度が落ちる。全セクションを毎セッション読み込むためトークンコストも肥大 |
| **対策** | 横断ルールのみに絞る。詳細は skill / `docs/` / `.claude/rules/` に分離。`docs/*.md` / `.claude/*.md` 等の具体パスで `@import` する(ルート相対) |

### 2. subagent に親の skill が自動では載らない(CLAUDE.md / rules は継承される)

| 項目 | 内容 |
| ---- | ---- |
| **現象** | subagent が親セッションで使っていた skill の手順を知らない。逆に「CLAUDE.md が読まれない」と誤解して agent 本文にルールを全文再掲し、トークンを浪費する |
| **原因** | 公式仕様: カスタム subagent は CLAUDE.md 階層(`.claude/rules/` 含む)と git status を**継承する**(ビルトインの `Explore` / `Plan` だけがスキップ)。継承しないのは **skill 本文・会話履歴・親の auto memory**。skill は `skills:` frontmatter に書いたものだけ全文プリロードされる |
| **対策** | 必要な skill は agent の `skills:` に列挙する。会話で決めた前提は `prompt` に明示的に渡す。CLAUDE.md の再掲は不要 |

### 3. `~/.claude/skills/` はフラット構造必須

| 項目 | 内容 |
| ---- | ---- |
| **現象** | `~/.claude/skills/category/my-skill/SKILL.md` を置いても認識されない |
| **原因** | ユーザー領域の skill scan は 1 階層のみ。再帰探索されない |
| **対策** | `~/.claude/skills/<skill-name>/SKILL.md` のフラット構造で配置する。プロジェクト側 `.claude/skills/` は階層 OK |

### 4. Full content injection によるトークン爆発

| 項目 | 内容 |
| ---- | ---- |
| **現象** | skill / agent 実行が遅い。コストが想定の 10 倍かかる |
| **原因** | skill 本文や agent prompt で巨大ファイルを `Read` で全読みしている |
| **対策** | Grep で候補行を絞ってから Read。Read の `limit` / `offset` を使う。大きい docs は `docs/...` の import に分離 |

### 5. Hooks: exit 1（非ブロック）と exit 2（ブロック）の混同

| 項目 | 内容 |
| ---- | ---- |
| **現象** | 危険コマンドをブロックしたはずが通ってしまう |
| **原因** | Hook で `exit 1` を返しているが、Claude Code は `exit 2` のみをブロック扱いする |
| **対策** | ブロック系は必ず `exit 2`(stderr がブロック理由として Claude に返る)。**警告系で `exit 0` + stderr は届かない** — exit 0 の stderr は debug log 止まり。警告は stdout に `{"hookSpecificOutput":{"additionalContext":"..."}}` を出す。既存 `safety-check.sh`(ブロック)/ `console-warn.sh`(警告)を参考に |

### 6. ANTHROPIC_API_KEY スコープ過大による課金事故

| 項目 | 内容 |
| ---- | ---- |
| **現象** | 意図しない大量 API 呼び出しで高額課金（数百〜数千ドル） |
| **原因** | GitHub Actions・CI で無制限の API キーを使い、PR 大量作成や autonomous loop が暴走 |
| **対策** | 月額 / 日額上限を API キーに設定。`claude-code-action` には `max_turns` / `timeout_minutes` を設定。autonomous loop は exit gate を二重化 |

## セキュリティ・権限の落とし穴

### 7. MCP サーバーの信頼モデル誤解

| 項目 | 内容 |
| ---- | ---- |
| **現象** | MCP サーバー経由で任意コマンドが実行され、シークレットが流出 |
| **原因** | MCP サーバーはローカルで任意コマンドを実行する権限を持つ。悪意のあるサーバーを `.mcp.json` に追加すると危険 |
| **対策** | 公式・信頼できるソースのサーバーのみ。認証情報は環境変数参照（`${VAR}`）。`permissions.deny` で未知の MCP を拒否し、`permissions.allow` で明示許可 |

### 8. `.claude/settings.local.json` の誤共有

| 項目 | 内容 |
| ---- | ---- |
| **現象** | 個人の allow リストがチームに共有され、他メンバーの環境で想定外のコマンドが通る |
| **原因** | `.gitignore` に `settings.local.json` が含まれていない or 含めずにコミット |
| **対策** | `.gitignore` に必ず含める。チーム共有ルールは `settings.json` 側に書く |

### 9. `output/` と `input/` の越境

| 項目 | 内容 |
| ---- | ---- |
| **現象** | AI が `input/requirements/REQ_*.md` を勝手に書き換えたり、人間が `output/reports/` に手書き追記したり |
| **原因** | input/output の責務分離ルールを知らないセッションが介入 |
| **対策** | `AGENTS.md` §「ドキュメント管理」を全 agent の prompt に引き継ぐ。agent 側の `tools` でスコープ制限 |

### 10. `testreport/` を git にコミット

| 項目 | 内容 |
| ---- | ---- |
| **現象** | リポジトリ肥大化。カバレッジ HTML や大量の JSON が履歴に残る |
| **原因** | `setup.sh` が `.gitignore` に追加するが、既存プロジェクトで追加前にコミットしてしまった |
| **対策** | `.gitignore` に `testreport/` を含める。過去に混入していたら `git filter-repo` で履歴から除去 |

## スキル・チーム運用の落とし穴

### 11. Skill の `description` が長すぎて発動が曖昧

| 項目 | 内容 |
| ---- | ---- |
| **現象** | skill が意図せず発動する / 発動しない |
| **原因** | `description` が 500 字を超えると Claude のマッチング精度が落ちる |
| **対策** | 1〜2 文、100 字程度に絞る。「〜のときに使用する」の形式で条件を明示 |

### 12. 並行 team 起動時の共有レイヤー競合

| 項目 | 内容 |
| ---- | ---- |
| **現象** | `TEAM_PJM --parallel` で複数 Bundle が同じ `src/shared/` を編集して競合 |
| **原因** | Feature Bundle 特定時に共有レイヤーの分離を怠った |
| **対策** | `TEAM_PJM.md` の「Feature Bundle 特定ルール」を遵守。共有レイヤーは Phase 4b で逐次処理 |

### 13. `project-config.md` §11 と `docs/development-patterns.md` の二重更新

| 項目 | 内容 |
| ---- | ---- |
| **現象** | 落とし穴が 2 ファイルに散らばり、どちらが最新か不明に |
| **原因** | 更新責務が曖昧。複数 skill が同じ情報を別の場所に書く |
| **対策** | `.claude/rules/document-management.md` の競合防止テーブルを守る。一次更新者は `/implementing-features` |

### 14. `@` import のパス誤り

| 項目 | 内容 |
| ---- | ---- |
| **現象** | `.claude/pitfalls.md` が見つからず、CLAUDE.md の参照が壊れる |
| **原因** | `@` import は Claude Code がリポジトリルートからのパスとして解決する。CLAUDE.md 自身のディレクトリからの相対ではない |
| **対策** | 既存の `docs/*.md` / `.claude/*.md` パターンに倣う（ルート相対）。迷ったら `ls` で存在を確認 |

### 15. Git フック迂回の誘惑

| 項目 | 内容 |
| ---- | ---- |
| **現象** | フック失敗時に `--no-verify` で強行通過、後でバグが表面化 |
| **原因** | フック失敗の原因を修正するより迂回の方が速く見えるため |
| **対策** | `--no-verify` は既存 `safety-check.sh` フックでブロック済み。迂回したくなったら「フックが何を守っているか」を調べる。`AGENTS.md` §Git 操作も参照 |

## コンテキスト管理の落とし穴

公式ベストプラクティスより抽出した、Claude Code の長時間運用で頻出する 5 つの失敗パターン。

### 16. Kitchen sink session(無関係タスクの混在)

| 項目 | 内容 |
| ---- | ---- |
| **現象** | 1 つの会話で要件定義 → デバッグ → 別機能の調査 → 元タスク復帰 を続け、文脈が肥大化して指示精度が落ちる |
| **原因** | 関連の薄いタスクの履歴・ファイル読込・コマンド出力がすべて context window に滞留 |
| **対策** | タスクが切り替わった時点で `/clear` を実行する。`.claude/quality-gates.md` で定義されているフェーズゲートの合間に習慣化するのが最も効く |

### 17. Over-correction loop(同じ指摘を何度も繰り返す)

| 項目 | 内容 |
| ---- | ---- |
| **現象** | 同じ箇所を 3 回以上修正させて結局直らない。失敗アプローチが context に残り続ける |
| **原因** | 失敗した試行をすべて記憶しているため、AI は「どれを採用すべきか」を判断できない |
| **対策** | 2 回連続で失敗したら `/clear` し、学んだ前提を明示的に盛り込んで一から指示し直す。`/rewind` で失敗前のチェックポイントへ戻すのも有効 |

### 18. Bloated CLAUDE.md(肥大化指示の埋没)

| 項目 | 内容 |
| ---- | ---- |
| **現象** | CLAUDE.md に書いたルールが守られなくなる |
| **原因** | 200 行を超えると重要度の低い指示に埋もれる(#1 と同根) |
| **対策** | 「これを消したら Claude がミスるか?」を問い、答えが No なら削除。ルールはフックに昇格できないか検討する。詳細は `.claude/rules/` や skill 側に分離 |

### 19. Trust-then-verify gap(検証なしのコミット)

| 項目 | 内容 |
| ---- | ---- |
| **現象** | 「動くように見える」コードを承認してマージしたら、後で edge case で破綻 |
| **原因** | テストやスクリーンショットの提示なしに承認してしまう |
| **対策** | `/implementing-features` skill は TDD を徹底する。UI 変更は Playwright MCP でビジュアル確認。「検証手段がない変更は出さない」をフェーズゲートの基準に |

### 20. Infinite exploration(スコープ無限調査)

| 項目 | 内容 |
| ---- | ---- |
| **現象** | 「調査して」と振ったら 100 ファイル以上読み、context を食い尽くしてから何も結論が出ない |
| **原因** | 探索範囲を限定せずに subagent ではなく親セッションで実行している |
| **対策** | 調査は `explorer` subagent に委譲する(別 context で実行され、要約のみ親に戻る)。調査範囲は「3 ファイル以内」「特定ディレクトリ配下のみ」と必ず縛る |

### 21. コンパクト後のルール消失

| 項目 | 内容 |
| ---- | ---- |
| **現象** | 長時間セッションの途中からルールを守らなくなる。出力先や禁止事項を忘れる |
| **原因** | context のコンパクトで要約が作られ、CLAUDE.md 由来の細則が要約に残らない |
| **対策** | `PreCompact` で会話履歴を退避し、`PostCompact` でマーカーを置き、`UserPromptSubmit` で回収して中核ルールを再注入する(本テンプレートは実装済み)。`PostCompact` 自体は decision control を持たず文脈注入できない点に注意 |

### 22. `Write(path)` 権限ルールが無視される

| 項目 | 内容 |
| ---- | ---- |
| **現象** | `allowed-tools` に `Write(output/**)` と書いたのに毎回権限確認が出る。起動時に警告も出る |
| **原因** | ファイルパス権限は `Edit(path)` と `Read(path)` だけが参照される。`Write` / `NotebookEdit` / `Glob` / `MultiEdit` のパスルールは受理されるが一度も参照されない |
| **対策** | Write を許可したい場合も `Edit(output/**)` と書く。`Read(path)` の deny は Edit/Write も同時にブロックする |

### 23. auto mode で「確認したつもり」

| 項目 | 内容 |
| ---- | ---- |
| **現象** | Pro / Max / Team では auto mode が既定になり、権限プロンプトが出ないまま作業が進む。CLAUDE.md の「〜しない」だけに頼った境界が破られる |
| **原因** | auto mode は分類器モデルが各操作を審査する方式。プロンプト指示は長時間セッションやファイル経由のプロンプトインジェクションで抜けうる |
| **対策** | 絶対に通したくない操作は `permissions.deny`(分類器より前に効く)、毎回確認したい操作は `permissions.ask`(auto mode でも必ず確認)。フック(Layer 1)は常時有効。分類器は CLAUDE.md も読むので禁止事項は CLAUDE.md 本体にも書く(import 先の `AGENTS.md` を分類器が読むかは公式に記載が無い)。拒否履歴は `permission-denied-log.sh` が `testreport/denials/` に残す |

### 24. CLAUDE.md / output style の途中編集が効かない

| 項目 | 内容 |
| ---- | ---- |
| **現象** | セッション中に CLAUDE.md や output style を直したのに挙動が変わらない |
| **原因** | ルート / ユーザーの CLAUDE.md と output style はセッション開始時に 1 回だけ読まれる。途中の編集はキャッシュを壊さない代わりに反映もされない |
| **対策** | `/clear` か再起動で反映する。path-scoped rule と subdirectory の CLAUDE.md は初回 load 時点の内容が使われる |

### 25. project settings に `defaultMode: auto` / `autoMode` を書いても無視される

| 項目 | 内容 |
| ---- | ---- |
| **現象** | `.claude/settings.json` に `"permissions": {"defaultMode": "auto"}` や `autoMode.environment` を書いたのに効かない |
| **原因** | 公式仕様: `auto` / `bypassPermissions` の `defaultMode` と `autoMode` ブロックは project / local settings から読まれない(リポジトリ経由の権限昇格を防ぐため) |
| **対策** | 個人の `~/.claude/settings.json` か managed settings に書く。`/auto-mode-setup` が下書きを生成する。共有するのは `deny` / `ask` だけ(こちらは project settings で有効) |

### 26. 同名 skill が bundled skill を上書きする

| 項目 | 内容 |
| ---- | ---- |
| **現象** | `/code-review` を打つと同梱(bundled)の差分バグレビューではなく本テンプレートの skill が起動する(または逆を期待していた) |
| **原因** | project / user の skill は同名の bundled skill を上書きする。ただし bundled のエイリアス(`/review`)は上書きされない |
| **対策** | 意図的な上書きとして skill 側に明記する(本テンプレートは記載済み)。bundled 版の fresh-subagent バグ探しが欲しいときは `/review` |

### 27. Stop フックの無限ループ / 8 回で強制終了

| 項目 | 内容 |
| ---- | ---- |
| **現象** | Stop フックで「テストを回せ」と差し戻し続けた結果、同じ差し戻しが繰り返される、または 8 回目で Claude Code がターンを強制終了する |
| **原因** | Stop フックは差し戻しのたびに再発火する。`stop_hook_active: true` を見ずにブロックすると自分の差し戻しに反応し続ける。公式仕様で 8 回連続ブロック後は無視される |
| **対策** | `stop_hook_active` が true なら必ず通す(1 回だけ差し戻す)。`background_tasks` が空でないときも通す(完了ではなく待機中)。本テンプレートの `verify-gate.sh` はこの規約で実装済み |

### 28. skill の行頭 `@path` が起動のたびにファイルを丸ごと添付する

| 項目 | 内容 |
| ---- | ---- |
| **現象** | 「関連参照(必要に応じて load)」のつもりで SKILL.md の末尾に `@.claude/pitfalls.md` などを並べると、skill を起動するたびに全文が context に入り、後続ターンにも残り続ける |
| **原因** | 公式仕様: ローカル skill では本文中の `@` 参照が指すファイルが起動時に添付される。skill の内容は会話に残り、コンパクト後も skill ごとに最大 5,000 トークンまで再添付される |
| **対策** | 参照は「パス — 読む条件」の箇条書きにし、必要なときに Read させる。validator が SKILL.md の行頭 `@` を WARN で検出する |

### 29. skill が増えると description が落ちて自動発動しなくなる

| 項目 | 内容 |
| ---- | ---- |
| **現象** | skill を追加していくと、以前は自動で選ばれていた skill が選ばれなくなる |
| **原因** | skill 一覧の予算は context window の 1%(`skillListingBudgetFraction` 既定 0.01)。溢れると使用頻度の低い skill から description が落ちて名前だけになる。制約文や引数説明を description に書くと予算を浪費する |
| **対策** | description は「何をするか + いつ使うか」だけにし、目安は 300 字。制約は本文、引数は `argument-hint` に置く。一覧コストは `/doctor`、未使用 skill は `/skill-doctor` で確認する |

### 30. acceptEdits の subagent が範囲外に書き込む

| 項目 | 内容 |
| ---- | ---- |
| **現象** | 「docs/ だけ更新する」と本文に書いた agent が、確認なしでソースや設定を書き換える |
| **原因** | `permissionMode: acceptEdits` はファイル編集を自動承認する。本文の範囲制限は指示でしかなく、長い作業やプロンプトインジェクションで破られる |
| **対策** | frontmatter の `hooks.PreToolUse` に `scope-guard.sh <docs / output / tests>` を登録し、範囲外の Edit / Write を exit 2 で止める。本テンプレートは 3 agent に適用済み(workspace trust 後に有効) |

### 31. AGENTS.md が読まれない

| 項目 | 内容 |
| ---- | ---- |
| **現象** | 他のコーディングエージェント向けに整備した `AGENTS.md` の指示が効かない |
| **原因** | Claude Code が `AGENTS.md` を直接読むのは、作業ディレクトリとその上位に `CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md` が 1 つも無いときだけ。本テンプレートは `CLAUDE.md` を置くため、既存の `AGENTS.md` は読まれなくなる |
| **対策** | 本テンプレートはツール共通のルールを `AGENTS.md` に置き、`CLAUDE.md` の冒頭で `@AGENTS.md` を取り込む(内容は複製しない)。`AGENTS.md` には行頭 `@` を書かない(他のエージェントは import を解釈しない)。既存の `AGENTS.md` がある場合、`setup.sh` は上書きせずテンプレート版を `AGENTS.blueprint.md` として置き、統合を促す |

## 推奨セッション運用コマンド

| シーン | コマンド | 効果 |
| ------ | -------- | ---- |
| 別タスクへ移る | `/clear` | context を全リセット。最も強力な context 圧縮策 |
| 試行錯誤を巻き戻す | `/rewind` または `Esc Esc` | 失敗以前のチェックポイントへ会話・コードを戻す |
| 部分的に圧縮 | `/compact <focus>` | 特定観点のみ残して要約圧縮(履歴は保持) |
| ちょい質問 | `/btw <質問>` | 履歴に残らない側問い(オーバーレイ表示) |
| 並行作業を始める | `claude --continue` で別端末 | Writer / Reviewer 等の多セッション並走 |

## 今後の拡張候補(Out of Scope)

以下は現テンプレートに未実装だが、取り込み検討中:

- **`/bug-fix` 専用 skill**: Pimzino/claude-code-spec-workflow 風の Report→Analyze→Fix→Verify パイプライン
- **EARS 形式要件記述**: gotalab/cc-sdd 風の Kiro spec-driven を `/prd` に導入
- **`brief.md` 成果物**: セッション再開用の scope summary を Phase 0 成果物として追加
- **Scale-Adaptive チーム**: BMAD-METHOD 風に XS/S/M/L 規模で `TEAM_*.md` を分岐(現状固定)
- **`monitors/` / `bin/`**: 常駐 watcher と PATH 自動展開を plugin に同梱(2026 仕様)
- **EnterWorktree 標準化**: `/security-scan` / `/refactoring` 起動時の自動 worktree 化

> 既に取り込まれた機能(plugin 化 / learnings / constitution / `/brainstorm` / 新 hook 3 種 等)は
> ルート `README.md` の冒頭注記を参照。本ファイルは「失敗パターン集」が責務のため、
> 実装済み機能リストはここに置かない。
