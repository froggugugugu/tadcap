//! セッション内履歴サイドバー(ARCH §3.1 フロントエンド UI 層、§4 `src/ui/sidebar.ts`、
//! FR-010、T14)。
//!
//! 項目クリックでその編集後画像をCanvasへ再読込する(元画像には戻さない、PRD §5決定
//! ログ#3)。「編集後画像を保持・再読込」を満たすため、別の履歴項目へ切り替える直前に、
//! 現在のCanvas内容で選択中項目のimage/thumbnailを上書きしてから切り替える(PJM決定
//! 2026-09-23)。クリップボードコピー成功時の上書きは `src/ui/clipboardButton.ts` の
//! 成功フックから `src/history/historyStore.ts::updateSelectedItemImage()` を直接呼ぶ
//! (本モジュールを経由しない)。
//!
//! DOM生成(`renderItemView`/`initSidebar`)・`historyStore`購読を伴う部分は
//! Vitestの既定環境(Node、DOM API無し)では自動テスト対象外とする
//! (`toolbar.ts`/`permissionBanner.ts`と同じ方針、project-config.md §11参照)。
//! 状態遷移ロジック自体は`history/historyStore.test.ts`が純粋関数・ストア単位で
//! テストする。
//!
//! `handleItemClick`はDOM非依存(`SidebarCallbacks`経由でDOM操作を注入される側)
//! なのでエクスポートし、`sidebar.test.ts`が非同期オーケストレーション(直列化)を
//! 直接テストする(SHOULD-3、レビュー2026-09-24)。

import {
  getSelectedHistoryItem,
  getHistoryState,
  selectHistoryItem,
  subscribeHistoryState,
  updateSelectedItemImage,
  type HistoryItem,
} from "../history/historyStore";

export interface SidebarCallbacks {
  /**
   * 現在のCanvas内容を履歴保存用image/thumbnailとして抽出する
   * (`src/main.ts`が`canvas/render.ts::captureHistoryAssets()`経由で実装する)。
   * Canvas未初期化・画像未読込時は`null`を返す想定。
   */
  captureCurrentAssets: () => Promise<{ image: string; thumbnail: string } | null>;
  /** 指定した履歴項目の画像をCanvasへ再読込する(`src/main.ts`が実装する)。 */
  reloadImage: (item: HistoryItem) => Promise<void>;
}

/**
 * `handleItemClick`の直列化キュー(MUST-2、レビュー2026-09-24)。
 *
 * サムネイルボタンは素朴に `() => { void handleItemClick(item, callbacks); }` を
 * バインドするだけなので、連続クリックで複数の呼び出しが並行に走りうる。
 * `state.selectedId` を読む(`getSelectedHistoryItem()`)→ `await` を挟む →
 * 書く(`updateSelectedItemImage()`/`selectHistoryItem()`)という処理を
 * TOCTOU無しに保つため、全呼び出しを1本のPromiseチェーンに直列化し、
 * 前の呼び出しが完全に完了する(再読込まで終わる)まで次の呼び出しを開始しない。
 * 個々の呼び出しが投げても後続の直列化が止まらないよう、チェーン自体は
 * 失敗を握りつぶす(呼び出し元へは`handleItemClick`が返す個別のPromiseで
 * 成否を伝える)。
 */
let clickQueue: Promise<void> = Promise.resolve();

/**
 * 既に選択中の項目を再度クリックした場合は何もしない(切替・再読込ともに不要)。
 * それ以外は、選択中項目があれば現在のCanvas内容で上書きしてから、対象項目を
 * 選択・再読込する(Container相当)。
 *
 * 呼び出しは`clickQueue`で直列化される(MUST-2)。同一項目への連打・異なる項目への
 * 高速な連続クリックのいずれでも、`state.selectedId`の読み取りは必ず「直前の
 * 呼び出しの完了後」に行われるため、TOCTOUによる無関係な項目への誤った上書きが
 * 起きない。エクスポートするのはテスト(`sidebar.test.ts`)からこの直列化・
 * 選択判定を直接検証するため。
 */
export function handleItemClick(
  item: HistoryItem,
  callbacks: SidebarCallbacks,
): Promise<void> {
  const next = clickQueue.then(() => processItemClick(item, callbacks));
  clickQueue = next.catch(() => {
    // 直列化のためのチェーンは失敗しても止めない(次の呼び出しは進める)。
    // 呼び出し元へのエラー伝播は`next`(この関数の戻り値)自体が担う。
  });
  return next;
}

async function processItemClick(
  item: HistoryItem,
  callbacks: SidebarCallbacks,
): Promise<void> {
  const current = getSelectedHistoryItem();
  if (current?.id === item.id) {
    return;
  }
  if (current) {
    const assets = await callbacks.captureCurrentAssets();
    if (assets) {
      updateSelectedItemImage(assets);
    }
  }
  selectHistoryItem(item.id);
  await callbacks.reloadImage(item);
}

/** 履歴項目1件分のDOM構造を組み立てる(Presentational)。 */
function renderItemView(
  item: HistoryItem,
  selected: boolean,
  onClick: () => void,
): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "history-sidebar__item";
  li.classList.toggle("history-sidebar__item--selected", selected);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "history-sidebar__thumbnail-button";
  button.setAttribute("aria-pressed", String(selected));
  button.setAttribute("aria-label", `履歴 ${item.createdAt}`);
  button.addEventListener("click", onClick);

  const img = document.createElement("img");
  img.className = "history-sidebar__thumbnail";
  img.src = item.thumbnail;
  img.alt = "";
  button.appendChild(img);

  li.appendChild(button);
  return li;
}

/**
 * サイドバーを `mount` 配下に構築し、`historyStore` と結線する(Container相当)。
 * 状態変化(追加・選択切替・上書き)のたびに一覧を再描画する。
 *
 * 戻り値は購読解除用の関数。
 */
export function initSidebar(
  mount: HTMLElement,
  callbacks: SidebarCallbacks,
): () => void {
  const listEl = document.createElement("ul");
  listEl.className = "history-sidebar__list";
  mount.appendChild(listEl);

  const render = (): void => {
    const { items, selectedId } = getHistoryState();
    listEl.replaceChildren(
      ...items.map((item) =>
        renderItemView(item, item.id === selectedId, () => {
          void handleItemClick(item, callbacks);
        }),
      ),
    );
  };

  const unsubscribe = subscribeHistoryState(render);
  render();

  return unsubscribe;
}
