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
//! # 件数上限(【仮定】、PRDに明記なし)
//!
//! PRDには件数上限の記載が無いが、5K Retina全画面相当の編集後画像(PNG)を無制限に
//! メモリ保持するとブラウザタブ(WebView)のメモリを圧迫しうるため、[`HISTORY_LIMIT`]
//! (50件)を超えたら最も古い項目から破棄する仮定を採用した。破棄された項目のObjectURLは
//! [`addHistoryItem`]が内部でrevokeする。

import { captureHistoryAssets } from "../canvas/render";

/** セッション内履歴の1件(PRD §5 `HistoryItem`)。 */
export interface HistoryItem {
  /** `Capture.id` と対応(PRD §5)。 */
  id: string;
  /** サイドバー表示用の縮小画像。ObjectURL(上記モジュールdoc参照)。 */
  thumbnail: string;
  /** Canvas再読込用の画像データ。編集後(マークアップ済み)画像。ObjectURL。 */
  image: string;
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
 * 保持する履歴の件数上限(【仮定】、PRDに記載なし。上記モジュールdoc参照)。
 * 超過分は最も古い項目(配列末尾)から破棄する。
 */
export const HISTORY_LIMIT = 50;

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
  const items = [item, ...state.items];
  const kept = items.slice(0, HISTORY_LIMIT);
  const evicted = items.slice(HISTORY_LIMIT);
  return { state: { items: kept, selectedId: item.id }, evicted };
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
  items[index] = { ...target, image: patch.image, thumbnail: patch.thumbnail };
  return {
    state: { ...state, items },
    replaced: { image: target.image, thumbnail: target.thumbnail },
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
  for (const evicted of result.evicted) {
    URL.revokeObjectURL(evicted.image);
    URL.revokeObjectURL(evicted.thumbnail);
  }
  notify();
  return result.evicted;
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
