//! 1画像分のドキュメント(ベース+オブジェクト+選択+下書き)の状態と操作
//! (T32【新設 2026-09-24】、PRD FR-006 オブジェクト共通基準・FR-008・FR-014改訂、ARCH §5.2 T32)。
//!
//! - ベース: 元画像。モザイク・テキスト焼き込み・上限超過の焼き込みはここにだけ適用する。
//! - オブジェクト: 矢印・矩形・円(配列順=重ね順、末尾が最前面、最大[`OBJECT_LIMIT`]個)。
//! - 表示: 常に「ベース+全オブジェクト(+ドラッグ中の下書き)」の合成(`DocumentSurface.render`)。
//!   選択ハンドルは合成に含めない(オーバーレイに描く、`tools/shapeTools.ts`)。
//!
//! 操作はすべて`commands.ts`のコマンドとして`undoStack`へ積む。ベースの読み書き・描画は
//! `DocumentSurface`越しに行い(DOM実装は`documentSurface.ts`)、本モジュールはCanvas APIに
//! 依存しない(Vitestでは偽物のサーフェスで検証する)。状態管理ライブラリは導入せず、
//! モジュール単位の薄い状態で持つ(`canvasState.ts`と同じ作法)。
//!
//! T34(履歴ごとの保持)への前提: ドキュメントの中身(ベース・オブジェクト・取り消しスタック)は
//! 本モジュールと`undoStack`に集まっている。履歴切替時にこれらを退避・復元すればよい。

import { redoCommand, undoCommand, type DocumentCommand, type PixelStore } from "./commands";
import type { Rect } from "./coords";
import {
  OBJECT_LIMIT,
  findObject,
  insertObject,
  replaceObjectShape,
  type AnnotationObject,
} from "./objectModel";
import { shapeUndoRect, type EditableShape } from "./shapeEdit";
import { clearUndoStack, popRedo, popUndo, pushCommand } from "./undoStack";

/**
 * ドラッグ中の下書き。`id`が`null`なら作成中の新しい図形(最前面に描く)、数値ならその
 * オブジェクトを`shape`に差し替えて描く(重ね順は保つ)。確定するまでモデルは変えない。
 */
export interface ShapeDraft {
  id: number | null;
  shape: EditableShape;
}

/** ベースの保持と合成描画(DOM実装は`documentSurface.ts`)。 */
export interface DocumentSurface extends PixelStore {
  size(): { width: number; height: number };
  /** 表示中の画像(読み込み直後の表示canvas)をベースへ取り込む。 */
  reset(): void;
  /** オブジェクトをベースへ描き込む(上限超過の焼き込み)。 */
  burn(shape: EditableShape): void;
  /** ベースの描画コンテキストへ任意の加工を行う(モザイク・テキスト)。 */
  editBase(draw: (ctx: CanvasRenderingContext2D) => void): void;
  /** 表示canvasへ ベース+オブジェクト(+下書き)を描く。 */
  render(objects: readonly AnnotationObject[], draft: ShapeDraft | null): void;
}

export interface DocumentState {
  objects: readonly AnnotationObject[];
  selectedId: number | null;
  draft: ShapeDraft | null;
}

type Listener = (state: DocumentState) => void;

let surface: DocumentSurface | null = null;
let state: DocumentState = { objects: [], selectedId: null, draft: null };
let nextId = 1;
const listeners = new Set<Listener>();

export function setDocumentSurface(next: DocumentSurface | null): void {
  surface = next;
}

export function getDocumentState(): DocumentState {
  return state;
}

/**
 * 新しい画像を読み込んだ直後に呼ぶ(新規キャプチャ・履歴再読込)。表示をベースへ取り込み、
 * オブジェクト・選択・下書き・取り消しスタックを空にする。
 */
export function resetDocument(): void {
  surface?.reset();
  state = { objects: [], selectedId: null, draft: null };
  clearUndoStack();
  commit();
}

/** 選択を変える(取り消し対象ではない)。存在しないidは選択解除として扱う。 */
export function selectObject(id: number | null): void {
  const selectedId = findObject(state.objects, id) ? id : null;
  if (selectedId === state.selectedId) {
    return;
  }
  state = { ...state, selectedId };
  notify();
}

/** ドラッグ中の下書きを差し替えて再描画する(`null`で消す)。 */
export function setDraft(draft: ShapeDraft | null): void {
  state = { ...state, draft };
  commit();
}

/**
 * 新しいオブジェクトを最前面に追加して選択する。上限を超えたら最も古いものからベースへ
 * 焼き込んで外し、追加と同じ1コマンド(`group`)にする(1回の取り消しで両方戻る、ARCH §5.2 T32)。
 */
export function addShapeObject(shape: EditableShape): AnnotationObject {
  const object: AnnotationObject = { id: nextId, shape };
  nextId += 1;
  const commands: DocumentCommand[] = [{ type: "add", object, index: state.objects.length }];
  let objects = insertObject(state.objects, object, state.objects.length);
  while (objects.length > OBJECT_LIMIT && surface) {
    const oldest = objects[0]!;
    const { width, height } = surface.size();
    const rect = shapeUndoRect(oldest.shape, width, height);
    const before = surface.read(rect);
    surface.burn(oldest.shape);
    commands.push({ type: "flatten", object: oldest, index: 0, rect, image: before });
    objects = objects.slice(1);
  }
  state = { objects, selectedId: object.id, draft: null };
  pushCommand(commands.length === 1 ? commands[0]! : { type: "group", commands });
  commit();
  return object;
}

/**
 * 移動・リサイズを確定する。形が変わっていれば`update`コマンドを積んで`true`。下書きは消す。
 * 存在しないid(ドラッグ中に画像が差し替わった等)は何もしない。
 */
export function commitShapeEdit(id: number, after: EditableShape): boolean {
  const current = findObject(state.objects, id);
  const changed = current !== undefined && !sameShape(current.shape, after);
  if (current && changed) {
    state = { ...state, objects: replaceObjectShape(state.objects, id, after) };
    pushCommand({ type: "update", id, before: current.shape, after });
  }
  state = { ...state, draft: null };
  commit();
  return changed;
}

/**
 * ベース(元画像)の`rect`を`draw`で加工し、`pixels`コマンドを積む(モザイク・テキスト)。
 * オブジェクトは変えない(常にベースより上に描かれるため隠れない、PRD FR-008改訂)。
 */
export function applyBaseEdit(rect: Rect, draw: (ctx: CanvasRenderingContext2D) => void): void {
  if (!surface || rect.width <= 0 || rect.height <= 0) {
    return;
  }
  const before = surface.read(rect);
  surface.editBase(draw);
  pushCommand({ type: "pixels", rect, image: before });
  commit();
}

/** 最新の操作を取り消す。取り消せなければ`false`。 */
export function undoDocument(): boolean {
  return step("undo");
}

/** 取り消した操作をやり直す。やり直せなければ`false`。 */
export function redoDocument(): boolean {
  return step("redo");
}

/** 今の状態で表示canvasを描き直す(ドラッグ中のプレビューの下地など)。 */
export function renderDocument(): void {
  surface?.render(state.objects, state.draft);
}

export function subscribeDocument(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function step(direction: "undo" | "redo"): boolean {
  const pixels = surface;
  if (!pixels) {
    return false;
  }
  const run = direction === "undo" ? undoCommand : redoCommand;
  const apply = (command: DocumentCommand): DocumentCommand => {
    const result = run(state.objects, command, pixels);
    state = { ...state, objects: result.objects };
    return result.command;
  };
  const entry = direction === "undo" ? popUndo(apply) : popRedo(apply);
  if (!entry) {
    return false;
  }
  // 取り消し・やり直しで消えたオブジェクトの選択は外す(変更の取り消しでは選択を保つ)。
  const selectedId = findObject(state.objects, state.selectedId) ? state.selectedId : null;
  state = { ...state, selectedId, draft: null };
  commit();
  return true;
}

function sameShape(a: EditableShape, b: EditableShape): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function commit(): void {
  renderDocument();
  notify();
}

function notify(): void {
  for (const listener of listeners) {
    listener(state);
  }
}
