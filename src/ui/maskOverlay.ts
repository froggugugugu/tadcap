//! 自動マスキングの候補の印(AM-T12、ARCH_auto-masking §2 #6・§9.1、UI_auto-masking §4、
//! PRD_auto-masking FR-009・FR-010)。
//!
//! - 印は Canvas のピクセルに描かず、Canvas に重ねた DOM のボタン(`.mask-overlay` の中の
//!   `<button class="mask-mark">`)で表示する。コピー・履歴は Canvas を読むため印は写らない
//! - 位置は画像に対する % で置く。`.mask-overlay` は既存の `.shape-overlay` と同じ合わせ方
//!   (`offsetLeft`/`clientWidth` + `ResizeObserver`)で Canvas の表示位置・大きさに合わせる
//! - ラベルは固定の種類名を `textContent` で入れる(外部由来の文字列を DOM に入れない、ARCH §13)
//! - DOM を作る `renderMaskMarks()` と、ストアをつなぐ `initMaskOverlay()` を分ける(ARCH §9.1)。
//!   位置・文言・左右の判定は DOM なしで試せる純粋関数にしてユニットテストする

import type { Rect } from "../canvas/coords";
import {
  getMaskSession,
  subscribeMaskSession,
  toggleCandidate,
  type MaskCandidate,
  type MaskKind,
} from "../canvas/maskSession";

/** 画像の実ピクセルの大きさ。 */
export interface ImageSize {
  width: number;
  height: number;
}

/** 画像に対する % の位置(`left/top/width/height` にそのまま `%` を付けて使う)。 */
export interface PercentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 種類ごとの見た目(UI_auto-masking §4.3)。 */
export interface MaskKindView {
  /** 印の横に出すラベル(`textContent`)。 */
  label: string;
  /** 種類の色を決める CSS クラス。 */
  className: string;
  ariaLabel: string;
}

const KIND_VIEWS: Readonly<Record<MaskKind, MaskKindView>> = {
  contact: { label: "連絡先", className: "mask-mark--contact", ariaLabel: "連絡先の候補" },
  credential: { label: "認証情報", className: "mask-mark--credential", ariaLabel: "認証情報の候補" },
  identifier: { label: "識別子", className: "mask-mark--identifier", ariaLabel: "識別子の候補" },
  financial: { label: "金額・口座", className: "mask-mark--financial", ariaLabel: "金額・口座の候補" },
};

/** 外した印に付けるクラス(破線・塗りなし・薄く・ラベル反転、UI_auto-masking §4.4)。 */
const EXCLUDED_CLASS = "mask-mark--excluded";
/** ラベルを印の左の外側に置くクラス(UI_auto-masking §4.3)。 */
const LABEL_START_CLASS = "mask-mark--label-start";
/** ラベルと印の間(CSS ピクセル)。`.mask-mark__label` の位置と揃える。 */
const LABEL_GAP_CSS = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 画素の矩形を、画像に対する % の位置に変換する。画像の外にはみ出す分は切り詰め、
 * `left + width`・`top + height` が 100 を超えないようにする。画像の大きさが 0 なら全て 0。
 */
export function toPercentRect(rect: Readonly<Rect>, size: ImageSize): PercentRect {
  const axis = (start: number, length: number, total: number): [number, number] => {
    if (!(total > 0)) return [0, 0];
    const from = clamp(start, 0, total);
    const to = clamp(start + length, from, total);
    const fromPct = (from * 100) / total;
    return [fromPct, (to * 100) / total - fromPct];
  };
  const [left, width] = axis(rect.x, rect.width, size.width);
  const [top, height] = axis(rect.y, rect.height, size.height);
  return { left, top, width, height };
}

/** 種類 → ラベル文言・CSS クラス・`aria-label`。 */
export function maskKindView(kind: MaskKind): MaskKindView {
  return KIND_VIEWS[kind];
}

/** `aria-pressed` の値。「モザイクの対象に含めるか」(UI_auto-masking §4.5)。 */
export function markPressed(candidate: MaskCandidate): "true" | "false" {
  return candidate.excluded ? "false" : "true";
}

/** 印のツールチップ(`title`)。 */
export function markTitle(candidate: MaskCandidate): string {
  return candidate.excluded ? "クリックで戻す" : "クリックで外す";
}

/** 2 つの区間が正の長さで重なるか(接するだけは重ならない)。 */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * ラベルを印の右(`"end"`)と左(`"start"`)のどちらに置くかを決める(UI_auto-masking §4.3)。
 * 右に置くと画像の右端からはみ出す、または別の印に重なるときは左。左も同じく置けないときは右。
 *
 * 単位はすべて画像の実ピクセル。`labelWidth` はラベルの幅に印との間を足した横の長さ。
 * ラベルの縦の範囲は印の縦の範囲とみなす(ラベルは印の上下中央にそろえるため)。
 * `others` に自分自身を含めない。
 */
export function labelSide(
  rect: Readonly<Rect>,
  others: readonly Readonly<Rect>[],
  imageWidth: number,
  labelWidth: number,
): "end" | "start" {
  const top = rect.y;
  const bottom = rect.y + rect.height;
  const blocked = (from: number, to: number): boolean =>
    others.some(
      (o) => overlaps(from, to, o.x, o.x + o.width) && overlaps(top, bottom, o.y, o.y + o.height),
    );

  const endFrom = rect.x + rect.width;
  const endTo = endFrom + labelWidth;
  if (endTo <= imageWidth && !blocked(endFrom, endTo)) return "end";

  const startFrom = rect.x - labelWidth;
  const startTo = rect.x;
  if (startFrom >= 0 && !blocked(startFrom, startTo)) return "start";

  return "end";
}

/** Tab の順(画像の上から下、同じ行は左から右)に並べた新しい配列を返す。 */
export function sortMarksForTabOrder(candidates: readonly MaskCandidate[]): MaskCandidate[] {
  return [...candidates].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

// ---- DOM ----

/** 印 1 件の状態(外した/残っている)に応じた属性を当てる。 */
function applyMarkState(button: HTMLButtonElement, candidate: MaskCandidate): void {
  button.setAttribute("aria-pressed", markPressed(candidate));
  button.title = markTitle(candidate);
  button.classList.toggle(EXCLUDED_CLASS, candidate.excluded);
}

function createMark(candidate: MaskCandidate): HTMLButtonElement {
  const view = maskKindView(candidate.kind);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `mask-mark ${view.className}`;
  button.dataset.candidateId = String(candidate.id);
  button.setAttribute("aria-label", view.ariaLabel);
  const label = document.createElement("span");
  label.className = "mask-mark__label";
  label.setAttribute("aria-hidden", "true");
  label.textContent = view.label;
  button.append(label);
  return button;
}

/** 表示中の印を候補の並びと照らし、同じ候補の集まりなら作り直さずに済むか判定する。 */
function sameMarks(buttons: readonly HTMLButtonElement[], ordered: readonly MaskCandidate[]): boolean {
  return (
    buttons.length === ordered.length &&
    buttons.every((button, i) => button.dataset.candidateId === String(ordered[i].id))
  );
}

/**
 * `container`(`.mask-overlay`)の中に候補ごとの印を置く。同じ候補の集まりが表示済みなら
 * 要素を作り直さず状態だけ更新する(外す/戻すでフォーカスを失わないため)。
 * ラベルの左右は表示中の大きさで測って決めるため、`container` が表示されている必要がある。
 */
export function renderMaskMarks(
  container: HTMLElement,
  candidates: readonly MaskCandidate[],
  size: ImageSize,
): void {
  const ordered = sortMarksForTabOrder(candidates);
  let buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".mask-mark"));
  if (!sameMarks(buttons, ordered)) {
    buttons = ordered.map(createMark);
    container.replaceChildren(...buttons);
  }

  // 表示倍率(画像の実ピクセル / CSS ピクセル)。ラベルの幅を画像の単位に直すのに使う。
  const cssWidth = container.clientWidth;
  const imagePerCss = cssWidth > 0 ? size.width / cssWidth : 0;

  ordered.forEach((candidate, i) => {
    const button = buttons[i];
    const p = toPercentRect(candidate.rect, size);
    button.style.left = `${p.left}%`;
    button.style.top = `${p.top}%`;
    button.style.width = `${p.width}%`;
    button.style.height = `${p.height}%`;
    applyMarkState(button, candidate);
  });

  // ラベルの幅は描画後に測る(書き込みと読み取りを分け、レイアウトの計算を 1 回にする)。
  const labelWidths = buttons.map(
    (button) => (button.querySelector<HTMLElement>(".mask-mark__label")?.offsetWidth ?? 0) + LABEL_GAP_CSS,
  );
  ordered.forEach((candidate, i) => {
    const others = ordered.filter((_, j) => j !== i).map((c) => c.rect);
    const side = labelSide(candidate.rect, others, size.width, labelWidths[i] * imagePerCss);
    buttons[i].classList.toggle(LABEL_START_CLASS, side === "start");
  });
}

/** Canvas に重ねる印のレイヤーを作る(Canvas の兄弟要素)。 */
function createOverlay(canvas: HTMLCanvasElement): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.className = "mask-overlay";
  overlay.hidden = true;
  canvas.insertAdjacentElement("afterend", overlay);
  return overlay;
}

/** レイヤーを Canvas の表示位置・大きさに合わせる(`.shape-overlay` と同じ合わせ方)。 */
function alignOverlay(canvas: HTMLCanvasElement, overlay: HTMLElement): void {
  overlay.style.left = `${canvas.offsetLeft}px`;
  overlay.style.top = `${canvas.offsetTop}px`;
  overlay.style.width = `${canvas.clientWidth}px`;
  overlay.style.height = `${canvas.clientHeight}px`;
}

/**
 * 候補の印のレイヤーを Canvas に重ね、`maskSession` を購読する。`review` の間だけ印を出し、
 * 印のクリック(Space・Enter を含む)で `toggleCandidate()` を呼ぶ。戻り値は解除関数。
 */
export function initMaskOverlay(canvas: HTMLCanvasElement): () => void {
  const overlay = createOverlay(canvas);

  const render = (): void => {
    const session = getMaskSession();
    if (session.status !== "review") {
      overlay.hidden = true;
      overlay.replaceChildren();
      return;
    }
    overlay.hidden = false;
    alignOverlay(canvas, overlay);
    renderMaskMarks(overlay, session.candidates, { width: canvas.width, height: canvas.height });
  };

  // 印以外のクリックは何もしない(確認中はレイヤーがポインタを受け、Canvas に届かない)。
  const handleClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    const mark = target?.closest<HTMLButtonElement>(".mask-mark");
    if (!mark || !overlay.contains(mark)) return;
    const id = Number(mark.dataset.candidateId);
    if (Number.isInteger(id)) {
      toggleCandidate(id);
    }
  };
  overlay.addEventListener("click", handleClick);

  const unsubscribe = subscribeMaskSession(render);
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(render);
  resizeObserver?.observe(canvas);
  window.addEventListener("resize", render);
  render();

  return () => {
    unsubscribe();
    resizeObserver?.disconnect();
    window.removeEventListener("resize", render);
    overlay.removeEventListener("click", handleClick);
    overlay.remove();
  };
}
