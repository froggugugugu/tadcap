//! セッション内履歴(`HistoryItem[]`)のメモリ管理(ARCH §3.1 フロントエンド 履歴層、
//! §6.1 `historyStore`、PRD §5 `HistoryItem`・FR-010、T14)。
//!
//! 状態管理ライブラリは導入せず、`canvas/canvasState.ts` と同じ作法(純粋関数 + モジュール
//! 単位の薄い状態オブジェクト + 購読関数)で実装する(ARCH §1.3 決定#1)。非永続(アプリ終了で
//! 破棄、PRD §5・FR-010)。
//!
//! # 履歴の更新タイミング(PJM決定 2026-09-23)
//!
//! - `capture://completed` 受信時に履歴へ追加(新しいものが上)し、その項目を選択状態にする
//!   ([`addHistoryItem`]、`src/main.ts::handleCaptureCompleted` が呼ぶ)
//! - 「編集後画像を保持・再読込」(ゲート1 決定#3、PRD §5決定ログ#3)を満たすため、
//!   別の履歴項目へ切り替える直前とクリップボードコピー成功時に、現在のCanvas内容で
//!   選択中項目のimage/thumbnailを上書きする([`updateSelectedItemImage`]、
//!   `src/ui/sidebar.ts`・`src/ui/clipboardButton.ts`の成功フックが呼ぶ)
//!
//! # 保持形式(【仮定】、T14実装時の判断)
//!
//! `image`(編集後画像、Canvas再読込用)・`thumbnail`(縮小画像)はいずれも文字列型のURL
//! (Blob + `URL.createObjectURL()` が生成するObjectURL)として保持する。理由:
//!
//! - `src/canvas/render.ts::loadImage(src: string)` はURL文字列から
//!   `HTMLImageElement` を読み込む実装になっており、履歴再読込(`item.image` → Canvas)を
//!   キャプチャ完了時の読込(`read_capture_image` のバイト列 → ObjectURL → Canvas)と
//!   同じ経路に統一できる
//!   (ImageDataのまま保持すると、再読込のたびに `putImageData()` 用の専用コードパスが
//!   別途必要になる)
//! - dataURL(base64)は自己完結でrevoke不要という利点があるが、Base64エンコードは
//!   元データよりおよそ1.33倍に膨らむ。5K Retina全画面相当のPNGを`HISTORY_LIMIT`件
//!   保持しうるため、生バイト列のままBlobとして保持できるObjectURLの方が省メモリ
//! - ObjectURLは明示的な`URL.revokeObjectURL()`が必要になるが、本モジュールの不変条件
//!   として「項目がストアから消える(上限超過による破棄)/上書きされる」タイミングで
//!   必ず旧URLをrevokeする(下記[`addHistoryItem`]・[`updateSelectedItemImage`]参照)。
//!   Blob/URL自体の生成(`canvas.toBlob()`)はDOM/Canvas APIに依存するため、本モジュールは
//!   `src/canvas/render.ts` の抽出関数を呼ぶだけに留める(ARCH §3.1「履歴層は canvas層
//!   (編集後画像の取得)に依存可能」)
//!
//! # 上限(v0.2.0後の人間フィードバックで改訂、旧【仮定】50件)
//!
//! T34で履歴ごとにベースPNG・オブジェクト・取り消しスタック(1件8MBまで)を退避するように
//! なり、5K × 50件では最悪1GB近くになるため、次の2つの上限を設けた。
//!
//! - 件数 [`HISTORY_LIMIT`](20件): 超えたら最も古い項目から破棄する([`addHistoryItem`])
//! - 合計バイト数 [`HISTORY_BYTES_LIMIT`](300MB): 履歴画像・サムネイルのPNG(`HistoryItem.bytes`)と
//!   退避(`documentArchive.ts::archivedDocumentBytes()`)の実測値の合計。超えたら最も古い項目から
//!   破棄する([`enforceHistoryBudget`]、`main.ts`が保存点のたびに呼ぶ)
//!
//! どちらも表示中(選択中)の項目は破棄しない([`selectHistoryEvictions`])。破棄された項目の
//! ObjectURLは本モジュールがrevokeし、退避の削除は呼び出し元(`main.ts`)が行う。

import { captureHistoryAssets } from "../canvas/render";

/** セッション内履歴の1件(PRD §5 `HistoryItem`)。 */
export interface HistoryItem {
  /** `Capture.id` と対応(PRD §5)。 */
  id: string;
  /** サイドバー表示用の縮小画像。ObjectURL(上記モジュールdoc参照)。 */
  thumbnail: string;
  /** Canvas再読込用の画像データ。編集後(マークアップ済み)画像。ObjectURL。 */
  image: string;
  /** `image`・`thumbnail`のPNG(Blob)の実測バイト数の合計(履歴のメモリ上限の判定用)。 */
  bytes: number;
  /** ISO8601(UTC)文字列。一覧の並び順に使う(新しいものが上)。 */
  createdAt: string;
}

/** 履歴ストアの状態。`items`は新しいものが先頭(index 0)。 */
export interface HistoryState {
  items: HistoryItem[];
  /** 選択中の項目id。未選択(初期状態)は`null`。 */
  selectedId: string | null;
}

/**
 * 保持する履歴の件数上限(上記モジュールdoc参照)。超過分は最も古い項目(配列末尾)から破棄する。
 * 1件あたり最悪で履歴画像・サムネイル + 退避(ベースPNG 2〜10MB + 取り消し8MB)≒ 15〜25MB
 * (5K)を想定し、20件で合計バイト数の上限(300MB)と同程度の規模になるようにした。
 */
export const HISTORY_LIMIT = 20;

/**
 * 履歴が持つデータ(履歴画像・サムネイルのPNG + 退避)の合計バイト数の上限(300MB)。
 * WebView 1枚が使うメモリとして現実的な範囲に抑える(件数上限だけでは、5Kで編集の多い
 * 画像が続くと数百MB〜1GBに達しうるため)。
 */
export const HISTORY_BYTES_LIMIT = 300 * 1024 * 1024;

/** 破棄判定に使う1件分の情報(`items`と同じく新しいものが先頭)。 */
export interface HistoryBudgetEntry {
  id: string;
  /** その項目が持つデータの実測バイト数の合計。 */
  bytes: number;
}

/**
 * 件数`maxCount`以下かつ合計`maxBytes`以下になるよう、破棄する項目のidを古い順に返す純粋関数。
 * `selectedId`(表示中)の項目は破棄しない。それ以外をすべて捨てても上限を超える場合は、そこで止める。
 */
export function selectHistoryEvictions(
  entries: readonly HistoryBudgetEntry[],
  selectedId: string | null,
  maxCount: number,
  maxBytes: number,
): string[] {
  let count = entries.length;
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const evicted: string[] = [];
  for (let i = entries.length - 1; i >= 0 && (count > maxCount || total > maxBytes); i -= 1) {
    const entry = entries[i]!;
    if (entry.id === selectedId) {
      continue;
    }
    evicted.push(entry.id);
    count -= 1;
    total -= entry.bytes;
  }
  return evicted;
}

/** `evictedIds`を除いた状態と、除いた項目(古い順)を返す(内部ヘルパー)。 */
function withoutItems(
  state: HistoryState,
  evictedIds: readonly string[],
): { state: HistoryState; evicted: HistoryItem[] } {
  if (evictedIds.length === 0) {
    return { state, evicted: [] };
  }
  const removed = new Set(evictedIds);
  const evicted = evictedIds.map((id) => state.items.find((it) => it.id === id)!);
  return { state: { ...state, items: state.items.filter((it) => !removed.has(it.id)) }, evicted };
}

/** 画像なし・未選択の初期状態を返す純粋関数。 */
export function createHistoryState(): HistoryState {
  return { items: [], selectedId: null };
}

export interface AddHistoryItemResult {
  state: HistoryState;
  /** `HISTORY_LIMIT`超過で破棄された項目(呼び出し元がObjectURLをrevokeするために返す)。 */
  evicted: HistoryItem[];
}

/**
 * 新しい項目を先頭に追加し、その項目を選択状態にする純粋関数(イミュータブル、PJM決定)。
 * `HISTORY_LIMIT`を超える場合は末尾(最も古い項目)から破棄する。
 */
export function withAddedItem(
  state: HistoryState,
  item: HistoryItem,
): AddHistoryItemResult {
  const added: HistoryState = { items: [item, ...state.items], selectedId: item.id };
  const evictedIds = selectHistoryEvictions(added.items, item.id, HISTORY_LIMIT, Infinity);
  return withoutItems(added, evictedIds);
}

/**
 * 項目を選択状態にする純粋関数(イミュータブル)。存在しないidの場合は元の状態を
 * そのまま返す(選択を変えない、防御的)。
 */
export function withSelectedId(state: HistoryState, id: string): HistoryState {
  if (!state.items.some((it) => it.id === id)) {
    return state;
  }
  return { ...state, selectedId: id };
}

export interface HistoryItemImagePatch {
  image: string;
  thumbnail: string;
  /** `image`・`thumbnail`のPNGの実測バイト数の合計。 */
  bytes: number;
}

export interface UpdateHistoryItemImageResult {
  state: HistoryState;
  /**
   * 上書きされ不要になった旧image/thumbnail(呼び出し元がObjectURLをrevokeするために
   * 返す)。該当項目が無ければ`null`。
   */
  replaced: HistoryItemImagePatch | null;
}

/**
 * 指定idの項目のimage/thumbnailを上書きする純粋関数(イミュータブル)。id/createdAtは
 * 変えない。存在しないidの場合は元の状態のまま、`replaced`は`null`。
 */
export function withUpdatedItemImage(
  state: HistoryState,
  id: string,
  patch: HistoryItemImagePatch,
): UpdateHistoryItemImageResult {
  const index = state.items.findIndex((it) => it.id === id);
  if (index === -1) {
    return { state, replaced: null };
  }
  const target = state.items[index]!;
  const items = state.items.slice();
  items[index] = { ...target, image: patch.image, thumbnail: patch.thumbnail, bytes: patch.bytes };
  return {
    state: { ...state, items },
    replaced: { image: target.image, thumbnail: target.thumbnail, bytes: target.bytes },
  };
}

/** 選択中の項目を返す純粋関数。未選択、または選択idが指す項目が無ければ`null`。 */
export function getSelectedItem(state: HistoryState): HistoryItem | null {
  return state.items.find((it) => it.id === state.selectedId) ?? null;
}

type Listener = (state: HistoryState) => void;

let state: HistoryState = createHistoryState();
const listeners = new Set<Listener>();

/** 現在の状態を返す(`ui/`層が読み取り用に参照する)。 */
export function getHistoryState(): HistoryState {
  return state;
}

/** 選択中の項目を返す(`ui/`層向けの薄いヘルパー)。 */
export function getSelectedHistoryItem(): HistoryItem | null {
  return getSelectedItem(state);
}

/**
 * 新しい項目を先頭に追加・選択し、購読者へ通知する(`capture://completed`受信時、PJM決定)。
 * 上限超過で破棄された項目があれば、その`image`/`thumbnail`のObjectURLをrevokeしたうえで
 * 破棄項目一覧を返す(呼び出し元での追加revokeは不要)。
 */
export function addHistoryItem(item: HistoryItem): HistoryItem[] {
  const result = withAddedItem(state, item);
  state = result.state;
  revokeItems(result.evicted);
  notify();
  return result.evicted;
}

/**
 * 合計バイト数(各項目の`bytes` + `extraBytesOf(id)`、退避分を渡す)が[`HISTORY_BYTES_LIMIT`]を
 * 超えていれば、表示中以外の古い項目から破棄してObjectURLをrevokeし、破棄した項目を返す
 * (呼び出し元は退避も消す)。破棄が無ければ通知しない。
 */
export function enforceHistoryBudget(extraBytesOf: (id: string) => number): HistoryItem[] {
  const entries = state.items.map((it) => ({ id: it.id, bytes: it.bytes + extraBytesOf(it.id) }));
  const evictedIds = selectHistoryEvictions(
    entries,
    state.selectedId,
    HISTORY_LIMIT,
    HISTORY_BYTES_LIMIT,
  );
  if (evictedIds.length === 0) {
    return [];
  }
  const result = withoutItems(state, evictedIds);
  state = result.state;
  revokeItems(result.evicted);
  notify();
  return result.evicted;
}

function revokeItems(items: readonly HistoryItem[]): void {
  for (const item of items) {
    URL.revokeObjectURL(item.image);
    URL.revokeObjectURL(item.thumbnail);
  }
}

/** 項目を選択状態にし、購読者へ通知する。存在しないidの場合は選択を変えない。 */
export function selectHistoryItem(id: string): void {
  state = withSelectedId(state, id);
  notify();
}

/**
 * 選択中の項目のimage/thumbnailを現在のCanvas内容で上書きし、購読者へ通知する
 * (「別の履歴項目へ切り替える直前」「クリップボードコピー成功時」に呼ぶ、PJM決定)。
 * 上書きで不要になった旧URLはrevokeしたうえで返す(未選択時は`null`)。
 */
export function updateSelectedItemImage(
  patch: HistoryItemImagePatch,
): HistoryItemImagePatch | null {
  if (state.selectedId === null) {
    return null;
  }
  const result = withUpdatedItemImage(state, state.selectedId, patch);
  state = result.state;
  if (result.replaced) {
    URL.revokeObjectURL(result.replaced.image);
    URL.revokeObjectURL(result.replaced.thumbnail);
  }
  notify();
  return result.replaced;
}

/** 状態変化を購読する。戻り値の関数を呼ぶと購読解除する。 */
export function subscribeHistoryState(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) {
    listener(state);
  }
}

/**
 * 現在のCanvas内容から履歴保存用のimage(編集後画像)/thumbnail(縮小画像)を抽出する
 * (`src/canvas/render.ts`の薄いre-export。DOM/Canvas APIに依存するため自動テスト対象外、
 * project-config.md §11参照。呼び出し元は`src/main.ts`)。
 */
export { captureHistoryAssets };
