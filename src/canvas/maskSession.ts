//! 自動マスキングの候補と処理の状態(ARCH_auto-masking §6.1〜§6.3・§7.1、
//! PRD_auto-masking FR-001・FR-010・FR-012、AM-T06)。
//!
//! `canvasState.ts` と同じ作法(純粋な遷移関数 + モジュール単位の薄いストア)で実装する。
//! 状態は `idle → scanning → review → idle` の 3 つだけで、失敗は状態として残さず
//! `idle` に戻す(ARCH §6.1)。メモリ上のみで永続化しない(ARCH §6.2、NFR-002)。
//!
//! - 候補は**文字列を持たない**(ARCH §6.1)。`acceptScanResult()` は入力から
//!   矩形の数値と種類だけを写し、余分なフィールドが紛れ込んでも保持しない
//! - 開始時に `token` と表示中の `CanvasImage`(参照)を記録し、結果を受け取った時点で
//!   両方が一致しなければ捨てる(ARCH §2 #8、FR-001)
//! - `src/ipc/`・`src/ui/` に依存しない(ARCH §3.2)。`CanvasImage` は参照として
//!   記録するだけで `canvasState` を書き換えない(ARCH §6.3)

import { isSameCanvasImage, type CanvasImage } from "./canvasState";
import type { Rect } from "./coords";

/** 候補の種類(ARCH §3.2: `MaskKind` は本ファイルで定義する。IPC の `kind` と同じ値)。 */
export type MaskKind = "contact" | "credential" | "identifier" | "financial";

/** 画面側の候補 1 件。矩形は画像の実ピクセル(整数・左上原点)。文字列は持たない。 */
export interface MaskCandidate {
  /** セッション内で一意な番号(印のクリックで `toggleCandidate()` に渡す)。 */
  readonly id: number;
  readonly rect: Readonly<Rect>;
  readonly kind: MaskKind;
  /** 一括モザイクの対象から外したか(FR-010)。 */
  readonly excluded: boolean;
}

/** `acceptScanResult()` へ渡す候補(`ui/autoMask.ts` が IPC の応答から詰め替える)。 */
export interface MaskCandidateInput {
  readonly rect: Readonly<Rect>;
  readonly kind: MaskKind;
}

export type MaskSessionState =
  | { readonly status: "idle" }
  | { readonly status: "scanning"; readonly token: number; readonly image: CanvasImage }
  | {
      readonly status: "review";
      readonly token: number;
      readonly image: CanvasImage;
      readonly candidates: readonly MaskCandidate[];
    };

const IDLE: MaskSessionState = Object.freeze({ status: "idle" });

// ---- 純粋な遷移関数(状態が変わらないときは同じオブジェクトを返す) ----

/** idle のときだけ scanning へ。scanning・review 中は何もしない(二重実行の防止)。 */
function startScan(state: MaskSessionState, token: number, image: CanvasImage): MaskSessionState {
  if (state.status !== "idle") return state;
  return { status: "scanning", token, image };
}

/** scanning 中で token と画像が一致したときだけ review へ。それ以外の結果は捨てる。 */
function receiveResult(
  state: MaskSessionState,
  token: number,
  image: CanvasImage,
  inputs: readonly MaskCandidateInput[],
): MaskSessionState {
  if (state.status !== "scanning") return state;
  if (state.token !== token || !isSameCanvasImage(state.image, image)) return state;
  const candidates = inputs.map(
    (input, index): MaskCandidate => ({
      id: index,
      // 文字列が紛れ込まないよう、数値と種類だけを明示的に写す
      rect: {
        x: input.rect.x,
        y: input.rect.y,
        width: input.rect.width,
        height: input.rect.height,
      },
      kind: input.kind,
      excluded: false,
    }),
  );
  return { status: "review", token: state.token, image: state.image, candidates };
}

/** scanning 中で token が一致したときだけ idle へ(古い処理の失敗で今の処理を止めない)。 */
function receiveFailure(state: MaskSessionState, token: number): MaskSessionState {
  if (state.status !== "scanning" || state.token !== token) return state;
  return IDLE;
}

/** review 中に該当 id の `excluded` を反転する。該当が無ければ何もしない。 */
function toggle(state: MaskSessionState, id: number): MaskSessionState {
  if (state.status !== "review") return state;
  if (!state.candidates.some((c) => c.id === id)) return state;
  return {
    ...state,
    candidates: state.candidates.map((c) => (c.id === id ? { ...c, excluded: !c.excluded } : c)),
  };
}

// ---- シングルトンストア ----

type Listener = (state: MaskSessionState) => void;

let state: MaskSessionState = IDLE;
let lastToken = 0;
const listeners = new Set<Listener>();

/** 現在の状態を返す(読み取り用)。 */
export function getMaskSession(): MaskSessionState {
  return state;
}

/**
 * 表示中の画像で読み取りを始める。新しい token を発行して `scanning` へ進め、その token を返す。
 * `scanning`・`review` 中は何もせず `null` を返す(FR-001 の二重実行防止)。
 */
export function beginScan(image: CanvasImage): number | null {
  if (state.status !== "idle") return null;
  lastToken += 1;
  commit(startScan(state, lastToken, image));
  return lastToken;
}

/**
 * 読み取り結果を受け取る。token と画像が開始時と一致すれば `review` へ進めて `true`。
 * 古い token・別の画像・`scanning` 以外の状態なら捨てて `false`(状態は変えない)。
 */
export function acceptScanResult(
  token: number,
  image: CanvasImage,
  candidates: readonly MaskCandidateInput[],
): boolean {
  const next = receiveResult(state, token, image, candidates);
  if (next === state) return false;
  commit(next);
  return true;
}

/** 読み取りの失敗を受け取り `idle` に戻す(利用者への通知は呼び出し側のトースト)。 */
export function failScan(token: number): void {
  commit(receiveFailure(state, token));
}

/** 候補を外す/戻す(FR-010)。 */
export function toggleCandidate(id: number): void {
  commit(toggle(state, id));
}

/** 一括モザイクの対象(外していない候補の矩形のコピー)を入力の順に返す。review 以外は空。 */
export function activeRects(): Rect[] {
  if (state.status !== "review") return [];
  return state.candidates.filter((c) => !c.excluded).map((c) => ({ ...c.rect }));
}

/** どの状態からも `idle` に戻し候補を捨てる(一括モザイク後・やめる・Esc・画像の切替前)。 */
export function discardMaskSession(): void {
  commit(IDLE);
}

/** 状態変化を購読する。戻り値の関数を呼ぶと購読解除する。 */
export function subscribeMaskSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 状態が変わったときだけ差し替えて購読者へ通知する。 */
function commit(next: MaskSessionState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) {
    listener(state);
  }
}
