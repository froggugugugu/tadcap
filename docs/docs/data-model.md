# データモデル

> **これはテンプレートです。** セットアップ直後は空の状態です。
> 以下のいずれかの方法で内容が生成されます:
> - `/implementing-features` スキルでスキーマ実装時に自動生成
> - PJMチームのPhase 4で自動生成
>
> **生成方法**: AIがコードベースのZodスキーマ定義から自動生成する。
> `project-config.md` セクション5（データ永続化）を参照し、永続化方針との整合性を保つ。
> スキーマ変更時は実装と同期してAIが更新する。

## スキーマ配置

<!-- 例: src/shared/types/ -->
<!-- 例: フォームバリデーションは src/infrastructure/validation/schemas.ts -->

バリデーションライブラリ(Zod等)は未導入(NFR-003)。型定義は各モジュールのTS interfaceとして定義する
(`src-tauri/src/capture/mod.rs` の `CaptureResult` に対応するフロント側の型は `src/ipc/capture.ts`)。

## スキーマ詳細

<!-- AIがコードベースのZodスキーマ定義から自動生成・展開する -->

### CaptureResult(`src/ipc/capture.ts`、T07)

Rust `capture::CaptureResult`(`camelCase` でシリアライズ)に対応するフロント側の型。PRD §5 `Capture` モデルの実体。

| フィールド | 型 | 備考 |
| ---------- | -- | ---- |
| `id` | `string` | 一時ファイル名(拡張子除く)をそのまま識別子に流用(`commands.rs::id_from_path`) |
| `sourcePath` | `string` | 一時ファイルの絶対パス。`read_capture_image` コマンドに渡してバイト列を受け取り、ObjectURL にしてCanvas表示に使う(asset URLは使わない、実機不具合②〜⑤) |
| `kind` | `"range"` | MVPでは常に`"range"`(ARCH §15 要確認#2 決定A案) |
| `createdAt` | `string` | ISO8601(UTC)。例: `2024-01-01T00:00:00.000Z` |

派生型: なし

### CanvasState(`src/canvas/canvasState.ts`、T07)

| フィールド | 型 | 備考 |
| ---------- | -- | ---- |
| `image` | `CanvasImage \| null` | 現在Canvasに表示中の画像。初期値は`null` |

`CanvasImage = { assetUrl: string, capture: CaptureResult | null }`。選択中ツール・描画中フラグはT09で追加。
`capture`はT14で`null`許容に変更した(セッション内履歴からの再読込時は、再読込対象が編集後画像であり単一の
`CaptureResult`と対応しないため`null`を渡す。`src/main.ts::reloadHistoryItemIntoCanvas()`参照)。

派生型: なし

### HistoryItem(`src/history/historyStore.ts`、T14)

セッション内履歴(FR-010)の1件。PRD §5 `HistoryItem`に対応するフロント側の型。非永続(アプリ終了で破棄)。

| フィールド | 型 | 備考 |
| ---------- | -- | ---- |
| `id` | `string` | `Capture.id`と対応(PRD §5) |
| `thumbnail` | `string` | サイドバー表示用の縮小画像。ObjectURL(`URL.createObjectURL()`が生成する`blob:`URL) |
| `image` | `string` | Canvas再読込用の画像データ。編集後(マークアップ済み)画像。ObjectURL |
| `createdAt` | `string` | ISO8601(UTC)。一覧の並び順(新しいものが上)に使う |

PRD §5は`thumbnail`を「binary / dataURL」、`image`を「binary (PNG)」としているが、実装時にいずれも
`Blob` + `URL.createObjectURL()`のObjectURL文字列に統一した(【仮定】。dataURL(Base64)は元データの
約1.33倍に膨らむため、5K Retina全画面相当のPNGを複数件保持しうる本機能では不利と判断。理由の詳細は
`historyStore.ts`モジュールdoc・project-config.md §11参照)。上限件数`HISTORY_LIMIT`(50件、【仮定】、
PRDに記載なし)超過時・上書き時の旧ObjectURLは`historyStore.ts`が内部で`URL.revokeObjectURL()`する。

派生型: `HistoryState = { items: HistoryItem[], selectedId: string | null }`(`items`は新しいものが先頭)

### ClipboardImagePayload(`src/ipc/clipboard.ts`、T12)

クリップボードコピー(FR-005)の主経路・Rustフォールバック共通のペイロード。`canvas/render.ts::getCanvasImageData()` が
`canvas.getContext('2d').getImageData()` から生成する(永続化しない、コピー操作の都度その場で生成)。

| フィールド | 型 | 備考 |
| ---------- | -- | ---- |
| `rgba` | `Uint8Array` | RGBA8ピクセル列(行優先)。長さは`width * height * 4`と一致する |
| `width` | `number` | 画像の幅(px、Canvasピクセルバッファ基準) |
| `height` | `number` | 画像の高さ(px、Canvasピクセルバッファ基準) |

ARCH §5.2は `copyToClipboard(pngBytes)`(PNGバイト列)としていたが、Rustフォールバック(`arboard`)がPNGデコードを
サポートせず、デコード用クレート(`image`/`png`等)の追加はARCH §2・§15決定#3が承認した追加依存(`arboard`のみ)の
範囲外になるため、実装時にRGBA8ベースへ変更した(【仮定】、project-config.md §11参照)。

Rust側は `arboard::ImageData { width: usize, height: usize, bytes: Cow<[u8]> }`(`src-tauri/src/clipboard/mod.rs`)に対応する。

派生型: なし

### PermissionState(`src/ipc/permissions.ts`、T08)

画面収録権限の状態(ARCH §6.1 `permissionState`)。永続化しない(起動・キャプチャ試行ごとに再確認)。

| 値 | 意味 |
| -- | ---- |
| `"unconfirmed"` | 起動直後、まだ一度も確認していない(フロントエンドのみが持つ初期値) |
| `"granted"` | 画面収録権限が許可されている |
| `"notGranted"` | 画面収録権限が許可されていない |

Rust側 `capture::ScreenRecordingPermission` は `"granted"`/`"notGranted"` の2値のみ(`Granted`/`NotGranted` を
`#[serde(rename_all = "camelCase")]` でシリアライズ)。`"unconfirmed"` はフロントエンドのみの状態(PJM決定 2026-09-23)。

派生型: なし

### UndoStackState(`src/canvas/undoStack.ts`、T23、FR-014)

Undo/Redoの差分方式スタック(ARCH §6.4 B案、PRD §5 `UndoStep`の実体)。永続化しない(アプリ起動中のみ)。

| フィールド | 型 | 備考 |
| ---------- | -- | ---- |
| `undo` | `UndoEntry[]` | 末尾が最後に積んだ(最新の)エントリ。上限`UNDO_STACK_LIMIT`(30件)超過時は先頭(最古)から破棄 |
| `redo` | `UndoEntry[]` | 同上。`pushUndoStep()`(新規描画)のたびに空になる(PRD FR-014) |

`UndoEntry = { rect: Rect, image: ImageDataLike }`。`Rect = { x, y, width, height }`(Canvasピクセル座標、変更された領域)。
`ImageDataLike = { data: Uint8ClampedArray, width, height }`(`ImageData`相当。VitestのNode環境に`ImageData`が無いため
この最小形で扱う、`mosaicTool.ts`と同じ方針)。PRDの`UndoStep.beforeImage`に対応するのは`UndoEntry.image`で、
Undoスタックのエントリでは「焼き込み前」、Redoスタックのエントリでは「取り消し時点の(焼き込み後の)」ピクセルを指す
(【設計判断】。`pushUndoStep(rect, before)`が呼ばれる時点では焼き込み後のピクセルがまだ存在しないため、
`popUndo(currentImage)`/`popRedo(currentImage)`の呼び出し側が渡す現在のCanvasピクセルから対になるエントリを作る。
理由の詳細は`undoStack.ts`モジュールdoc参照)。上限30件はUndo・Redo双方に適用(PRD §11リスク、全画面モザイク等の
最悪ケースを安全弁で頭打ちにする)。

【改訂 2026-09-24 T32】`undo`/`redo`の要素は`UndoEntry`から`DocumentCommand`(下記)に変わった。
`pixels`/`flatten`コマンドが上記`UndoEntry`と同じ「変更矩形+反対側の状態のピクセル」を持つ(入れ替え方式)。

派生型: なし

### AnnotationDocument(`src/canvas/documentState.ts`・`objectModel.ts`・`commands.ts`、T32、FR-006/008/014改訂)

1画像分のドキュメント。永続化しない(新規キャプチャ・履歴切替で`resetDocument()`、履歴ごとの保持はT34)。

| フィールド | 型 | 備考 |
| ---------- | -- | ---- |
| ベース | 画像と同サイズのオフスクリーン canvas(`documentSurface.ts`) | 元画像。モザイク・テキスト・上限超過の焼き込みはここにだけ適用 |
| `objects` | `AnnotationObject[]` | 配列順=重ね順(末尾が最前面)。最大`OBJECT_LIMIT`=50 |
| `selectedId` | `number \| null` | 選択中のオブジェクト。取り消し対象外 |
| `draft` | `{ id: number \| null, shape } \| null` | ドラッグ中の下書き(`id`がnullなら作成中)。確定までモデルは変えない |

`AnnotationObject = { id: number, shape: EditableShape }`(`EditableShape`は`shapeEdit.ts`: 矢印`{kind:"arrow", start, end, color}`、
矩形・円`{kind:"rectangle"|"ellipse", rect, color}`、【T33】テキスト`{kind:"text", text, x, top, fontSize, color, metrics}`。
テキストの`x`/`top`は行ボックスの左端・上端、フォント実寸は`fontSize`と画像サイズから算出、`metrics`は`measureText()`の
`width`・`actualBoundingBox{Left,Right,Ascent,Descent}`・`fontBoundingBox{Ascent,Descent}`)。
`hiddenId`(T33): 再編集中で描画から一時的に外しているテキストのid(取り消し対象外)。

`DocumentCommand`(取り消し・やり直しの1操作): `add {object, index}` / `update {id, before, after}` / `remove {object, index}`(T34で結線) /
`pixels {rect, image}` / `flatten {object, index, rect, image}` / `group {commands}`。51個目の追加は`group[add, flatten]`になり、
1回の取り消しで両方戻る。

派生型: なし

## フォームバリデーション

<!-- フォームバリデーションスキーマの一覧 -->

| スキーマ | 対象 | 主なルール |
| -------- | ---- | ---------- |

## 重要なバリデーションルール

<!-- AIがコードベースから検出したバリデーションルールを記載。
     ビジネスロジック上の制約（上限値、一意性、範囲制限等）を明記する -->

## ユーティリティ関数

<!-- データ変換・計算に使用するユーティリティ関数を記載 -->
