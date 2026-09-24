//! Undo/Redoスタック(ARCH §5.1 `src/canvas/undoStack.ts`、§6.1 `undoStack`、§6.3・§6.4、
//! PRD FR-014、T23)。
//!
//! 焼き込み操作(矢印・矩形・円・テキスト・モザイク)ごとに、変更された矩形領域のみの
//! ピクセルデータ(ImageData相当)を保持する「差分方式」でUndo/Redoを実現する
//! (ARCH §6.4 B案採用。Canvas全体のスナップショットは保持しない)。
//!
//! # なぜ差分方式か(メモリ根拠、ARCH §6.4・PRD §11リスク)
//!
//! 5K Retina相当(5120x2880)のCanvas全体のImageDataは概ね60MB級になる。全体スナップショットを
//! 複数保持する方式(A案)では上限10件でも最大約600MBに達しうる。矢印・矩形・円・テキスト等の
//! 注釈は画像全体よりずっと小さいことがほとんどのため、変更矩形分のみを保持すれば典型的な
//! 使用ではKB〜数MB程度に収まる。ただし全画面モザイク等、矩形が画像全体に及ぶ操作も理論上
//! あるため、件数上限([`UNDO_STACK_LIMIT`]=30件、超過分は最も古いものから破棄)を安全弁として
//! 併用する(ARCH §6.4「具体的な上限値は実装フェーズで調整してよい」との指示のもと、まずは
//! 合計バイト数上限を導入せず件数上限のみのシンプルな実装に留める)。Redoスタックも同じ理由で
//! 同じ上限を課す(往復で最大2倍にはなるが、無制限膨張は防げる)。
//!
//! # Undo/Redoのデータ形状とAPI契約(【設計判断】、ARCH §5.2・PRD §5 UndoStep・FR-014)
//!
//! ARCH §5.2は「`popUndo()`で取り出した`{rect, before}`を`putImageData()`で書き戻す」と
//! Undo単方向のみ記述している(Redo追加前の記述)。PRD §10決定#9でRedoが追加され、
//! 「取り消し(Undo)スタックと対称のRedoスタックを用いる」「Redoスタックも同一の差分方式
//! (変更矩形+焼き込み前ピクセル)を用いる」ことが決定した(FR-014受け入れ基準)。
//!
//! しかし`pushUndoStep(rect, before)`が呼ばれる時点(焼き込み**前**、ARCH §5.2
//! 「呼んでから最終図形を焼き込む」)では、焼き込み後のピクセル(Redo側が最終的に復元すべき
//! 内容)はまだ存在しない。そのため本モジュールはCanvas由来の「現在の画像」を自前で
//! 保持・取得せず、`popUndo()`/`popRedo()`の呼び出し側(`ui/undoButton.ts`、T29)が
//! 「書き戻す直前にCanvasから読み取った現在のピクセル(`currentImage`)」を引数として渡す
//! 設計にする。これにより本モジュールはCanvas APIに一切依存しない純粋なスタックのまま
//! 保てる(ImageDataがVitestのnode環境に無いため、`{data, width, height}`相当の
//! [`ImageDataLike`]型で扱う。ブラウザの`ImageData`はこの形を満たすため実利用時はそのまま
//! 渡せる。`mosaicTool.ts`と同じ方針)。
//!
//! `currentImage`は、直前に取り出したエントリと同じ`rect`領域のみを表すピクセルデータを
//! 想定する(Canvas全体ではない。5K画像でも`rect`サイズ分のみ`getImageData()`すればよい、
//! `mosaicTool.ts::applyMosaic()`と同じ節約方針)。呼び出し側は、popする**前**に
//! `getUndoStackState().undo.at(-1)?.rect`(Redoは`.redo.at(-1)?.rect`)で対象矩形を確認し、
//! その矩形分だけCanvasから読み取ってから`popUndo()`/`popRedo()`に渡す想定(T29実装時)。
//!
//! 呼び出し側(T29)が想定する使い方:
//! ```text
//! // Undo (Cmd+Z):
//! const rect = getUndoStackState().undo.at(-1)?.rect;
//! if (rect) {
//!   const current = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
//!   const entry = popUndo(current); // currentをRedoスタックへ積んでから、Undoエントリを返す
//!   if (entry) ctx.putImageData(entry.image, entry.rect.x, entry.rect.y);
//! }
//!
//! // Redo (Cmd+Shift+Z): 対称
//! const rect = getUndoStackState().redo.at(-1)?.rect;
//! if (rect) {
//!   const current = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
//!   const entry = popRedo(current);
//!   if (entry) ctx.putImageData(entry.image, entry.rect.x, entry.rect.y);
//! }
//! ```
//!
//! # 画像差し替え時のクリア(【明記】、PRD §5、ARCH §6.3)
//!
//! `clearUndoStack()`は、新規Capture読込(`main.ts::handleCaptureCompleted`)・履歴項目
//! 再読込(`main.ts::reloadHistoryItemIntoCanvas`)が**Canvas差し替え完了後**に呼ぶ想定
//! (ARCH §6.3「新規Capture読込時・履歴項目切替時はundoStack.clearUndoStack()を呼ぶ」)。
//! 取り消し対象を常に「現在表示中の画像」に限定するため(PRD §5)。呼び出し自体は
//! `main.ts`側の責務(T24以降)で、本モジュールは`clearUndoStack()`を提供するだけ。
//!
//! これは`canvasState.ts::isSameCanvasImage()`によるドラッグ**中**の非同期差し替え検知
//! (F1で導入。矢印・モザイク等が`pointermove`/`pointerup`で参照し、ドラッグ自体を中断する
//! 仕組み)とは別レイヤーの処理であり、両者は併用する。ドラッグ中に画像が差し替えられた
//! 場合はドラッグ自体が中断されるため`pushUndoStep()`は呼ばれず、Undoスタックに古い画像を
//! 前提としたエントリが混入することはない。差し替え完了後に次に`pushUndoStep()`されるのは
//! 新しい画像を前提としたエントリになる。

/**
 * Canvasピクセル座標での矩形。T23時点ではT20〜T23が変更ファイル非重複の並行実装だったため
 * 本モジュール独自の最小定義を持っていたが、T20で`coords.ts`への集約が完了したため
 * 【改訂 2026-09-24、T24】`coords.ts`の`Rect`を再importして使う(`mosaicTool.ts`も同じ型を
 * 再exportしており、構造は完全に同一。挙動不変)。
 */
import type { Rect } from "./coords";

export type { Rect };

/**
 * `ImageData`相当の最小インターフェース(`data`/`width`/`height`)。VitestのNode環境には
 * `ImageData`が無いため、テストでは`{data: Uint8ClampedArray, width, height}`のプレーン
 * オブジェクトを使う(`mosaicTool.ts::pixelateImageData()`と同じ方針)。ブラウザの
 * `ImageData`はこの形を満たすため、実利用時(T29)はそのまま渡せる。
 *
 * 【調査結果、T24】`mosaicTool.ts`は同形の値を単一の型として持たず
 * `pixelateImageData(data, width, height, blockSize)` のように分解した引数で扱っている
 * (`export type` を持つ既存の同形インターフェースはコードベース中に存在しない)。そのため
 * 本インターフェースは`coords.ts`の`Rect`のような再import先が無く、ここが唯一の定義元のまま
 * とする(Rectのみ統一、ImageDataLikeは統一対象が実在しなかった)。
 */
export interface ImageDataLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Undo/Redoスタックの1エントリ。`image`は`rect`領域へ書き戻すためのピクセルデータ。 */
export interface UndoEntry {
  rect: Rect;
  image: ImageDataLike;
}

/**
 * Undo/Redo各スタックの保持件数上限(ARCH §6.4、PRD §11リスク。上記モジュールdoc参照)。
 * 超過分は最も古いエントリ(スタック底)から破棄する。
 */
export const UNDO_STACK_LIMIT = 30;

/** Undo/Redoスタックの状態。配列の末尾が「最後に積んだ(最新の)」エントリ。 */
export interface UndoStackState {
  undo: UndoEntry[];
  redo: UndoEntry[];
}

/** 空のUndo/Redoスタックを返す純粋関数。 */
export function createUndoStackState(): UndoStackState {
  return { undo: [], redo: [] };
}

/**
 * `stack`の末尾へ`entry`を積み、[`UNDO_STACK_LIMIT`]を超えた分は先頭(最も古い)から
 * 破棄した新しい配列を返す純粋関数(イミュータブル)。
 */
function pushCapped(stack: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  const next = [...stack, entry];
  return next.length > UNDO_STACK_LIMIT
    ? next.slice(next.length - UNDO_STACK_LIMIT)
    : next;
}

/**
 * 焼き込み操作の直前に、変更対象の矩形と焼き込み前のピクセルデータをUndoスタックへ積み、
 * Redoスタックをクリアした新しい状態を返す純粋関数(イミュータブル、PRD FR-014「新しい
 * 注釈操作を行うとRedoスタックはクリアされる」)。呼び出し側は本関数を呼んでから焼き込みを
 * 行う想定(ARCH §5.2、上記モジュールdoc参照)。
 */
export function withPushedUndoStep(
  state: UndoStackState,
  rect: Rect,
  before: ImageDataLike,
): UndoStackState {
  return { undo: pushCapped(state.undo, { rect, image: before }), redo: [] };
}

/** `withPoppedUndo()`/`withPoppedRedo()`の戻り値。 */
export interface PopResult {
  state: UndoStackState;
  /** 取り出したエントリ。対象スタックが空なら`null`(状態は変化しない)。 */
  entry: UndoEntry | null;
}

/**
 * Undoスタックの最上位(最後に積んだもの)を取り出し、その直前に呼び出し側がCanvasから
 * 読み取った「現在のピクセル」(`currentImage`、取り出すエントリと同じ`rect`領域を想定)を
 * Redoスタックへ積んだ新しい状態を返す純粋関数(イミュータブル)。Undoスタックが空なら
 * `entry: null`を返し、状態は変化しない(元の`state`をそのまま返す)。
 */
export function withPoppedUndo(
  state: UndoStackState,
  currentImage: ImageDataLike,
): PopResult {
  if (state.undo.length === 0) {
    return { state, entry: null };
  }
  const entry = state.undo[state.undo.length - 1]!;
  const undo = state.undo.slice(0, -1);
  const redo = pushCapped(state.redo, { rect: entry.rect, image: currentImage });
  return { state: { undo, redo }, entry };
}

/** `withPoppedUndo()`と対称のRedo版(Redoスタックから取り出し、Undoスタックへ積む)。 */
export function withPoppedRedo(
  state: UndoStackState,
  currentImage: ImageDataLike,
): PopResult {
  if (state.redo.length === 0) {
    return { state, entry: null };
  }
  const entry = state.redo[state.redo.length - 1]!;
  const redo = state.redo.slice(0, -1);
  const undo = pushCapped(state.undo, { rect: entry.rect, image: currentImage });
  return { state: { undo, redo }, entry };
}

/** Undoスタックに取り消し可能なエントリがあるかを返す純粋関数。 */
export function canUndoState(state: UndoStackState): boolean {
  return state.undo.length > 0;
}

/** Redoスタックにやり直し可能なエントリがあるかを返す純粋関数。 */
export function canRedoState(state: UndoStackState): boolean {
  return state.redo.length > 0;
}

// --- モジュール単位の薄い状態オブジェクト(`canvasState.ts`と同じ作法、T23) ---

type Listener = (state: UndoStackState) => void;

let state: UndoStackState = createUndoStackState();
const listeners = new Set<Listener>();

/** 現在のUndo/Redo状態を返す(`ui/undoButton.ts`等が読み取り用に参照する)。 */
export function getUndoStackState(): UndoStackState {
  return state;
}

/**
 * 焼き込み操作の直前に呼ぶ。変更対象の矩形と焼き込み前のピクセルをUndoスタックへ積み、
 * Redoスタックをクリアし、購読者へ通知する(ARCH §5.2、上記モジュールdoc参照)。
 */
export function pushUndoStep(rect: Rect, before: ImageDataLike): void {
  state = withPushedUndoStep(state, rect, before);
  notify();
}

/**
 * Undoスタックから最新のエントリを取り出し、`currentImage`をRedoスタックへ積んで
 * 購読者へ通知し、取り出したエントリを返す(呼び出し側がその`image`を`rect`位置へ
 * 書き戻す)。Undoスタックが空なら何もせず`null`を返す(他ストアの操作と同様、この場合も
 * 購読者へ通知する。`historyStore.ts::selectHistoryItem()`と同じ作法)。
 */
export function popUndo(currentImage: ImageDataLike): UndoEntry | null {
  const result = withPoppedUndo(state, currentImage);
  state = result.state;
  notify();
  return result.entry;
}

/** `popUndo()`と対称のRedo版。 */
export function popRedo(currentImage: ImageDataLike): UndoEntry | null {
  const result = withPoppedRedo(state, currentImage);
  state = result.state;
  notify();
  return result.entry;
}

/** Undoスタックに取り消し可能なエントリがあるかを返す(ツールバーの有効/無効判定に使う)。 */
export function canUndo(): boolean {
  return canUndoState(state);
}

/** Redoスタックにやり直し可能なエントリがあるかを返す(ツールバーの有効/無効判定に使う)。 */
export function canRedo(): boolean {
  return canRedoState(state);
}

/**
 * Undo・Redo両スタックを空にし、購読者へ通知する。新規Capture読込・履歴項目再読込の
 * 完了後に呼ぶ想定(上記モジュールdoc「画像差し替え時のクリア」参照)。
 */
export function clearUndoStack(): void {
  state = createUndoStackState();
  notify();
}

/** 状態変化を購読する。戻り値の関数を呼ぶと購読解除する。 */
export function subscribeUndoStack(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) {
    listener(state);
  }
}
