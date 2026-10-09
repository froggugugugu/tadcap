//! 自動マスキングの実行の組み立て(AM-T15、ARCH_auto-masking §7.1 手順 1〜12・§9.1、
//! UI_auto-masking §1〜§3・§5、PRD_auto-masking FR-001・FR-008・FR-011・FR-012・FR-014)。
//!
//! - 実行ボタン(取り消し/やり直しとコピーの間)・⌘⇧M・処理中の帯・結果バー(件数・やめる・
//!   まとめてモザイク / 0 件の文言と閉じる)・失敗と完了のトースト・Esc でやめる
//! - 手順: `commitPendingText()` → `beginScan()` → `exportDocumentBase()` → 前の invoke の完了を待つ →
//!   `scanSensitiveText()` → 受け取った矩形を `clipRectToCanvas()` で収め直す → `acceptScanResult()`
//! - 実行中の invoke を 1 つだけ保持し、終わるまで次を送らない(Rust の `text_scan_busy` を通常は起こさない)
//! - まとめてモザイクは `applyBaseEdits(activeRects(), pixelateRect)` で 1 手として積み、`discardMaskSession()`
//! - 開始時に選択を外す。表示中の画像が開始時と違ってきたら候補を捨てる(AM-T25-F1)
//! - 候補・読み取り結果を `console`・ストレージ・履歴に残さない(NFR-002)。失敗の詳細も画面に出さない
//!
//! 判定と文言は DOM なしで試せる純粋関数、実行の流れは入出力を差し込む `createAutoMaskController()`、
//! DOM の結線は `initAutoMask()` に分ける(ARCH §9.1)。

import { getCanvasState, isSameCanvasImage, subscribeCanvasState, type CanvasImage } from "../canvas/canvasState";
import { clipRectToCanvas, type Rect } from "../canvas/coords";
import { applyBaseEdits, exportDocumentBase, selectObject } from "../canvas/documentState";
import {
  acceptScanResult,
  activeRects,
  beginScan,
  discardMaskSession,
  failScan,
  getMaskSession,
  subscribeMaskSession,
  type MaskCandidateInput,
  type MaskSessionState,
} from "../canvas/maskSession";
import { commitPendingText } from "../canvas/tools/textTool";
import { pixelateRect } from "../canvas/tools/mosaicTool";
import { scanSensitiveText, type ScannedCandidate } from "../ipc/textScan";
import { isEditableTarget, type EditableTargetLike } from "./shortcutGuards";
import { showToast, type ToastKind } from "./toast";

// ---- 文言(UI_auto-masking §5.2。禁止語を含まないことをユニットテストで確かめる) ----

export const AUTO_MASK_MESSAGES = {
  buttonLabel: "機密らしい箇所を探す(⌘⇧M)",
  scanning: "機密らしい箇所を探しています…",
  resultHint: "印をクリックすると外せます。見落としがないか目でも確かめてください。",
  empty: "候補は見つかりませんでした。",
  emptyHint: "貼る前に画像を目で確かめてください。",
  cancel: "やめる",
  apply: "まとめてモザイク",
  close: "閉じる",
  failed: "文字を読み取れませんでした。画像は変更していません。",
  applied: (count: number): string => `候補 ${count} 件にモザイクをかけました。⌘Z で戻せます。`,
} as const;

/** 件数の文(`候補 n 件` / `候補 n 件(うち m 件を外しています)`)。 */
export function resultStatusText(total: number, excluded: number): string {
  return excluded > 0 ? `候補 ${total} 件(うち ${excluded} 件を外しています)` : `候補 ${total} 件`;
}

// ---- 判定(純粋関数) ----

/**
 * 開始できるか: 画像があり `idle` で、ドラッグ中でないとき(ボタンの有効・無効も同じ判定、UI 仕様 §1.4)。
 * ドラッグ中はベースが書き換わる途中のため始めない(AM-T25-F1 SHOULD-1)。
 */
export function canStartScan(hasImage: boolean, session: MaskSessionState, isDrawing = false): boolean {
  return hasImage && session.status === "idle" && !isDrawing;
}

export interface AutoMaskKeyEvent {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}

/** ⌘⇧M か(入力欄・IME 変換中・Ctrl/Option 併用では奪わない)。 */
export function isAutoMaskShortcut(event: AutoMaskKeyEvent, target: EditableTargetLike | null): boolean {
  if (!event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey || event.isComposing) {
    return false;
  }
  return event.key.toLowerCase() === "m" && !isEditableTarget(target);
}

/** 確認中の Esc(修飾キーなし)か。処理中の Esc は扱わない(読み取りの中断は作らない、UI 仕様 §2)。 */
export function isCancelMaskKey(
  event: AutoMaskKeyEvent,
  target: EditableTargetLike | null,
  session: MaskSessionState,
): boolean {
  if (session.status !== "review" || event.key !== "Escape" || event.isComposing) {
    return false;
  }
  if (event.metaKey || event.shiftKey || event.ctrlKey || event.altKey) {
    return false;
  }
  return !isEditableTarget(target);
}

/** まとめてモザイクを押せるか: 確認中で、外していない候補が 1 件以上(FR-011)。 */
export function canApplyMosaic(session: MaskSessionState): boolean {
  return session.status === "review" && session.candidates.some((c) => !c.excluded);
}

/**
 * IPC の応答を `maskSession` の入力へ詰め替える。矩形は表示中の画像の幅・高さで収め直し
 * (ARCH §7.2)、面積が 0 になったものは捨てる。種類と矩形の数値だけを写す。
 */
export function toMaskCandidateInputs(
  scanned: readonly ScannedCandidate[],
  size: { width: number; height: number },
): MaskCandidateInput[] {
  const inputs: MaskCandidateInput[] = [];
  for (const c of scanned) {
    const rect = clipRectToCanvas({ x: c.x, y: c.y, width: c.width, height: c.height }, size.width, size.height);
    if (rect.width > 0 && rect.height > 0) {
      inputs.push({ rect, kind: c.kind });
    }
  }
  return inputs;
}

/** 結果バーの表示内容(UI 仕様 §2・§3)。 */
export interface MaskBarView {
  hidden: boolean;
  /** 処理中の回転するリングを出すか。 */
  busy: boolean;
  status: string;
  hint: string;
  /** 「やめる」/「閉じる」の文言。出さないときは `null`。 */
  dismissLabel: string | null;
  showApply: boolean;
  applyEnabled: boolean;
}

export function maskBarView(session: MaskSessionState): MaskBarView {
  const base: MaskBarView = {
    hidden: false,
    busy: false,
    status: "",
    hint: "",
    dismissLabel: null,
    showApply: false,
    applyEnabled: false,
  };
  switch (session.status) {
    case "idle":
      return { ...base, hidden: true };
    case "scanning":
      return { ...base, busy: true, status: AUTO_MASK_MESSAGES.scanning };
    case "review": {
      const total = session.candidates.length;
      if (total === 0) {
        return {
          ...base,
          status: AUTO_MASK_MESSAGES.empty,
          hint: AUTO_MASK_MESSAGES.emptyHint,
          dismissLabel: AUTO_MASK_MESSAGES.close,
        };
      }
      const excluded = session.candidates.filter((c) => c.excluded).length;
      return {
        ...base,
        status: resultStatusText(total, excluded),
        hint: AUTO_MASK_MESSAGES.resultHint,
        dismissLabel: AUTO_MASK_MESSAGES.cancel,
        showApply: true,
        applyEnabled: canApplyMosaic(session),
      };
    }
  }
}

// ---- 実行の流れ(入出力を差し込む) ----

export interface AutoMaskDeps {
  /** 表示中の画像(`canvasState.image`)。 */
  getImage: () => CanvasImage | null;
  /** 表示中のベースの実ピクセルの大きさ。 */
  getImageSize: () => { width: number; height: number };
  /** ドラッグ中か(`canvasState.isDrawing`)。 */
  isDrawing: () => boolean;
  commitPendingText: () => void;
  /**
   * 選択中のオブジェクトの選択を外す(`selectObject(null)`)。確認中に色・文字サイズの選択が
   * Canvas に効かない前提(UI 仕様 §6)を開始時に成り立たせる(AM-T25-F1 SHOULD-2)。
   */
  clearSelection: () => void;
  /** ベースの PNG(注釈のオブジェクトを含まない)。 */
  exportBase: () => Promise<Blob>;
  scan: (png: Blob) => Promise<ScannedCandidate[]>;
  /** `documentState.applyBaseEdits()`(矩形ごとの描画を 1 手として積む)。戻り値は実際に加工した件数。 */
  applyBaseEdits: (rects: readonly Rect[], draw: (ctx: CanvasRenderingContext2D, rect: Rect) => void) => number;
  /** トースト(失敗・一括モザイク後)。 */
  notify: (message: string, kind: ToastKind) => void;
}

export interface AutoMaskController {
  /** 読み取りを始める(ボタン・⌘⇧M)。開始できない状態では何もしない。結果の反映まで待てる。 */
  start: () => Promise<void>;
  /** まとめてモザイク(残り 0 件・確認中以外では何もしない)。 */
  applyMosaic: () => void;
  /** やめる・閉じる・Esc。 */
  cancel: () => void;
}

/** 開始時の token のまま `scanning` か(画像の切替・やめるで破棄されていないか)。 */
function isCurrentScan(token: number): boolean {
  const session = getMaskSession();
  return session.status === "scanning" && session.token === token;
}

export function createAutoMaskController(deps: AutoMaskDeps): AutoMaskController {
  /** 実行中の invoke(成否に関わらず完了で解決する)。次の invoke はこれを待ってから送る。 */
  let inFlight: Promise<void> = Promise.resolve();

  const start = async (): Promise<void> => {
    const image = deps.getImage();
    if (!image || !canStartScan(true, getMaskSession(), deps.isDrawing())) {
      return;
    }
    deps.commitPendingText();
    deps.clearSelection();
    const token = beginScan(image);
    if (token === null) {
      return;
    }

    const previous = inFlight;
    const job = (async (): Promise<ScannedCandidate[] | null> => {
      const png = await deps.exportBase();
      await previous;
      // 待っている間に画像の切替・やめるで破棄されていれば送らない
      if (!isCurrentScan(token)) {
        return null;
      }
      return deps.scan(png);
    })();
    inFlight = job.then(
      () => undefined,
      () => undefined,
    );

    let scanned: ScannedCandidate[] | null;
    try {
      scanned = await job;
    } catch {
      // 古い実行の失敗は知らせない(利用者はもう別の画像を見ている)。詳細は出さない(NFR-002)
      if (isCurrentScan(token)) {
        failScan(token);
        deps.notify(AUTO_MASK_MESSAGES.failed, "error");
      }
      return;
    }
    if (scanned === null) {
      return;
    }
    const current = deps.getImage();
    if (!current) {
      failScan(token);
      return;
    }
    // token・画像が開始時と違えば `acceptScanResult()` が捨てる(FR-001)。捨てたのが今の処理なら
    // (画像の差し替えの隙間に始めた場合など)`scanning` のまま残さず idle に戻す。古い画像の結果
    // なので失敗のトーストは出さない(AM-T25-F1 MUST-1)
    const accepted = acceptScanResult(token, current, toMaskCandidateInputs(scanned, deps.getImageSize()));
    if (!accepted && isCurrentScan(token)) {
      failScan(token);
    }
  };

  const applyMosaic = (): void => {
    if (!canApplyMosaic(getMaskSession())) {
      return;
    }
    const rects = activeRects();
    const { width, height } = deps.getImageSize();
    const applied = deps.applyBaseEdits(rects, (ctx, rect) => pixelateRect(ctx, rect, width, height));
    discardMaskSession();
    // 件数は実際に加工した数。1 件も加工できなければ(サーフェスが無い等)画像は変わっていないので
    // 失敗として知らせる(AM-T25-F1 C-1)
    if (applied > 0) {
      deps.notify(AUTO_MASK_MESSAGES.applied(applied), "info");
    } else {
      deps.notify(AUTO_MASK_MESSAGES.failed, "error");
    }
  };

  const cancel = (): void => {
    discardMaskSession();
  };

  return { start, applyMosaic, cancel };
}

/**
 * 表示中の画像が処理中・確認中の画像と違ってきたら候補を捨てる(`canvasState` を購読する)。
 * 画像の差し替え(新規キャプチャ・履歴の切替)は `discardMaskSession()` の後に await を挟んでから
 * 画像が変わるため、その隙間に始めた処理・届いた結果が新しい画像に残らないようにする
 * (AM-T25-F1 MUST-1)。戻り値は購読の解除関数。
 */
export function bindMaskSessionToCanvasImage(): () => void {
  return subscribeCanvasState(({ image }) => {
    const session = getMaskSession();
    if (session.status !== "idle" && !isSameCanvasImage(session.image, image)) {
      discardMaskSession();
    }
  });
}

// ---- DOM ----

/** 実行ボタンのアイコン(UI 仕様 §1.2: 走査の四隅の枠 + 2 本の文字の行)。 */
const BUTTON_ICON_SVG =
  '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
  '<path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M13 3h2.5A1.5 1.5 0 0 1 17 4.5V7M17 13v2.5a1.5 1.5 0 0 1-1.5 1.5H13M7 17H4.5A1.5 1.5 0 0 1 3 15.5V13" ' +
  'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />' +
  '<path d="M6.5 8h7M6.5 12h4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />' +
  "</svg>";

/**
 * 実行ボタンと区切り線を `before`(コピーボタン)の前に置く。既存の区切り線(取り消し/やり直しの後)は
 * そのまま使い、ボタンの後ろに 1 本足す(UI 仕様 §1.1)。トグル表示は持たない(`aria-pressed` なし)。
 */
function createButton(before: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = "auto-mask-button";
  button.type = "button";
  button.className = "icon-button";
  button.disabled = true;
  button.setAttribute("aria-label", AUTO_MASK_MESSAGES.buttonLabel);
  button.title = AUTO_MASK_MESSAGES.buttonLabel;
  button.innerHTML = BUTTON_ICON_SVG; // 固定のアイコンだけ(外部由来の文字列は入れない)
  const divider = document.createElement("div");
  divider.className = "toolbar__divider";
  divider.setAttribute("aria-hidden", "true");
  before.before(button, divider);
  return button;
}

interface MaskBarElements {
  bar: HTMLDivElement;
  spinner: HTMLSpanElement;
  count: HTMLSpanElement;
  hint: HTMLSpanElement;
  dismiss: HTMLButtonElement;
  dismissLabel: HTMLSpanElement;
  dismissKey: HTMLElement;
  apply: HTMLButtonElement;
}

/** 結果バーをツールバーの直後に流し込みで置く(UI 仕様 §3.1)。 */
function createMaskBar(toolbar: HTMLElement): MaskBarElements {
  const bar = document.createElement("div");
  bar.id = "mask-bar";
  bar.className = "mask-bar";
  bar.hidden = true;

  const spinner = document.createElement("span");
  spinner.className = "mask-bar__spinner";
  spinner.setAttribute("aria-hidden", "true");

  const status = document.createElement("p");
  status.className = "mask-bar__status";
  status.setAttribute("role", "status");
  const count = document.createElement("span");
  count.className = "mask-bar__count";
  const hint = document.createElement("span");
  hint.className = "mask-bar__hint";
  status.append(count, hint);

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "mask-bar__button";
  const dismissLabel = document.createElement("span");
  const dismissKey = document.createElement("kbd");
  dismissKey.className = "mask-bar__key";
  dismissKey.textContent = "esc";
  dismiss.append(dismissLabel, dismissKey);

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "mask-bar__button mask-bar__button--primary";
  apply.textContent = AUTO_MASK_MESSAGES.apply;

  bar.append(spinner, status, dismiss, apply);
  toolbar.insertAdjacentElement("afterend", bar);
  return { bar, spinner, count, hint, dismiss, dismissLabel, dismissKey, apply };
}

function renderMaskBar(el: MaskBarElements, view: MaskBarView): void {
  el.bar.hidden = view.hidden;
  el.spinner.hidden = !view.busy;
  // 同じ文言の再代入で読み上げが繰り返されないよう、変わったときだけ書く
  if (el.count.textContent !== view.status) el.count.textContent = view.status;
  if (el.hint.textContent !== view.hint) el.hint.textContent = view.hint;
  el.hint.hidden = view.hint === "";
  el.dismiss.hidden = view.dismissLabel === null;
  el.dismissLabel.textContent = view.dismissLabel ?? "";
  // esc のキー表示は「やめる」にだけ付ける(0 件の「閉じる」は Esc でも閉じるが表示は 1 語)
  el.dismissKey.hidden = view.dismissLabel !== AUTO_MASK_MESSAGES.cancel;
  el.apply.hidden = !view.showApply;
  el.apply.disabled = !view.applyEnabled;
}

export interface AutoMaskElements {
  /** `header.toolbar`(結果バーをこの直後に置く)。 */
  toolbar: HTMLElement;
  /** `#clipboard-copy-button`(実行ボタンをこの前に置く)。 */
  copyButton: HTMLElement;
  /** 表示 Canvas(ベースと同じ実ピクセルの大きさ)。 */
  canvas: HTMLCanvasElement;
  /** トーストの要素(`#capture-status`)。 */
  status: HTMLElement;
}

/**
 * 実行ボタン・結果バー・⌘⇧M・Esc を結線する(Container 相当)。戻り値は解除関数。
 * Esc の keydown は `selectionKeys` より先に登録し、処理したら `preventDefault()` する
 * (`selectionKeys` は defaultPrevented のイベントを無視する。やめた直後の選択解除を防ぐ)。
 */
export function initAutoMask(elements: AutoMaskElements): () => void {
  const button = createButton(elements.copyButton);
  const bar = createMaskBar(elements.toolbar);
  const controller = createAutoMaskController({
    getImage: () => getCanvasState().image,
    getImageSize: () => ({ width: elements.canvas.width, height: elements.canvas.height }),
    isDrawing: () => getCanvasState().isDrawing,
    commitPendingText,
    clearSelection: () => selectObject(null),
    exportBase: exportDocumentBase,
    scan: scanSensitiveText,
    applyBaseEdits,
    notify: (message, kind) => showToast(elements.status, message, kind),
  });

  const render = (): void => {
    const session = getMaskSession();
    const { image, isDrawing } = getCanvasState();
    button.disabled = !canStartScan(image !== null, session, isDrawing);
    renderMaskBar(bar, maskBarView(session));
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) {
      return;
    }
    const target = event.target as EditableTargetLike | null;
    if (isAutoMaskShortcut(event, target)) {
      event.preventDefault();
      void controller.start();
      return;
    }
    if (isCancelMaskKey(event, target, getMaskSession())) {
      event.preventDefault();
      controller.cancel();
    }
  };

  const handleStart = (): void => void controller.start();
  button.addEventListener("click", handleStart);
  bar.dismiss.addEventListener("click", controller.cancel);
  bar.apply.addEventListener("click", controller.applyMosaic);
  window.addEventListener("keydown", handleKeydown);
  // 画像の変化で候補を捨てる購読を、表示の購読より先に登録する(捨てた後の状態で描く)
  const unbindImage = bindMaskSessionToCanvasImage();
  const unsubscribeSession = subscribeMaskSession(render);
  const unsubscribeCanvas = subscribeCanvasState(render);
  render();

  return () => {
    unbindImage();
    unsubscribeSession();
    unsubscribeCanvas();
    window.removeEventListener("keydown", handleKeydown);
    button.removeEventListener("click", handleStart);
    bar.dismiss.removeEventListener("click", controller.cancel);
    bar.apply.removeEventListener("click", controller.applyMosaic);
    button.nextElementSibling?.remove();
    button.remove();
    bar.bar.remove();
  };
}
