//! トリミングの帯(QE-T22、UI_quick-edits §4.2・§4.3・§6、ARCH_quick-edits §6.3)。
//!
//! 自動マスキングの結果バーと同じ作り・同じ位置(ツールバー直後の流し込み、`#crop-bar`)。トリミングツールを
//! 選んだ時点で出し(範囲を描き始めてから出すと Canvas の位置が下へずれるため)、ツールを外すと消す。
//! 状態の文(範囲なし: 案内 / 範囲あり: `残す範囲 W × H` + 補足)と「やめる」「確定」を出す。
//! 寸法は`normalizeCropRect()`と同じ四捨五入で整数にした画像の実ピクセル(確定した結果と一致する)。
//! 範囲が画像全体と同じ・幅か高さが 0 のときは確定を押せない(FR-005: 何も変わらない)。
//!
//! `role="status"`の読み上げはポインタを離したときだけにする(ドラッグ中は`aria-busy="true"`で
//! 表示だけを変え、離したら`false`に戻して最後の文を読ませる)。帯の出現でフォーカスは動かさない。
//!
//! 文言の組み立てと確定の可否は純粋関数(`cropBarView`)でユニットテストし、DOM の結線
//! (`initCropBar`)は E2E(QE-T23)で確かめる。

import { getCanvasState, subscribeCanvasState, type ToolId } from "../canvas/canvasState";
import type { Rect } from "../canvas/coords";
import { normalizeCropRect } from "../canvas/crop";
import { cancelCrop, getCropSession, subscribeCropSession } from "../canvas/cropSession";
import { subscribeDocument } from "../canvas/documentState";
import { confirmCrop } from "../canvas/tools/cropTool";

/** 文言(UI_quick-edits §6)。 */
export const CROP_BAR_MESSAGES = {
  empty: "ドラッグで残す範囲を囲んでください。",
  adjustHint: "枠やハンドルで調整できます",
  wholeHint: "画像全体と同じ範囲です",
  cancel: "やめる",
  confirm: "確定",
  /** 確定のトースト(info)。`main.ts`が`onCropped`で出す。 */
  cropped: "切り抜きました。⌘Z で戻せます。",
} as const;

/** 寸法の書式(半角の数字、`×`の前後に半角空白)。 */
export function formatCropSize(width: number, height: number): string {
  return `残す範囲 ${width} × ${height}`;
}

export interface CropBarInput {
  activeTool: ToolId | null;
  /** 確定前の範囲(`cropSession`、画像のピクセル座標)。無ければ`null`。 */
  rect: Rect | null;
  /** ドキュメント(表示 canvas)の大きさ。 */
  canvasWidth: number;
  canvasHeight: number;
  /** 範囲をドラッグ中(`canvasState.isDrawing`)。 */
  dragging: boolean;
}

export interface CropBarView {
  hidden: boolean;
  status: string;
  /** 補足(`--text-muted`)。無ければ空文字。 */
  hint: string;
  /** 「やめる」「確定」を出すか(範囲があるときだけ)。 */
  showButtons: boolean;
  confirmEnabled: boolean;
  /** 読み上げを止めるか(ドラッグ中)。 */
  busy: boolean;
}

/** 帯の表示(UI_quick-edits §4.2・§4.3)。 */
export function cropBarView(input: CropBarInput): CropBarView {
  const hidden = input.activeTool !== "crop";
  if (!input.rect) {
    return { hidden, status: CROP_BAR_MESSAGES.empty, hint: "", showButtons: false, confirmEnabled: false, busy: false };
  }
  const { canvasWidth: w, canvasHeight: h } = input;
  const area = normalizeCropRect(input.rect, w, h);
  const size = area ?? roundedCropSize(input.rect, w, h);
  const whole = area === null && size.width === w && size.height === h && w > 0 && h > 0;
  return {
    hidden,
    status: formatCropSize(size.width, size.height),
    hint: whole ? CROP_BAR_MESSAGES.wholeHint : CROP_BAR_MESSAGES.adjustHint,
    showButtons: true,
    confirmEnabled: area !== null,
    busy: input.dragging,
  };
}

/** `normalizeCropRect()`と同じ四捨五入・切り詰めをした幅・高さ(何もしない範囲の表示用)。 */
function roundedCropSize(rect: Rect, w: number, h: number): { width: number; height: number } {
  const edge = (value: number, size: number): number => Math.min(Math.max(Math.round(value), 0), size);
  const left = edge(Math.min(rect.x, rect.x + rect.width), w);
  const right = edge(Math.max(rect.x, rect.x + rect.width), w);
  const top = edge(Math.min(rect.y, rect.y + rect.height), h);
  const bottom = edge(Math.max(rect.y, rect.y + rect.height), h);
  return { width: right - left, height: bottom - top };
}

// ---- DOM ----

export interface CropBarOptions {
  /** 表示 Canvas(ドキュメントの大きさを読む)。 */
  canvas: HTMLCanvasElement;
  /** 確定ボタンで切り詰めたときに呼ぶ(`main.ts`がトーストを結ぶ。Enter と同じ通知)。 */
  onCropped?: () => void;
}

/**
 * `#crop-bar`(`index.html`のツールバー直後)に帯を組み立て、`canvasState`・`cropSession`・`documentState`と
 * 結線する。戻り値は解除関数。
 */
export function initCropBar(mount: HTMLElement, options: CropBarOptions): () => void {
  mount.replaceChildren();
  mount.hidden = true;

  const status = document.createElement("p");
  status.className = "crop-bar__status";
  status.setAttribute("role", "status");
  const size = document.createElement("span");
  size.className = "crop-bar__size";
  const hint = document.createElement("span");
  hint.className = "crop-bar__hint";
  status.append(size, hint);

  const cancel = createButton("mask-bar__button", CROP_BAR_MESSAGES.cancel, "esc");
  const confirm = createButton("mask-bar__button mask-bar__button--primary", CROP_BAR_MESSAGES.confirm, "return");
  mount.append(status, cancel, confirm);

  const render = (): void => {
    const { activeTool, isDrawing } = getCanvasState();
    const view = cropBarView({
      activeTool,
      rect: getCropSession()?.rect ?? null,
      canvasWidth: options.canvas.width,
      canvasHeight: options.canvas.height,
      dragging: isDrawing,
    });
    mount.hidden = view.hidden;
    status.setAttribute("aria-busy", view.busy ? "true" : "false");
    // 同じ文言の再代入で読み上げが繰り返されないよう、変わったときだけ書く
    if (size.textContent !== view.status) size.textContent = view.status;
    if (hint.textContent !== view.hint) hint.textContent = view.hint;
    hint.hidden = view.hint === "";
    cancel.hidden = !view.showButtons;
    confirm.hidden = !view.showButtons;
    confirm.disabled = !view.confirmEnabled;
  };

  const handleCancel = (): void => cancelCrop();
  const handleConfirm = (): void => {
    confirmCrop(options.onCropped);
  };
  cancel.addEventListener("click", handleCancel);
  confirm.addEventListener("click", handleConfirm);
  const unsubscribers = [
    subscribeCanvasState(render),
    subscribeCropSession(render),
    subscribeDocument(render),
  ];
  render();

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    cancel.removeEventListener("click", handleCancel);
    confirm.removeEventListener("click", handleConfirm);
    mount.replaceChildren();
    mount.hidden = true;
  };
}

/** 帯のボタン(ラベル + キーの表示)。`.mask-bar__button`を共用する(UI_quick-edits §4.3)。 */
function createButton(className: string, label: string, keyLabel: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  const text = document.createElement("span");
  text.textContent = label;
  const key = document.createElement("kbd");
  key.className = "mask-bar__key";
  key.textContent = keyLabel;
  button.append(text, key);
  return button;
}
