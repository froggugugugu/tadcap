# macOS の公証付き配布手順(Developer ID 署名 + 公証 + DMG)

> **状態(2026-10-09)**: §2〜§8 実施済み。v0.4.0 から公証付きで配布(CI の初回は、Secret `APPLE_SIGNING_IDENTITY` の値違いと中間証明書の二重読み込みで 2 回失敗し、タグを付け直した)。
>
> **決定(2026-10-06)**: 個人名義の Developer ID で署名・公証し、公開 Releases で配る(社内利用で公証が必須のため)。

## 0. 全体の流れ

```text
1. Apple Developer Program に登録                         (人間)
2. Developer ID Application 証明書を作る                  (人間)
3. 公証用の認証情報を作る(App Store Connect API キー)    (人間)
4. リポジトリを変更する(署名 ID の扱い・DMG の公証・検証) (AI 可)
5. 手元でビルド → 公証 → 検証
6. CI に載せる(GitHub Secrets / Environment)
7. 配布文書を更新する
```

各手順の先頭に、どこで操作するかを書く:

- **【Web】**: ブラウザで開くサイト。URL を併記する(Apple ID でサインイン)
- **【Mac アプリ】**: Mac に入っているアプリ。Spotlight(⌘ + Space)で名前を入れて開く
- **【ターミナル】**: ターミナルで実行するコマンド

## 1. Apple Developer Program に登録

- 【Web】https://developer.apple.com/programs/ から登録する。年額 99 USD(日本の価格は Apple の表示に従う。改定されうる)
- **個人**で登録すると配布者名に本名が出る。**組織**で登録すると組織名が出るが、D-U-N-S 番号が必要
- 審査には数時間〜数日かかる

## 2. Developer ID Application 証明書

1. 【Mac アプリ】「キーチェーンアクセス」を開き、メニューバーの「キーチェーンアクセス」→「証明書アシスタント」→「認証局に証明書を要求」を選ぶ。
   メールアドレスと通称(名前)を入れ、「ディスクに保存」を選んで CSR(`CertificateSigningRequest.certSigningRequest`)を保存する。このとき秘密鍵がログインキーチェーンに作られる
2. 【Web】https://developer.apple.com/account/resources/certificates/add を開き、**Developer ID Application** を選んで CSR をアップロードする(Account Holder 権限でしかできない)
   - 選択肢が多数並ぶが、選ぶのは Software 欄の **Developer ID Application** だけ。**Developer ID Installer** は `.pkg` 用なので不要(配るのは DMG / zip)
   - 次の画面で中間証明書を聞かれたら **G2 Sub-CA (Xcode 11.4.1 or later)** を選ぶ(Previous Sub-CA は古い環境向け)
   - Developer ID の項目が押せないときは、Account Holder ではないか、Program の審査が終わっていない
   - 作れる枚数に上限があるので、試しに何枚も作らない
3. 【Web】同じ画面で `developerID_application.cer` をダウンロードし、Finder でダブルクリックしてキーチェーンに入れる(追加先は「ログイン」。信頼設定は変えない)
4. 【ターミナル】入ったか確認する:

   ```bash
   security find-identity -v -p codesigning
   # → "Developer ID Application: <名前> (<TEAMID>)" が出れば OK
   ```

   `0 valid identities found` のときは次を確認する:

   - **証明書が入っていない**: ダブルクリックで出るダイアログを閉じると追加されないことがある。コマンドで入れる:
     `security import ~/Downloads/developerID_application.cer -k ~/Library/Keychains/login.keychain-db`
   - **中間証明書(Developer ID G2)が無い**: 証明書が「信頼されていません」になり、署名に使えない。取得して入れる(`sudo` は不要。1 行ずつ実行する):

     ```bash
     curl -fsSLo ~/DeveloperIDG2CA.cer https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
     security import ~/DeveloperIDG2CA.cer -k ~/Library/Keychains/login.keychain-db
     ```

   - **秘密鍵が無い**: CSR を作った Mac・ユーザーと別の環境で入れている。CSR を作った環境で入れ直す
   - **`developerID_installer.cer` を入れている**: それは `.pkg` 用。Developer ID Application で作り直す

5. 【Mac アプリ】CI 用に、キーチェーンアクセスでこの証明書を**秘密鍵ごと** `.p12` に書き出す。
   左で「ログイン」→ 上のタブ「自分の証明書」→ **Developer ID Application: …** を右クリック →「書き出す」→ フォーマット「個人情報交換(.p12)」で保存し、パスワードを付ける。
   **`.p12` とパスワードはリポジトリに入れない**(パスワードマネージャー等に保管)

> 「Mac App Distribution」や「Apple Development」の証明書では App Store の外に配布できない。必ず **Developer ID** を選ぶ。

## 3. 公証用の認証情報(App Store Connect API キーを推奨)

App Store Connect は Web サイト(https://appstoreconnect.apple.com/)。Mac / iPhone の同名アプリではない。

1. 【Web】https://appstoreconnect.apple.com/access/integrations/api を開く(画面上は「ユーザとアクセス」→「統合」→「App Store Connect API」)。
   「チームキー」タブで **+** を押し、名前(例: `tadcap-notary`)とアクセス(ロール)**Developer** を選んで生成する。
   初回は「アクセスをリクエスト」が出るので、Account Holder が承認する
2. 【Web】生成したキーの行から `AuthKey_<KEY_ID>.p8` をダウンロードする(**1 回しかダウンロードできない**)。
   同じ画面の **キー ID**(行ごと)と、ページ上部の **Issuer ID** を控える
3. 【ターミナル】手元のキーチェーンに保存する:

   ```bash
   xcrun notarytool store-credentials tadcap-notary \
     --key <path>/AuthKey_<KEY_ID>.p8 --key-id <KEY_ID> --issuer <ISSUER_ID>
   ```

Apple ID とアプリ用パスワードの組でも公証できる(`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`)。ただ、取り消しや権限の絞りやすさで API キーのほうが扱いやすい。

## 4. リポジトリの変更

| 対象 | 変更内容 |
| ---- | -------- |
| `src-tauri/tauri.conf.json` | `bundle.macOS.signingIdentity: "-"` を削除し、署名 ID は環境変数 `APPLE_SIGNING_IDENTITY` で渡す(チーム名や ID をリポジトリに書かない) |
| `scripts/package-mac.sh` | `APPLE_SIGNING_IDENTITY` が無いときは `-`(アドホック)にする。署名 ID があるときは、ビルド後に **DMG に署名 → 公証 → staple** を行う |
| `.github/workflows/release.yml` | 署名・公証の Secrets を渡す。検証に `spctl` / `stapler validate` を足す。先頭の「not notarized」というコメントを直す |
| `scripts/install.sh` | quarantine の削除は公証後は不要だが、害はないので残してよい(コメントだけ直す) |

**DMG を別に公証する理由**: Tauri は環境変数があると `.app` に署名・公証・staple まで行う。ただ、DMG 自体が公証されるかは未確認【仮定】なので、DMG を明示的に公証して staple する。DMG を公証すると中の app も審査される。zip には staple できないが、`package-mac.sh` は staple 済みの `.app` を zip にするので問題ない。

## 5. 手元でのビルドと公証

【ターミナル】リポジトリのルートで実行する:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <名前> (<TEAMID>)"
export APPLE_API_ISSUER=<ISSUER_ID>
export APPLE_API_KEY=<KEY_ID>
export APPLE_API_KEY_PATH=<path>/AuthKey_<KEY_ID>.p8

npm run dist:mac
```

`scripts/package-mac.sh` が次をまとめて行う(公証は 2 回あり、それぞれ数分かかる):

1. Tauri が app に署名(Hardened Runtime)→ 公証 → staple し、DMG を作る
2. DMG に署名 → 公証 → staple
3. `stapler validate` と `spctl` で DMG と app が受け入れられるか確認する(失敗したら止まる)

`APPLE_SIGNING_IDENTITY` が無ければ、従来どおりアドホック署名・未公証で作る。署名 ID があるのに `APPLE_API_*` が欠けていると、ビルド前に止まる。
Tauri はキーチェーンのプロファイル(`tadcap-notary`)を使えないので、公証には `.p8` のパスを渡す。

公証が `Invalid` になったら、`xcrun notarytool log <submission-id> --keychain-profile tadcap-notary` で理由を確認する。よくある原因は次の 3 つ:

- タイムスタンプが無い(`--timestamp` を付けていない)
- Hardened Runtime が無効
- 署名されていないバイナリが混ざっている

## 6. 検証(完了の証拠にする)

【ターミナル】

```bash
spctl -a -vvv -t install "$dmg"          # → accepted / source=Notarized Developer ID
xcrun stapler validate "$dmg"            # → The validate action worked!

mnt="$(mktemp -d)"
hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg"
codesign --verify --deep --strict --verbose=2 "$mnt/Tadcap.app"
spctl -a -vvv "$mnt/Tadcap.app"          # → source=Notarized Developer ID
hdiutil detach "$mnt"
```

最後に、**ブラウザで DMG をダウンロードして実際に開く**(別の Mac か別のユーザーで試すのが理想)。「インターネットからダウンロードされました。開きますか?」だけが出て、「開発元を確認できません」や「壊れています」が出なければ成功。

Hardened Runtime を有効にすると、起動時や画面キャプチャのときに落ちることがある。そのときは entitlements(`bundle.macOS.entitlements`)を追加する。画面収録の権限は TCC の許可なので、通常 entitlements は要らない。

## 7. CI(GitHub Secrets)

【Web】Environment `release` を作り、その Environment secrets に下の 6 つを入れる(`release.yml` の build ジョブは `environment: release` を前提にしている):

1. https://github.com/froggugugugu/tadcap/settings/environments → **New environment** → 名前 `release`
2. 「Deployment branches and tags」を **Selected branches and tags** にし、タグのパターン `v*` だけを許可する
3. (任意)「Required reviewers」に自分を入れると、リリースのたびに承認してから Secrets が使われる
4. 同じ画面の「Environment secrets」で **Add environment secret** を押し、下表を 1 つずつ登録する
5. https://github.com/froggugugugu/tadcap/settings/rules でタグ用の ruleset を作り、`v*` タグの作成・更新・削除を自分だけに制限する(タグは任意のコミットに打てるため、Environment の制限だけでは書込権限のある人が Secrets を読めてしまう)

| Secret | 中身 |
| ------ | ---- |
| `APPLE_CERTIFICATE` | 【ターミナル】`base64 -i <書き出した .p12>` の出力 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` のパスワード |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: … (TEAMID)` |
| `APPLE_API_ISSUER` / `APPLE_API_KEY` | Issuer ID / Key ID(`AuthKey_<KEY_ID>.p8` の `<KEY_ID>`) |
| `APPLE_API_KEY_P8` | `.p8` の中身(ジョブ内でファイルに書き出し、`APPLE_API_KEY_PATH` に渡す) |

`release.yml` の流れ:

1. **Signing keychain**: `APPLE_CERTIFICATE` を使い捨てのキーチェーンに読み込み、検索リストに加える。証明書とそのパスワードはこのステップにだけ渡し、`.p12` は読み込んだら消す。Tauri 自身の `APPLE_CERTIFICATE` 読み込みは使わない(app と DMG を同じキーチェーンで署名するため)
2. **Package, sign and notarize**: 署名 ID と API キーだけを渡して `npm run dist:mac` を実行する
3. 検証: DMG と中の app が `source=Notarized Developer ID` でなければ失敗する(Secrets が欠けてアドホック署名になったときも失敗する)
4. キーチェーンを消す

**残るリスク**: Tauri はビルドの途中で app に署名・公証するため、2 の間は `.p8` ファイルとロック解除済みのキーチェーンがあり、npm / cargo の依存コード(`build.rs` など)からも使える。
これは「ビルドと署名を別ジョブに分け、手で codesign / 公証する」構成でしか避けられず、手間が大きいので採らない。代わりに上の Environment の制限・タグの ruleset・(任意で)承認者で、Secrets が使われる場面を限定する。漏えいが疑われたら、API キーは App Store Connect で取り消し、証明書は developer.apple.com で revoke する。

## 8. 付随して更新するもの

- README や紹介ページにある「警告が出たら右クリック→開く」といった回避手順の記述を削る
- `docs/docs/project.md` のリリース節を「Developer ID 署名 + 公証」に更新する
- 期限を管理する: Developer ID 証明書は 5 年で失効する。API キーはいつでも取り消せる。Program の会費は毎年更新する
