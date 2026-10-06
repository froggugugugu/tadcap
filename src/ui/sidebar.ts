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
//!
//! v0.2.2後の人間フィードバック: サムネイルのホバーで右上に×ボタンを出して1件削除
//! (`handleItemDelete`)、一覧の上の「すべて削除」から確認ダイアログを経て全削除
//! (`handleClearAll`)できる。どちらもクリックと同じキューで直列化する。

import {
  clearHistory,
  getSelectedHistoryItem,
  getHistoryState,
  removeHistoryItem,
  selectHistoryItem,
  subscribeHistoryState,
  updateSelectedItemImage,
  type HistoryItem,
  type HistoryItemImagePatch,
} from "../history/historyStore";

export interface SidebarCallbacks {
  /**
   * 現在のCanvas内容を履歴保存用image/thumbnailとして抽出する
   * (`src/main.ts`が`canvas/render.ts::captureHistoryAssets()`経由で実装する)。
   * Canvas未初期化・画像未読込時は`null`を返す想定。
   */
  captureCurrentAssets: () => Promise<HistoryItemImagePatch | null>;
  /** 指定した履歴項目の画像をCanvasへ再読込する(`src/main.ts`が実装する)。 */
  reloadImage: (item: HistoryItem) => Promise<void>;
  /** 履歴から消えた項目の後始末(退避の削除。`src/main.ts`が実装する)。 */
  onItemsRemoved: (items: readonly HistoryItem[]) => void;
  /** エディタを空状態(画像なし)に戻す(`src/main.ts`が実装する)。 */
  clearEditor: () => void;
}

/** 項目クリック([`handleItemClick`])が使うコールバック。 */
export type ItemClickCallbacks = Pick<SidebarCallbacks, "captureCurrentAssets" | "reloadImage">;

/** 1件削除([`handleItemDelete`])が使うコールバック。 */
export type ItemDeleteCallbacks = Pick<
  SidebarCallbacks,
  "reloadImage" | "onItemsRemoved" | "clearEditor"
>;

/** 全削除([`handleClearAll`])が使うコールバック。 */
export type ClearAllCallbacks = Pick<SidebarCallbacks, "onItemsRemoved" | "clearEditor">;

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
 * サイドバー操作(クリック・削除・全削除)を`clickQueue`へ直列に積む。削除も選択中の項目を読んで
 * 再読込するため、クリックと同じ理由(MUST-2)で直列化する。
 */
function enqueue(task: () => Promise<void>): Promise<void> {
  const next = clickQueue.then(task);
  clickQueue = next.catch(() => {
    // 直列化のためのチェーンは失敗しても止めない(次の呼び出しは進める)。
    // 呼び出し元へのエラー伝播は`next`(この関数の戻り値)自体が担う。
  });
  return next;
}

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
  callbacks: ItemClickCallbacks,
): Promise<void> {
  return enqueue(() => processItemClick(item, callbacks));
}

async function processItemClick(
  item: HistoryItem,
  callbacks: ItemClickCallbacks,
): Promise<void> {
  // ×の直後に同じサムネイルを押した場合など、待っている間に消えた項目は読み込まない
  // (ObjectURLはrevoke済み)。
  if (!getHistoryState().items.some((it) => it.id === item.id)) {
    return;
  }
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

/**
 * 履歴項目を1件消す(サムネイルの×ボタン、v0.2.2後の人間フィードバック)。表示中の項目なら、
 * 編集内容は保存せずに隣の項目を読み込み、最後の1件ならエディタを空状態に戻す。既に消えた
 * 項目(連打)なら何もしない。クリックと同じキューで直列化する。
 */
export function handleItemDelete(
  item: HistoryItem,
  callbacks: ItemDeleteCallbacks,
): Promise<void> {
  return enqueue(async () => {
    const wasSelected = getSelectedHistoryItem()?.id === item.id;
    const removed = removeHistoryItem(item.id);
    if (!removed) {
      return;
    }
    callbacks.onItemsRemoved([removed]);
    if (!wasSelected) {
      return;
    }
    const next = getSelectedHistoryItem();
    if (next) {
      await callbacks.reloadImage(next);
    } else {
      callbacks.clearEditor();
    }
  });
}

/** 履歴をすべて消し、エディタを空状態に戻す(確認後に呼ぶ)。履歴が空なら何もしない。 */
export function handleClearAll(callbacks: ClearAllCallbacks): Promise<void> {
  return enqueue(async () => {
    if (getHistoryState().items.length === 0) {
      return;
    }
    callbacks.onItemsRemoved(clearHistory());
    callbacks.clearEditor();
  });
}

const DELETE_ICON =
  '<svg class="icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false">' +
  '<path d="M3.5 3.5l5 5M8.5 3.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
  "</svg>";

const CLEAR_ALL_ICON =
  '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
  '<path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.5 5.5l.8 10.6a1.5 1.5 0 0 0 1.5 1.4h4.4' +
  'a1.5 1.5 0 0 0 1.5-1.4l.8-10.6M8.5 9v5M11.5 9v5" fill="none" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round" stroke-linejoin="round"/>' +
  "</svg>";

/** 履歴項目1件分のDOM構造を組み立てる(Presentational)。 */
function renderItemView(
  item: HistoryItem,
  selected: boolean,
  onClick: () => void,
  onDelete: () => void,
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

  // サムネイルのボタンの中にボタンは入れられないため、兄弟として右上に重ねる(ホバー・
  // キーボードフォーカスで表示、`styles.css`)。
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "history-sidebar__delete-button";
  deleteButton.setAttribute("aria-label", "この履歴を削除");
  deleteButton.title = "この履歴を削除";
  deleteButton.innerHTML = DELETE_ICON;
  deleteButton.addEventListener("click", onDelete);

  li.append(button, deleteButton);
  return li;
}

/**
 * 「すべて削除」の確認ダイアログ(`<dialog>`のモーダル)を組み立てる。`ask(count)`は
 * 「削除」で`true`、キャンセル・Escで`false`に解決する。既定のフォーカスはキャンセル
 * (元に戻せない操作のため)。
 */
function createClearAllDialog(): {
  element: HTMLDialogElement;
  ask: (count: number) => Promise<boolean>;
} {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("aria-labelledby", "clear-history-title");

  const form = document.createElement("form");
  form.method = "dialog";

  const title = document.createElement("p");
  title.id = "clear-history-title";
  title.className = "confirm-dialog__message";

  const actions = document.createElement("div");
  actions.className = "confirm-dialog__actions";
  const cancel = document.createElement("button");
  cancel.value = "cancel";
  cancel.className = "confirm-dialog__button";
  cancel.textContent = "キャンセル";
  cancel.autofocus = true;
  const confirm = document.createElement("button");
  confirm.value = "delete";
  confirm.className = "confirm-dialog__button confirm-dialog__button--danger";
  confirm.textContent = "削除";
  actions.append(cancel, confirm);

  form.append(title, actions);
  dialog.appendChild(form);

  const ask = (count: number): Promise<boolean> => {
    title.textContent = `履歴を${count}件すべて削除します。元に戻せません。`;
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "delete"), {
        once: true,
      });
    });
  };
  return { element: dialog, ask };
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
  const dialog = createClearAllDialog();

  const header = document.createElement("div");
  header.className = "history-sidebar__header";
  const clearAllButton = document.createElement("button");
  clearAllButton.type = "button";
  clearAllButton.className = "icon-button history-sidebar__clear-all";
  clearAllButton.setAttribute("aria-label", "履歴をすべて削除");
  clearAllButton.title = "履歴をすべて削除";
  clearAllButton.innerHTML = CLEAR_ALL_ICON;
  // 確認中にキャプチャが届いて件数が変わったら、見ていない項目まで黙って消さないよう聞き直す。
  const confirmClearAll = async (): Promise<void> => {
    let count = getHistoryState().items.length;
    while (await dialog.ask(count)) {
      if (getHistoryState().items.length === count) {
        await handleClearAll(callbacks);
        return;
      }
      count = getHistoryState().items.length;
    }
  };
  clearAllButton.addEventListener("click", () => {
    void confirmClearAll();
  });
  header.appendChild(clearAllButton);

  // 履歴が増えても一覧だけがスクロールする(ウィンドウ全体は伸ばさない、`styles.css`)。
  const listEl = document.createElement("ul");
  listEl.className = "history-sidebar__list";
  mount.append(header, listEl, dialog.element);

  const render = (): void => {
    const { items, selectedId } = getHistoryState();
    clearAllButton.disabled = items.length === 0;
    listEl.replaceChildren(
      ...items.map((item) =>
        renderItemView(
          item,
          item.id === selectedId,
          () => {
            void handleItemClick(item, callbacks);
          },
          () => {
            void handleItemDelete(item, callbacks);
          },
        ),
      ),
    );
  };

  const unsubscribe = subscribeHistoryState(render);
  render();

  return unsubscribe;
}
