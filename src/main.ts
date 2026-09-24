import {
  getCanvasState,
  setCanvasImage,
  subscribeCanvasState,
} from "./canvas/canvasState";
import {
  captureHistoryAssets,
  getCanvasImageData,
  loadImage,
  renderImageToCanvas,
} from "./canvas/render";
import {
  exportDocumentBase,
  resetDocument,
  restoreDocument,
  setDocumentSurface,
  snapshotDocument,
} from "./canvas/documentState";
import { createDocumentSurface } from "./canvas/documentSurface";
import { bindMosaicTool } from "./canvas/tools/mosaicTool";
import { bindShapeTools } from "./canvas/tools/shapeTools";
import { bindTextTool, commitPendingText } from "./canvas/tools/textTool";
import {
  deleteArchivedDocument,
  getArchivedDocument,
  saveArchivedDocument,
} from "./history/documentArchive";
import {
  addHistoryItem,
  getSelectedHistoryItem,
  updateSelectedItemImage,
  type HistoryItem,
} from "./history/historyStore";
import type { ClipboardImagePayload } from "./ipc/clipboard";
import {
  onCaptureCompleted,
  onCaptureError,
  readCaptureImage,
  type CaptureResult,
} from "./ipc/capture";
import {
  checkScreenRecordingPermission,
  isPermissionDeniedError,
} from "./ipc/permissions";
import { initCaptureButton } from "./ui/captureButton";
import { initClipboardButton, isClipboardCopyEnabled } from "./ui/clipboardButton";
import { initColorPicker } from "./ui/colorPicker";
import { initFontSizePicker } from "./ui/fontSizePicker";
import {
  initPermissionBanner,
  shouldShowPermissionBanner,
  type PermissionBannerController,
} from "./ui/permissionBanner";
import { bindSelectionKeys } from "./ui/selectionKeys";
import { initSidebar } from "./ui/sidebar";
import { initToolbar } from "./ui/toolbar";
import { initUndoButtons } from "./ui/undoButton";
import { initArrangeButtons } from "./ui/arrangeButtons";

let canvasEl: HTMLCanvasElement | null = null;
let statusEl: HTMLElement | null = null;
let permissionBanner: PermissionBannerController | null = null;

/**
 * 表示中の履歴項目のドキュメント(ベースPNG・オブジェクト・取り消しスタック)を退避する
 * (T34【新設 2026-09-25】、別の画像へ切り替える直前に呼ぶ。戻ったときに再調整できるように)。
 * オブジェクト・スタックは呼んだ時点で同期に取り出し、ベースのPNG化だけを待つ。
 */
async function archiveCurrentDocument(): Promise<void> {
  const current = getSelectedHistoryItem();
  if (!current || !getCanvasState().image) {
    return;
  }
  const snapshot = snapshotDocument();
  const base = await exportDocumentBase();
  saveArchivedDocument(current.id, { base, snapshot });
}

/**
 * `capture://completed` イベント受信時のハンドラ(Canvas反映の主経路、T07仕様)。
 *
 * 画像は `read_capture_image` コマンドでバイト列として受け取り、`Blob` →
 * ObjectURL(同一オリジン扱い)にしてCanvasへ描画したうえで `canvasState` に反映する
 * (ARCH §7.1 手順5)。以前の `convertFileSrc()` のasset URLは webview と別オリジンで、
 * 描画した時点でCanvasが汚染(tainted)され、矢印・モザイク・コピー・履歴が
 * `SecurityError` で動かなかった(実機不具合②〜⑤、`src/ipc/capture.ts::readCaptureImage`
 * 参照)。ボタン起点かグローバルショートカット/トレイ起点(T15・T16)かをフロント
 * エンドは区別しない。
 *
 * T14: Canvas反映後、セッション内履歴へ追加・選択する(PJM決定 2026-09-23
 * 「`capture://completed`受信時に履歴へ追加し、その項目を選択状態にする」)。
 *
 * SHOULD-2(レビュー2026-09-24): Canvasを新しいキャプチャで差し替える前に、
 * 直前まで表示・編集していた選択中の履歴項目へ現在のCanvas内容を保存する。
 * 保存点(履歴切替・クリップボードコピー)を経ないまま次のキャプチャに進むと、
 * 編集内容が失われたまま履歴に固定されてしまうため(PRD §5決定#3「編集後
 * 画像を保持・再読込する」の趣旨)。ドラッグ中(`isDrawing`)は未確定のプレビュー
 * 内容のため保存しない(MUST-1のドラッグ中断処理がこの後の描画を別途中断する)。
 */
async function handleCaptureCompleted(result: CaptureResult): Promise<void> {
  if (!canvasEl) {
    return;
  }
  let objectUrl: string | null = null;
  try {
    // T27: 差し替え前に入力中のテキストを確定し、下の履歴保存に含める(T32: 図形は
    // オブジェクトとして常に表示canvasへ合成済みのため確定は不要)。
    commitPendingText();
    if (
      canvasEl.width > 0 &&
      canvasEl.height > 0 &&
      !getCanvasState().isDrawing
    ) {
      const currentAssets = await captureHistoryAssets(canvasEl);
      updateSelectedItemImage(currentAssets);
    }
    // T34: 差し替える前に、表示中の項目のドキュメントを退避する。
    await archiveCurrentDocument();
    const blob = await readCaptureImage(result.sourcePath);
    objectUrl = URL.createObjectURL(blob);
    const image = await loadImage(objectUrl);
    renderImageToCanvas(canvasEl, image);
    // T32: 新しいドキュメント(ベース=読み込んだ画像、オブジェクト0個)にする。Undo/Redoスタックの
    // クリア(T24、取り消し対象を「現在表示中の画像」に限定)も含む。T34: 読み込んだPNGをベースの
    // 退避にそのまま使えるよう渡す(ベースを変えるまで再エンコードしない)。
    resetDocument(blob);
    setCanvasImage({ assetUrl: objectUrl, capture: result });
    const assets = await captureHistoryAssets(canvasEl);
    const evicted = addHistoryItem({
      id: result.id,
      image: assets.image,
      thumbnail: assets.thumbnail,
      createdAt: result.createdAt,
    });
    // T34: 履歴の上限で消えた項目の退避も消す。
    for (const item of evicted) {
      deleteArchivedDocument(item.id);
    }
    if (statusEl) {
      statusEl.textContent = "";
    }
  } catch (error) {
    // 原因調査のため実際のエラーは握りつぶさずに出す(ユーザー向け文言は短いまま)。
    console.error("キャプチャ画像の表示に失敗しました", error);
    if (statusEl) {
      statusEl.textContent = "画像の表示に失敗しました。";
    }
  } finally {
    // 描画後はCanvasがピクセルを保持するため、読込用のObjectURLは解放してよい。
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

/**
 * 画面収録権限未許可時の案内バナーを表示する(NFR-002)。
 *
 * フロントの3つの入口(ボタンの `invoke` reject、トレイ/ショートカット起点の
 * `capture://error` イベント、起動時の事前確認)はいずれも本関数を呼ぶ
 * (PJM決定 2026-09-23。どこから来ても同じバナーを表示する)。
 */
function showPermissionDeniedBanner(): void {
  permissionBanner?.showDenied();
}

/**
 * Canvasの現在ピクセルをクリップボードコピー用のペイロードとして取得する
 * (FR-005、T12)。Canvas未初期化・画像未読込時は`null`を返す(呼び出し元の
 * `ui/clipboardButton.ts` がボタン無効化・Cmd+C無視で先にガードするため、
 * ここでは防御的にnullを返すだけで例外は投げない)。
 */
function getClipboardPayload(): ClipboardImagePayload | null {
  if (!canvasEl || canvasEl.width === 0 || canvasEl.height === 0) {
    return null;
  }
  // T27: コピー前に入力中のテキストを確定する(ハンドル・入力欄はCanvasに重ねたDOMのため
  // 元々写らない。T32: 図形は表示canvasへ合成済み)。
  commitPendingText();
  return getCanvasImageData(canvasEl);
}

/**
 * コピー成功時のフック(FR-010、T14、`ui/clipboardButton.ts::initClipboardButton`の
 * `onCopySuccess`)。選択中の履歴項目のimage/thumbnailを現在のCanvas内容で上書きする
 * (「編集後画像を保持・再読込」PJM決定 2026-09-23)。
 */
function handleClipboardCopySuccess(): void {
  if (!canvasEl || canvasEl.width === 0 || canvasEl.height === 0) {
    return;
  }
  void captureHistoryAssets(canvasEl).then((assets) => {
    updateSelectedItemImage(assets);
  });
}

/**
 * サイドバー(`ui/sidebar.ts`)へ渡すコールバック(FR-010、T14)。
 *
 * `captureCurrentAssets`: 履歴項目を切り替える直前に、現在のCanvas内容を抽出する
 * (選択中項目のimage/thumbnail上書き用、PJM決定 2026-09-23)。
 * `reloadImage`: 選択された履歴項目の編集後画像をCanvasへ再読込する(元画像には戻さない、
 * PRD §5決定ログ#3)。`capture`メタデータは履歴由来のため`null`にする(`canvasState.ts`参照)。
 */
async function captureCurrentHistoryAssets(): Promise<
  { image: string; thumbnail: string } | null
> {
  if (!canvasEl || canvasEl.width === 0 || canvasEl.height === 0) {
    return null;
  }
  // T27: 履歴切替で差し替える前に入力中のテキストを確定し、保存内容に含める。
  commitPendingText();
  // T34: 切り替える前に、表示中の項目のドキュメントを退避する。
  await archiveCurrentDocument();
  return captureHistoryAssets(canvasEl);
}

async function reloadHistoryItemIntoCanvas(item: HistoryItem): Promise<void> {
  if (!canvasEl) {
    return;
  }
  try {
    // T34: 退避したドキュメントがあれば、ベース・オブジェクト・取り消しスタックごと戻す
    // (戻った後もオブジェクトを再調整・取り消しできる)。
    const archived = getArchivedDocument(item.id);
    if (archived) {
      const bitmap = await createImageBitmap(archived.base);
      restoreDocument(archived.snapshot, bitmap, archived.base);
      bitmap.close();
      setCanvasImage({ assetUrl: item.image, capture: null });
      return;
    }
    const image = await loadImage(item.image);
    renderImageToCanvas(canvasEl, image);
    // T32: 合成結果(編集後画像)をベースとする新しいドキュメントにする(Undo/Redoもクリア、
    // T24と同じ理由)。退避が無い場合(T34以前の経路・失敗時)のフォールバック。
    resetDocument();
    setCanvasImage({ assetUrl: item.image, capture: null });
  } catch (error) {
    console.error("履歴画像の再読込に失敗しました", error);
    if (statusEl) {
      statusEl.textContent = "履歴画像の再読込に失敗しました。";
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  canvasEl = document.querySelector<HTMLCanvasElement>("#capture-canvas");
  statusEl = document.querySelector<HTMLElement>("#capture-status");
  const buttonEl = document.querySelector<HTMLButtonElement>(
    "#capture-button",
  );
  const appEl = document.querySelector<HTMLElement>(".app");

  if (appEl) {
    permissionBanner = initPermissionBanner(appEl);
  }

  // ツール切替UI(矢印/矩形/円/モザイク、T09で土台・T10でモザイク・T25で矩形・T26で円を
  // 有効化)とCanvas上のドラッグ結線。画像未読込時のドラッグは各ツールの `bind*Tool` 内部で
  // 無視される。
  const toolbarEl = document.querySelector<HTMLElement>("#tool-toolbar");
  if (toolbarEl) {
    initToolbar(toolbarEl);
  }
  // T28: 注釈色(プリセット6色 + カラーピッカー)・テキストのフォントサイズ(小・中・大)。
  const colorPickerEl = document.querySelector<HTMLElement>("#color-picker");
  if (colorPickerEl) {
    initColorPicker(colorPickerEl);
  }
  const fontSizePickerEl = document.querySelector<HTMLElement>("#font-size-picker");
  if (fontSizePickerEl) {
    initFontSizePicker(fontSizePickerEl);
  }
  if (canvasEl) {
    // T32: 表示canvas = ベース(オフスクリーン)+ オブジェクトの合成。矢印・矩形・円は
    // オブジェクトとして保持し、クリックで選び直してハンドルでリサイズ・移動できる。
    setDocumentSurface(createDocumentSurface(canvasEl));
    bindShapeTools(canvasEl);
    bindMosaicTool(canvasEl);
    // T27: テキストツール(クリック位置に入力欄を重ね、Enter/blurで確定・Escで取消)。
    bindTextTool(canvasEl);
    bindSelectionKeys();
    // T29: 取り消し・やり直し(ボタン + Cmd+Z/Cmd+Shift+Z)。Undo/Redoスタックのクリアは
    // 画像差し替え完了後の`resetDocument()`(`handleCaptureCompleted`/`reloadHistoryItemIntoCanvas`)。
    const undoButtonEl = document.querySelector<HTMLButtonElement>("#undo-button");
    const redoButtonEl = document.querySelector<HTMLButtonElement>("#redo-button");
    if (undoButtonEl && redoButtonEl) {
      initUndoButtons({ undo: undoButtonEl, redo: redoButtonEl });
    }
    // T34: 選択中のオブジェクトの重ね順(最前面へ・最背面へ、⌘⇧F/⌘⇧B)。
    const frontButtonEl = document.querySelector<HTMLButtonElement>("#bring-front-button");
    const backButtonEl = document.querySelector<HTMLButtonElement>("#send-back-button");
    if (frontButtonEl && backButtonEl) {
      initArrangeButtons({ front: frontButtonEl, back: backButtonEl });
    }
  }

  // 空状態の表示切替(T19「空状態も一言 + ショートカット表示程度に」)。
  // 画像読込済みかどうかは`isClipboardCopyEnabled`(コピー可否)と同じ判定
  // (`state.image !== null`)を再利用し、判定ロジックを重複させない。
  const emptyStateEl = document.querySelector<HTMLElement>("#empty-state");
  if (emptyStateEl) {
    const updateEmptyState = (): void => {
      emptyStateEl.hidden = isClipboardCopyEnabled(getCanvasState());
    };
    subscribeCanvasState(updateEmptyState);
    updateEmptyState();
  }

  if (buttonEl && statusEl) {
    // 入口1: ボタンの `invoke` reject(`"permission_denied"`)。
    initCaptureButton(
      { button: buttonEl, status: statusEl },
      showPermissionDeniedBanner,
    );
  }

  // 「クリップボードにコピー」ボタン + Cmd+C(FR-005、T12)。
  const clipboardButtonEl = document.querySelector<HTMLButtonElement>(
    "#clipboard-copy-button",
  );
  const clipboardStatusEl = document.querySelector<HTMLElement>(
    "#clipboard-status",
  );
  if (clipboardButtonEl && clipboardStatusEl) {
    initClipboardButton(
      { button: clipboardButtonEl, status: clipboardStatusEl },
      getClipboardPayload,
      handleClipboardCopySuccess,
    );
  }

  // セッション内履歴サイドバー(FR-010、T14)。
  const sidebarEl = document.querySelector<HTMLElement>("#history-sidebar");
  if (sidebarEl) {
    initSidebar(sidebarEl, {
      captureCurrentAssets: captureCurrentHistoryAssets,
      reloadImage: reloadHistoryItemIntoCanvas,
    });
  }

  // 起動直後から購読を開始する(グローバルショートカット・トレイ起点の
  // キャプチャ結果を受信するため、ARCH §11 フロントエンド初期化順序#2)。
  void onCaptureCompleted(handleCaptureCompleted);

  // 入口2: トレイ・グローバルショートカット起点の `capture://error` イベント
  // (T15で新設、payloadは `invoke` reject値と同じ文字列形式)。
  void onCaptureError((message) => {
    if (isPermissionDeniedError(message)) {
      showPermissionDeniedBanner();
    }
  });

  // 入口3: 起動時の事前確認(ARCH §11 フロントエンド初期化順序#3)。
  void checkScreenRecordingPermission().then((state) => {
    if (shouldShowPermissionBanner(state)) {
      showPermissionDeniedBanner();
    }
  });
});
