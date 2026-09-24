//! Canvasの現在表示中画像・選択中ツール・描画中フラグの状態(ARCH §3.1 フロントエンド
//! Canvas 層、§6.1)。
//!
//! 状態管理ライブラリは導入せず、モジュール単位の薄い状態オブジェクトで
//! 表現する(ARCH §1.3 決定#1)。T07で「現在の画像」を追加し、T09で
//! 選択中ツール(`activeTool`)・描画中フラグ(`isDrawing`)を追加した。
//!
//! `src/canvas/` は `src/ui/` に依存しない(ARCH §3.2 依存方向ルール)。
//!
//! T14で「セッション内履歴からの再読込」に対応するため、`CanvasImage.capture`を
//! nullable化した(履歴項目の`image`はCanvas上で編集済みのObjectURLであり、
//! 元になった単一の`CaptureResult`と一対一に対応しないため。`src/main.ts`が
//! 履歴再読込時に`capture: null`を渡す)。

import type { CaptureResult } from "../ipc/capture";

/** Canvasに表示中の画像(描画元URL + 元になったキャプチャ結果)。 */
export interface CanvasImage {
  /**
   * Canvasへの描画元URL。キャプチャ直後は `read_capture_image` のバイト列から作った
   * ObjectURL(描画後に解放済みのため再読込には使わない)、履歴再読込時は履歴項目の
   * ObjectURL。フィールド名はasset URL時代の名残(実機不具合②〜⑤でasset URLは廃止)。
   */
  assetUrl: string;
  /**
   * 元になったキャプチャ結果(メタデータ保持用)。セッション内履歴からの再読込時は
   * `null`(T14。再読込対象は編集後画像であり、単一の`CaptureResult`と対応しないため)。
   */
  capture: CaptureResult | null;
}

/** 編集ツールの識別子(T09で型定義、T10で `ui/toolbar.ts` に `"mosaic"` の選択肢を追加、
 * T25で `"rectangle"` を追加した。T26で `"ellipse"` を追加した。T27で `"text"` を追加した)。 */
export type ToolId = "arrow" | "mosaic" | "rectangle" | "ellipse" | "text";

export interface CanvasState {
  image: CanvasImage | null;
  /** 選択中のツール。未選択は `null`(T09)。 */
  activeTool: ToolId | null;
  /** ドラッグによる描画中かどうか(T09)。ツール切替UIがドラッグ中の切替を防ぐ等に使う。 */
  isDrawing: boolean;
}

/** 画像なし・ツール未選択・非描画中の初期状態を返す純粋関数。 */
export function createCanvasState(): CanvasState {
  return { image: null, activeTool: null, isDrawing: false };
}

/** 画像をセットした新しい状態を返す純粋関数(イミュータブル)。 */
export function withImage(state: CanvasState, image: CanvasImage): CanvasState {
  return { ...state, image };
}

/** 画像をクリアした新しい状態を返す純粋関数(イミュータブル)。 */
export function withoutImage(state: CanvasState): CanvasState {
  return { ...state, image: null };
}

/** 選択中ツールをセットした新しい状態を返す純粋関数(イミュータブル、T09)。 */
export function withActiveTool(
  state: CanvasState,
  tool: ToolId | null,
): CanvasState {
  return { ...state, activeTool: tool };
}

/**
 * 指定したツールを選択中なら解除(`null`)し、そうでなければそのツールへ切り替える
 * 純粋関数(トグル、T09)。ツールバーのボタンクリックが呼ぶ想定。
 */
export function toggleTool(state: CanvasState, tool: ToolId): CanvasState {
  return withActiveTool(state, state.activeTool === tool ? null : tool);
}

/** 描画中フラグをセットした新しい状態を返す純粋関数(イミュータブル、T09)。 */
export function withDrawing(state: CanvasState, isDrawing: boolean): CanvasState {
  return { ...state, isDrawing };
}

/**
 * 2つの `CanvasImage`(または`null`)が同一かを参照比較する純粋関数(MUST-1、
 * レビュー2026-09-24)。
 *
 * `setCanvasImage()` は新規キャプチャ完了(`main.ts::handleCaptureCompleted`)・
 * 履歴再読込(`main.ts::reloadHistoryItemIntoCanvas`)のたびに必ず新しいオブジェクト
 * リテラルを渡すため、参照が異なれば「Canvasの表示内容が非同期に差し替えられた」と
 * 判定できる。矢印・モザイクなど、`pointerdown`時点のCanvasスナップショットを
 * `pointermove`/`pointerup`まで保持するドラッグ系ツールが、ドラッグ中の非同期差し替えを
 * 検知して中断するための共通判定として使う(ツールごとに同じ判定を再実装しない。
 * 将来ツールが増えても本関数を呼ぶだけでよい)。
 */
export function isSameCanvasImage(
  a: CanvasImage | null,
  b: CanvasImage | null,
): boolean {
  return a === b;
}

type Listener = (state: CanvasState) => void;

let state: CanvasState = createCanvasState();
const listeners = new Set<Listener>();

/** 現在の状態を返す(`ui/` 層が読み取り用に参照する)。 */
export function getCanvasState(): CanvasState {
  return state;
}

/** 画像をセットし、購読者へ通知する。 */
export function setCanvasImage(image: CanvasImage): void {
  state = withImage(state, image);
  notify();
}

/** 画像をクリアし、購読者へ通知する。 */
export function clearCanvasImage(): void {
  state = withoutImage(state);
  notify();
}

/** 選択中ツールをセットし、購読者へ通知する(T09)。 */
export function setActiveTool(tool: ToolId | null): void {
  state = withActiveTool(state, tool);
  notify();
}

/** 選択中ツールをトグル切替し、購読者へ通知する(T09、`ui/toolbar.ts` から呼ぶ想定)。 */
export function toggleActiveTool(tool: ToolId): void {
  state = toggleTool(state, tool);
  notify();
}

/** 描画中フラグをセットし、購読者へ通知する(T09)。 */
export function setDrawing(isDrawing: boolean): void {
  state = withDrawing(state, isDrawing);
  notify();
}

/** 状態変化を購読する。戻り値の関数を呼ぶと購読解除する。 */
export function subscribeCanvasState(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) {
    listener(state);
  }
}
