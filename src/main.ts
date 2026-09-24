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
import { commitPendingShape } from "./canvas/pendingShape";
import { bindMosaicTool } from "./canvas/tools/mosaicTool";
import { bindShapeTools } from "./canvas/tools/shapeTools";
import { bindTextTool, commitPendingText } from "./canvas/tools/textTool";
import { clearUndoStack } from "./canvas/undoStack";
import {
  addHistoryItem,
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
import { bindPendingShapeKeys } from "./ui/pendingShapeKeys";
import { initSidebar } from "./ui/sidebar";
import { initToolbar } from "./ui/toolbar";
import { initUndoButtons } from "./ui/undoButton";

let canvasEl: HTMLCanvasElement | null = null;
let statusEl: HTMLElement | null = null;
let permissionBanner: PermissionBannerController | null = null;

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
    // T31/T27: 差し替え前に入力中のテキスト・編集中の図形を確定し、下の履歴保存に含める。
    commitPendingText();
    commitPendingShape();
    if (
      canvasEl.width > 0 &&
      canvasEl.height > 0 &&
      !getCanvasState().isDrawing
    ) {
      const currentAssets = await captureHistoryAssets(canvasEl);
      updateSelectedItemImage(currentAssets);
    }
    const blob = await readCaptureImage(result.sourcePath);
    objectUrl = URL.createObjectURL(blob);
    const image = await loadImage(objectUrl);
    renderImageToCanvas(canvasEl, image);
    setCanvasImage({ assetUrl: objectUrl, capture: result });
    // T24: Canvas差し替え完了後にUndo/Redoスタックをクリアし、取り消し対象を常に
    // 「現在表示中の画像」に限定する(ARCH §5.2・§6.3、PRD §5、T23申し送り)。
    clearUndoStack();
    const assets = await captureHistoryAssets(canvasEl);
    addHistoryItem({
      id: result.id,
      image: assets.image,
      thumbnail: assets.thumbnail,
      createdAt: result.createdAt,
    });
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
  // T31/T27: コピー前に入力中のテキスト・編集中の図形を確定する(ハンドル・入力欄はCanvasに
  // 重ねたDOMのため元々写らない)。
  commitPendingText();
  commitPendingShape();
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
  // T31/T27: 履歴切替で差し替える前に入力中のテキスト・編集中の図形を確定し、保存内容に含める。
  commitPendingText();
  commitPendingShape();
  return captureHistoryAssets(canvasEl);
}

async function reloadHistoryItemIntoCanvas(item: HistoryItem): Promise<void> {
  if (!canvasEl) {
    return;
  }
  try {
    const image = await loadImage(item.image);
    renderImageToCanvas(canvasEl, image);
    setCanvasImage({ assetUrl: item.image, capture: null });
    // T24: Canvas差し替え完了後にUndo/Redoスタックをクリアする(handleCaptureCompletedと
    // 同じ理由、ARCH §5.2・§6.3)。
    clearUndoStack();
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
    // T31: 矢印・矩形・円は共通の結線(直前に描いた図形を編集中として保持し、ハンドルで
    // リサイズ・移動)。Enterで確定・Escで破棄。
    bindShapeTools(canvasEl);
    bindMosaicTool(canvasEl);
    // T27: テキストツール(クリック位置に入力欄を重ね、Enter/blurで確定・Escで取消)。
    bindTextTool(canvasEl);
    bindPendingShapeKeys();
    // T29: 取り消し・やり直し(ボタン + Cmd+Z/Cmd+Shift+Z)。Undo/Redoスタックのクリアは
    // 画像差し替え完了後(`handleCaptureCompleted`/`reloadHistoryItemIntoCanvas`、T24で結線済み)。
    const undoButtonEl = document.querySelector<HTMLButtonElement>("#undo-button");
    const redoButtonEl = document.querySelector<HTMLButtonElement>("#redo-button");
    if (undoButtonEl && redoButtonEl) {
      initUndoButtons({ undo: undoButtonEl, redo: redoButtonEl }, canvasEl);
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
