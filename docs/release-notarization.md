# macOS の公証付き配布手順(Developer ID 署名 + 公証 + DMG)

> **状態**: 計画(未実装)。現行の配布はアドホック署名・未公証(`tauri.conf.json` の `signingIdentity: "-"`)。
> 本書の §4 を実装したら、この行と `docs/docs/project.md` のリリース節を更新する。
>
> **決定(2026-10-06)**: 個人名義の Developer ID で署名・公証し、公開 Releases で配る(社内利用で公証が必須のため)。
> Apple Developer Program は審査中。承認後に §2・§3・§7 を人間が行い、§4 を実装する。

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

## 1. Apple Developer Program に登録

- https://developer.apple.com/programs/ から登録する。年額 99 USD(日本の価格は Apple の表示に従う。改定されうる)
- **個人**で登録すると配布者名に本名が出る。**組織**で登録すると組織名が出るが、D-U-N-S 番号が必要
- 審査には数時間〜数日かかる

## 2. Developer ID Application 証明書

1. キーチェーンアクセスを開き、メニューの「証明書アシスタント」→「認証局に証明書を要求」で CSR をディスクに保存する
2. developer.apple.com → Certificates → **+** → **Developer ID Application** を選び、CSR をアップロードする(Account Holder 権限でしかできない)
3. `.cer` をダウンロードし、ダブルクリックでキーチェーンに入れる
4. 入ったか確認する:

   ```bash
   security find-identity -v -p codesigning
   # → "Developer ID Application: <名前> (<TEAMID>)" が出れば OK
   ```

5. CI 用に、キーチェーンからこの証明書を**秘密鍵ごと** `.p12` に書き出す(パスワードを付ける)。**`.p12` はリポジトリに入れない**

> 「Mac App Distribution」や「Apple Development」の証明書では App Store の外に配布できない。必ず **Developer ID** を選ぶ。

## 3. 公証用の認証情報(App Store Connect API キーを推奨)

1. App Store Connect → ユーザとアクセス → 統合 → **App Store Connect API** → チームキーを作る(ロールは Developer)
2. `AuthKey_<KEY_ID>.p8` をダウンロードする(**1 回しかダウンロードできない**)。**Key ID** と **Issuer ID** を控える
3. 手元のキーチェーンに保存する:

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

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <名前> (<TEAMID>)"
export APPLE_API_ISSUER=<ISSUER_ID>
export APPLE_API_KEY=<KEY_ID>
export APPLE_API_KEY_PATH=<path>/AuthKey_<KEY_ID>.p8

npm run dist:mac      # Tauri が app に署名(Hardened Runtime)→ 公証 → staple まで行う

dmg=release/Tadcap-<版>-arm64.dmg
codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$dmg"
xcrun notarytool submit "$dmg" --keychain-profile tadcap-notary --wait   # 数分かかる
xcrun stapler staple "$dmg"
```

公証が `Invalid` になったら、`xcrun notarytool log <submission-id> --keychain-profile tadcap-notary` で理由を確認する。よくある原因は次の 3 つ:

- タイムスタンプが無い(`--timestamp` を付けていない)
- Hardened Runtime が無効
- 署名されていないバイナリが混ざっている

## 6. 検証(完了の証拠にする)

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

| Secret | 中身 |
| ------ | ---- |
| `APPLE_CERTIFICATE` | `base64 -i cert.p12` の出力 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` のパスワード |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: … (TEAMID)` |
| `APPLE_API_ISSUER` / `APPLE_API_KEY` | Issuer ID / Key ID |
| `APPLE_API_KEY_P8` | `.p8` の中身(ジョブ内でファイルに書き出し、`APPLE_API_KEY_PATH` に渡す) |

`APPLE_CERTIFICATE` があると、Tauri が一時キーチェーンに証明書を読み込む。

**セキュリティ上の注意**: 現行の `release.yml` は「依存のコードを書込トークンの隣で動かさない」方針。署名用の Secrets を build ジョブに渡すと、npm / cargo の依存コードが Secrets と同じジョブで動く。対策は次のどちらか:

- **(推奨)GitHub Environment(例: `release`)を作り、Secrets をそこに置く**。タグの push だけに限定し、必要なら承認者を付ける
- ビルドと署名を別ジョブに分ける。Tauri の自動署名が使えないので、手で codesign する必要があり手間が増える

## 8. 付随して更新するもの

- README や紹介ページにある「警告が出たら右クリック→開く」といった回避手順の記述を削る
- `docs/docs/project.md` のリリース節を「Developer ID 署名 + 公証」に更新する
- 期限を管理する: Developer ID 証明書は 5 年で失効する。API キーはいつでも取り消せる。Program の会費は毎年更新する
