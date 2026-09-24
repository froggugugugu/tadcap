# T17 — セキュリティ・Capabilities 最終化 レビュー結果

> 対応: ARCH §12(セキュリティ設計)/ `output/tasks/TASK_tadcap_mvp.md` T17
> 実施日: 2026-09-24

## 1. スコープ

1. `capabilities/default.json` の棚卸し(実際に呼ぶコマンド/プラグインAPIとの対応表、過不足の是正)
2. `assetProtocol.scope` のパス照合(正規化・シンボリックリンク)の公式仕様確認
3. `tauri.conf.json` の CSP 最小設定
4. 変更後のビルド・テスト確認

## 2. Capabilities 棚卸し(対応表)

フロントエンド(`src/**`)が実際に呼ぶ IPC 呼び出し・プラグイン JS API と、Rust 側のネイティブ呼び出し(IPC非経由)を全数確認した。

| 呼び出し | 呼び出し元 | 種別 | 必要な permission | 判定 |
| -------- | ---------- | ---- | ------------------ | ---- |
| `invoke("capture_screen")` | `src/ipc/capture.ts` | 自前コマンド(プラグイン非経由) | 不要 | 現状維持 |
| `invoke("check_screen_recording_permission")` | `src/ipc/permissions.ts` | 自前コマンド | 不要 | 現状維持 |
| `invoke("open_screen_recording_settings")` | `src/ipc/permissions.ts` | 自前コマンド(内部で `OpenerExt::open_url` をRustネイティブ呼び出し) | 不要 | 現状維持 |
| `invoke("write_image_fallback", rawBody, {headers})` | `src/ipc/clipboard.ts` | 自前コマンド(生ボディ) | 不要 | 現状維持 |
| `invoke("greet")` | 未使用(スキャフォールド由来、呼び出しコードなし) | 自前コマンド | 不要 | 現状維持(将来削除候補、本タスクのスコープ外) |
| `listen("capture://completed")` / `listen("capture://error")` | `src/ipc/capture.ts` | core (`@tauri-apps/api/event`) | `core:event:allow-listen`/`allow-unlisten`(`core:default`に含む) | `core:default` で充足 |
| `convertFileSrc(sourcePath)` | `src/main.ts` | core(URL文字列変換のみ、IPC非経由) | 不要(IPCを呼ばないユーティリティ関数) | 該当なし |
| `Image.new(rgba, w, h)` / `image.close()` | `src/ipc/clipboard.ts` | core (`@tauri-apps/api/image`) | `core:image:allow-new`、`core:resources:allow-close`(いずれも`core:default`に含む) | `core:default` で充足 |
| `writeImage(image)` | `src/ipc/clipboard.ts` | `clipboard-manager` プラグイン | `clipboard-manager:allow-write-image` | 既存どおり最小(変更なし) |
| `openUrl()` / `openPath()`(`@tauri-apps/plugin-opener` JS API) | **未使用**(`src/**` に import なし。grep で確認) | `opener` プラグイン | 不要 | **`opener:default` を削除**(§3参照) |
| `app.opener().open_url(...)`(`OpenerExt`) | `src-tauri/src/commands.rs::open_screen_recording_settings` | Rustネイティブ(拡張トレイト) | 不要(IPC非経由) | T08判断を再確認(§4) |
| `app.global_shortcut().register(...)`(`GlobalShortcutExt`) | `src-tauri/src/shortcuts.rs` | Rustネイティブ | 不要(IPC非経由) | T16判断を再確認(§4) |
| `TrayIconBuilder`/`Menu`/`MenuItem` | `src-tauri/src/tray.rs` | Rustネイティブ(`tray-icon` Cargo feature) | 不要(IPC非経由) | T15判断を再確認(§4) |
| `app.handle().set_activation_policy(...)` | `src-tauri/src/lib.rs` | Rustネイティブ | 不要 | 現状維持 |
| `asset://`(`<img src>` 経由のGET) | `src/main.ts`(`convertFileSrc`結果をimgへ設定) | asset protocol ハンドラ(webviewからのGET、`invoke()`ではない) | `app.security.assetProtocol.scope`(capabilitiesではなく`tauri.conf.json`) | §5で実体パス補強 |

grep 確認根拠: `src/**/*.ts` 全19ファイルを読み、`@tauri-apps/plugin-opener`・`@tauri-apps/plugin-global-shortcut`・`@tauri-apps/api/window`・`@tauri-apps/api/app`・`@tauri-apps/api/menu`・`@tauri-apps/api/webview` の import が一切無いことを確認した(`package.json` の `dependencies` には `@tauri-apps/plugin-opener` が残っているが、これは Rust 側 `OpenerExt` が使う Cargo クレートとは独立の JS パッケージであり、フロントエンドから未使用)。

## 3. Capabilities 変更(before/after)

`src-tauri/capabilities/default.json`

```diff
   "permissions": [
     "core:default",
-    "opener:default",
     {
       "identifier": "opener:allow-open-url",
       "allow": [
         {
           "url": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
         }
       ]
     },
     "clipboard-manager:allow-write-image"
   ]
```

### 判断根拠

- ローカルに生成済みの `src-tauri/gen/schemas/acl-manifests.json`(このプロジェクトの実際のプラグインバージョンから Tauri CLI が生成した ACL マニフェスト、ネットワーク不要で参照可能)を読み、`opener:default` の実体を確認した:
  `"permissions":["allow-open-url","allow-reveal-item-in-dir","allow-default-urls"]`。
  `allow-default-urls` は `mailto:`/`tel:`/`https://`/`http://` を**無制限**に許可するスコープであり、`allow-reveal-item-in-dir` も含む。
- フロントエンドは `@tauri-apps/plugin-opener` の JS API を一切呼ばない(§2 grep確認)。`open_screen_recording_settings` コマンドは Rust 側で `OpenerExt::open_url()` を直接呼ぶのみで、これは IPC を経由しない(§4 で公式ドキュメント/ソースにより再確認)。
- したがって `opener:default` は使われている経路が無いまま攻撃面(コンパイル後のバイナリに対し、webview 内で任意スクリプトが実行できた場合に `invoke("plugin:opener|open_url", {url: "https://..."})` を直接叩けば任意の https/http/mailto/tel URL を開けてしまう)だけを広げていた。
- 既存の T08 決定(project-config.md §11 旧エントリ)は「将来フロントエンドが `openUrl()` を直接呼ぶ場合の多層防御として維持する」という理由で `opener:default` を意図的に残していたが、AGENTS.md の開発原則「将来のための抽象化・フラグは作らない(YAGNI)」に照らすと、未使用の広い許可を先取りで残すことは Capabilities 最小化の趣旨(ARCH §12)と矛盾する。
- 一方 `opener:allow-open-url`(固定URL1件にスコープ限定)は、
  1. ACL マニフェスト上 `allow-open-url` は**独立した permission**であり(`opener:default` の有無に関わらず単独で `open_url` コマンドを許可できる)、削除しても機能低下がない、
  2. スコープが実際に使う唯一の固定URL文字列に完全一致しており「広すぎる」要素が無い、
  3. T08 の多層防御という判断そのものは(将来フロントエンドが同種の呼び出しを追加する際の保険として)合理的、
  という理由で維持した。
- `global-shortcut:*` は元々未追加(T16の判断どおり、正しい)。`clipboard-manager:allow-write-image` は実使用と過不足なく一致しており変更不要。`core:default` は Tauri が「危険でない」と判断した `core:app`/`core:event`/`core:image`/`core:menu`/`core:path`/`core:resources`/`core:tray`/`core:webview`/`core:window` の各 `default` permission-set の集合であり(`acl-manifests.json`で内容を確認)、本アプリが使う `core:event:allow-listen/unlisten`・`core:image:allow-new`・`core:resources:allow-close` はここに含まれる。個別 sub-permission への手動置き換えは Tauri 本体が既にキュレートした安全な既定値を独自に再実装することになり、過剰設計(YAGNI違反)と判断し現状維持とした。

### 自前コマンドが permission 定義なしで動く理由(公式ドキュメント確認)

- `https://v2.tauri.app/security/permissions/` は permission の説明を一貫して「プラグイン開発者」「アプリ開発者が既存プラグインの permission を拡張する」観点で記述しており(ステップバイステップガイドのタイトルも `using-plugin-permissions`)、自前コマンドへの permission 定義はオプトイン(`src-tauri/permissions/*.toml` を用意した場合のみ)という扱いになっている。
- `tauri-build` のソース(`crates/tauri-build/src/acl.rs::app_manifest_permissions`)を確認したところ、`src-tauri/permissions/` が存在しない(=`default_permission`/`permission_sets`/`permissions` がいずれも空)場合、`has_app_manifest` が `false` になり、アプリ自身の ACL マニフェスト(`APP_ACL_KEY`)が `acl_manifests` に登録されない。
- 本リポジトリには `src-tauri/permissions/` が存在せず、`gen/schemas/acl-manifests.json` にもアプリ自身の名前空間は存在しない(`core`/`core:*`/`opener`/`clipboard-manager`/`global-shortcut` のみ)。
- 実際に `capture_screen`/`check_screen_recording_permission`/`open_screen_recording_settings`/`write_image_fallback`(いずれも permission 未定義)は T06〜T16 で実装・テスト済みで動作しており(スキャフォールド由来の `greet` も同様)、これは Tauri v2 の標準スキャフォールド(`create-tauri-app`)が生成する `capabilities/default.json`(`core:default` のみ)でも `greet` コマンドがそのまま呼べる一般的な挙動と一致する。
- 以上より、自前コマンドに対する permission 定義を追加しない現状の実装は Tauri v2 の標準的な使い方であり、対応漏れではないと判断した。

## 4. Rustネイティブ呼び出しは capabilities 不要(T08/T15/T16 判断の再確認)

公式ドキュメント・ソースで以下を再確認した(結論はいずれも既存判断のとおりで変更なし):

- **opener**: `https://v2.tauri.app/plugin/opener/` の Usage 節は JS(`openUrl()`)と Rust(`app.opener().open_url()`, `OpenerExt`)の2経路を明記しており、capabilities の説明("By default all potentially dangerous plugin commands ... You must modify the permissions in your capabilities") は JS から `invoke()` される**コマンド**(=ACL 経由)にのみ適用される。`OpenerExt` は `App`/`AppHandle`/`WebviewWindow` 等への直接の拡張トレイトメソッドであり、`docs.rs` の型シグネチャどおりコマンドディスパッチ(`RuntimeAuthority::resolve_access`)を経由しない。
- **global-shortcut**: `crates/tauri-utils` の ACL 解決ロジック上も、Rust 側で直接呼ぶ `GlobalShortcutExt::register()`はコマンド名を介さないため対象外(`shortcuts.rs` の既存コメントのとおり)。
- **tray**: `tray-icon` Cargo feature 経由の `TrayIconBuilder`/`Menu`/`MenuItem` はいずれも Rust API であり、JS 側から呼ぶ経路(`@tauri-apps/api/tray`等)を使っていないため対象外。

## 5. assetProtocol scope の確認結果(公式ソース・実機で検証、要修正)

### 5.1 仕組みの確認

Tauri 公式ソース(`crates/tauri/src/scope/fs.rs`)を読み、以下を確認した:

- `Scope::is_allowed(path)`(asset protocol のリクエストパス照合、`crates/tauri/src/protocol/asset.rs::get_response` が呼ぶ)は、リクエストパスを `try_resolve_symlink_and_canonicalize()` に通してから照合する。この関数は対象が存在すれば `std::fs::canonicalize()`(=realpath、途中のシンボリックリンクも含めて全解決)を呼ぶ。
- 一方 `Scope::new()`(`tauri.conf.json` の静的 `scope` 配列から構築される側)は `manager.path().parse(path)` で `$TEMP` 等の変数を文字列展開するのみで、**canonicalize は行わない**(`push_pattern`/`escaped_pattern` はエスケープのみ)。
- `$TEMP` は Tauri の `BaseDirectory::Temp` = `std::env::temp_dir()` であり、これも canonicalize しない生の値。

### 5.2 実機での検証

このマシン(開発機、macOS Darwin 25.5.0)で以下を確認した:

```
$ readlink /var
private/var
$ echo $TMPDIR
/var/folders/s5/cxpkdf2x1pd32yzzswzcc0cr0000gn/T/
$ python3 -c "import os; print(os.path.realpath('$TMPDIR/tadcap-captures/test-t17.png'))"
/private/var/folders/s5/cxpkdf2x1pd32yzzswzcc0cr0000gn/T/tadcap-captures/test-t17.png
```

`/var` が `/private/var` へのシンボリックリンクであるため、`capture::tempfile::capture_dir()`(= `std::env::temp_dir().join("tadcap-captures")`)が返す非canonicalizeパスと、`Scope::is_allowed()` が内部で canonicalize した実パスが**一致しない**。静的スコープ `$TEMP/tadcap-captures/*` だけでは、実際に `screencapture` が書き出した画像を asset protocol 経由で読み込む際に `403`(scope拒否)になるおそれがある。

### 5.3 修正内容

`src-tauri/src/lib.rs::run()` の `setup()` 冒頭で、キャプチャ用ディレクトリを作成した上で `canonicalize()` し、`app.asset_protocol_scope().allow_directory(&canonical, false)`(`tauri::Manager` トレイト、`#[cfg(feature = "protocol-asset")]`、Cargo.toml で既に有効化済み)により実体パスを動的に追加登録するようにした。静的スコープ(`tauri.conf.json` の `$TEMP/tadcap-captures/*`)はシンボリックリンクの無い環境向けの安全網として維持する。自アプリのキャプチャ専用ディレクトリ1つのみを追加するため、スコープを広げていない(`recursive: false`)。

回帰確認として `src-tauri/src/capture/tempfile.rs` に `capture_dirは作成すればcanonicalizeできる` テストを追加した(ディレクトリを作成すれば必ず canonicalize でき、末尾セグメントが保たれることを検証。macOS特有の symlink 差分自体は環境依存のためアサーション対象にしていない)。

## 6. CSP 設定

`tauri.conf.json` を `"csp": null` から以下へ変更した:

```json
"csp": {
  "default-src": "'self'",
  "connect-src": "'self' ipc: http://ipc.localhost",
  "img-src": "'self' asset: http://asset.localhost blob:",
  "style-src": "'self'"
}
```

### 根拠

- `connect-src` に `ipc: http://ipc.localhost` を追加: Tauri 公式サンプル(`v2.tauri.app/security/csp/`)が同じ値を推奨しており、`invoke()`(生ボディの `write_image_fallback` を含む)がこの経路を使う。`'self'` を残しているのは Vite dev サーバー(`npm run tauri dev`)の HMR WebSocket が同一オリジンへ接続するため(`vite.config.ts` の `server.hmr` は `TAURI_DEV_HOST` 未設定時デフォルトで同一オリジン)。`connect-src` を明示すると `default-src` へのフォールバックが効かなくなるため、HMR を壊さないよう明示的に `'self'` を含めた。
- `img-src` に `asset: http://asset.localhost blob:` を追加: `asset:`/`http://asset.localhost` は `convertFileSrc()` の公式ドキュメント例(`v2.tauri.app` の `core.convertFileSrc()` リファレンス)がそのまま `assetProtocol` 併用時の推奨値として示している(macOS/Linux は `asset://`、Windows は `http://asset.localhost` の形式を使うため両方含める)。`blob:` はセッション内履歴(`src/canvas/render.ts::captureHistoryAssets()` が `URL.createObjectURL()` で生成する ObjectURL)をサムネイル `<img>`/再読込用 `<img>` に使うため必須。`data:` は本アプリで一切使用していない(dataURLを生成する箇所が無い)ため含めていない(最小化)。
- `style-src 'self'`: `index.html`/`src/**` を確認した結果、`style=""` 属性・`<style>` タグ・`el.style.cssText` 等の**インラインスタイル代入は一切無い**(`src/styles.css` を `<link rel="stylesheet">` で外部読込するのみ)。`src/ui/toolbar.ts` はアイコン用に `button.innerHTML = "<svg>...</svg>"` を使うが、これは CSS の `style-src` ではなく DOM 構築であり、埋め込み SVG に `<script>`/イベントハンドラ属性を含まないため CSP 上の懸念はない。よって `'unsafe-inline'` は付与しなかった。
- `script-src` は明示せず `default-src 'self'` のフォールバックに委ねた: 外部CDNスクリプト・`eval`・WebAssembly を一切使用しないため(公式ドキュメントの「WASM を使うなら `'wasm-unsafe-eval'` を追加」という注記は本アプリには非該当)。Tauri は「コンパイル時に自アプリのバンドル済みコード・アセットへ nonce/hash を自動付与する」ため(公式ドキュメント記載)、`withGlobalTauri: true` の初期化スクリプトも自動的にカバーされる。
- `font-src` は設定せず `default-src` に委ねた: `-apple-system` 等のシステムフォントのみを使用し、`@font-face`/Webフォントの読み込みが無いため。

### 既知の限界

- `dangerousDisableAssetCspModification` は既定(`false`)のまま変更していない。Tauri が自動で nonce/hash を注入する挙動を無効化していない。
- Vite dev のみで発生しうる CSP 関連の副作用(HMR オーバーレイの内部実装等)は自動テストで検証できないため、§8 の手動確認チェックリストに回した。

## 7. 変更ファイル一覧

| ファイル | 変更内容 |
| -------- | -------- |
| `src-tauri/capabilities/default.json` | `opener:default` を削除(`opener:allow-open-url`・`core:default`・`clipboard-manager:allow-write-image` は維持) |
| `src-tauri/tauri.conf.json` | `security.csp` を `null` から最小 CSP オブジェクトへ変更(`assetProtocol.scope` は変更なし) |
| `src-tauri/src/lib.rs` | `use tauri::Manager;` 追加。`setup()` 冒頭でキャプチャ用ディレクトリを canonicalize し `asset_protocol_scope().allow_directory()` へ動的登録する処理を追加 |
| `src-tauri/src/capture/mod.rs` | `capture_dir` を `pub use` で再エクスポート(`lib.rs` から参照するため) |
| `src-tauri/src/capture/tempfile.rs` | 回帰テスト `capture_dirは作成すればcanonicalizeできる` を追加 |
| `project-config.md` | §11(既知の落とし穴)に2行追加(assetProtocol scope のsymlink問題、`opener:default`削除の経緯) |
| `docs/docs/development-patterns.md` | §8に1行追加・既存1行更新(opener関連)、§9.7として新規パターンを追記 |
| `output/reports/security/T17_capabilities_review.md` | 本ファイル(新規) |

## 8. 手動確認チェックリストへ回した項目

E2E(`npm run e2e`)は Vite dev サーバー + Tauri API モック(`window.__TAURI__` 相当をスタブ)で動作するため、**実際の CSP 適用・asset protocol・Tauriネイティブ機能の検証にはならない**(ARCH §10.2 の既定方針どおり)。以下は実機(`npm run tauri dev` および `npm run tauri build` 後のアプリ)での手動確認が必要:

- [ ] `npm run tauri dev` でキャプチャを実行し、`screencapture` が生成した画像が Canvas に表示される(asset protocol scope の動的登録が機能し、CSP `img-src` でブロックされないこと。開発者ツールのコンソールに CSP 違反ログが出ないこと)
- [ ] セッション内履歴サイドバーのサムネイル・再読込用画像(`blob:` ObjectURL)が表示される(CSP `img-src: blob:` の確認)
- [ ] 「クリップボードにコピー」(`writeImage()` 主経路、`write_image_fallback` フォールバック経路の両方)が CSP 適用下で成功する(`connect-src: ipc:`/`http://ipc.localhost` の確認)
- [ ] 画面収録権限未許可時の案内バナー→「システム設定を開く」ボタンが機能する(`OpenerExt::open_url` 経由、capabilities変更の影響が無いことの確認)
- [ ] グローバルショートカット(Cmd+Shift+2)・トレイメニュー3項目が CSP/capabilities 変更後も従来どおり動作する
- [ ] `npm run dev`(Vite dev サーバー単体、HMR)で編集→保存した際に HMR が壊れず反映される(`connect-src 'self'` の確認)
- [ ] `npm run tauri build` でビルドした本番バイナリでも上記が全て成立する(dev専用の緩和が無いか、`devCsp` 未設定=dev/prod同一CSPであることの確認)

## 9. 参照した公式ドキュメント・ソース

- `https://v2.tauri.app/security/csp/`(CSP設定・nonce/hash自動付与・公式サンプル)
- `https://v2.tauri.app/reference/config/`(`SecurityConfig`/`AssetProtocolConfig`/`FsScope`/`Capability`等の型定義)
- `https://v2.tauri.app/security/capabilities/`・`https://v2.tauri.app/security/permissions/`(capabilities/permissionsの概念)
- `https://v2.tauri.app/plugin/opener/`・`https://docs.rs/tauri-plugin-opener/latest/tauri_plugin_opener/trait.OpenerExt.html`(opener の JS/Rust 2経路)
- `https://v2.tauri.app/develop/calling-rust/#accessing-raw-request`(生ボディ、既存実装の再確認)
- `https://v2.tauri.app/reference/javascript/api/namespacecore/#convertfilesrc`(`convertFileSrc()` と CSP/scope の公式サンプル)
- `https://github.com/tauri-apps/tauri`(`crates/tauri/src/scope/fs.rs`, `crates/tauri/src/app.rs`, `crates/tauri/src/manager/mod.rs`, `crates/tauri/src/ipc/authority.rs`, `crates/tauri-utils/src/acl/resolved.rs`, `crates/tauri-build/src/acl.rs`)のソースコード直接確認(dev ブランチ)
- `src-tauri/gen/schemas/acl-manifests.json`(このプロジェクトの実バージョンから生成されたローカルACLマニフェスト。`core`/`opener`/`clipboard-manager`/`global-shortcut` 各 permission の内容確認に使用)
- 実機コマンド(`readlink /var`、`$TMPDIR`、`python3 os.path.realpath`)によるsymlink挙動の直接検証
