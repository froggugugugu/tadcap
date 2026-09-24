//! 取り消し・やり直しのコマンド(T32【新設 2026-09-24】、PRD FR-014改訂、ARCH §5.2 T32)。
//!
//! 1コマンド = ユーザー操作1回分。オブジェクトの追加・変更(移動/リサイズ1回)・削除(T34)、
//! ベースのピクセル加工(モザイク・テキスト焼き込み)、上限超過の焼き込み、およびそれらの組。
//!
//! ピクセル系(`pixels`・`flatten`)はT23の差分方式を再利用し、「変更矩形+反対側の状態の
//! ピクセル」を1枚だけ持つ**入れ替え方式**にする: 取り消し・やり直しのたびに、今のベースの
//! `rect`を読んで保持していたピクセルを書き、読んだ方を次の方向用に持ち替えたコマンドを返す。
//! ベースを変える操作はすべてコマンド経由でスタック順に適用されるため、入れ替え時のベースは
//! 常にそのコマンドの直後(取り消し時)・直前(やり直し時)の状態と一致する。
//!
//! ベースへの読み書きは`PixelStore`越しに行い、Canvas APIに依存しない(Vitestでは偽物を使う)。

import type { Rect } from "./coords";
import { insertObject, removeObject, replaceObjectShape, type AnnotationObject } from "./objectModel";
import type { EditableShape } from "./shapeEdit";

/**
 * `ImageData`相当の最小インターフェース(VitestのNode環境には`ImageData`が無いため)。
 * ブラウザの`ImageData`はこの形を満たす。【改訂 2026-09-24 T32】`undoStack.ts`から移設。
 */
export interface ImageDataLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** ベース(元画像)のピクセルの読み書き。 */
export interface PixelStore {
  read(rect: Rect): ImageDataLike;
  write(rect: Rect, image: ImageDataLike): void;
}

export type DocumentCommand =
  /** オブジェクトの追加(`index`は追加時の配列位置)。 */
  | { type: "add"; object: AnnotationObject; index: number }
  /** 移動・リサイズ1回。 */
  | { type: "update"; id: number; before: EditableShape; after: EditableShape }
  /** オブジェクトの削除(T34で結線。`index`は削除前の位置)。 */
  | { type: "remove"; object: AnnotationObject; index: number }
  /** ベースのピクセル加工(`image`は反対側の状態の`rect`のピクセル)。 */
  | { type: "pixels"; rect: Rect; image: ImageDataLike }
  /** 上限超過でオブジェクトをベースへ焼き込んだ(`image`は反対側の状態の`rect`のピクセル)。 */
  | { type: "flatten"; object: AnnotationObject; index: number; rect: Rect; image: ImageDataLike }
  /** 1操作で起きた複数のコマンド(追加+焼き込みなど)。 */
  | { type: "group"; commands: DocumentCommand[] };

export interface CommandResult {
  objects: AnnotationObject[];
  /** 反対側のスタックへ積むコマンド(ピクセル系は持ち替え後、それ以外は同じもの)。 */
  command: DocumentCommand;
}

/** コマンドを取り消す(実行後の状態 → 実行前の状態)。 */
export function undoCommand(
  objects: readonly AnnotationObject[],
  command: DocumentCommand,
  pixels: PixelStore,
): CommandResult {
  return apply(objects, command, pixels, "undo");
}

/** 取り消したコマンドをやり直す(実行前の状態 → 実行後の状態)。 */
export function redoCommand(
  objects: readonly AnnotationObject[],
  command: DocumentCommand,
  pixels: PixelStore,
): CommandResult {
  return apply(objects, command, pixels, "redo");
}

function apply(
  objects: readonly AnnotationObject[],
  command: DocumentCommand,
  pixels: PixelStore,
  direction: "undo" | "redo",
): CommandResult {
  const undo = direction === "undo";
  switch (command.type) {
    case "add":
      return {
        objects: undo
          ? removeObject(objects, command.object.id)
          : insertObject(objects, command.object, command.index),
        command,
      };
    case "remove":
      return {
        objects: undo
          ? insertObject(objects, command.object, command.index)
          : removeObject(objects, command.object.id),
        command,
      };
    case "update":
      return {
        objects: replaceObjectShape(objects, command.id, undo ? command.before : command.after),
        command,
      };
    case "pixels":
      return { objects: [...objects], command: { ...command, image: swapPixels(pixels, command.rect, command.image) } };
    case "flatten": {
      const image = swapPixels(pixels, command.rect, command.image);
      return {
        objects: undo
          ? insertObject(objects, command.object, command.index)
          : removeObject(objects, command.object.id),
        command: { ...command, image },
      };
    }
    case "group": {
      const order = undo ? [...command.commands].reverse() : command.commands;
      let current: AnnotationObject[] = [...objects];
      const applied: DocumentCommand[] = [];
      for (const child of order) {
        const result = apply(current, child, pixels, direction);
        current = result.objects;
        applied.push(result.command);
      }
      return { objects: current, command: { type: "group", commands: undo ? applied.reverse() : applied } };
    }
  }
}

/** `rect`の今のピクセルを読み、`image`を書いて、読んだ方を返す。 */
function swapPixels(pixels: PixelStore, rect: Rect, image: ImageDataLike): ImageDataLike {
  const current = pixels.read(rect);
  pixels.write(rect, image);
  return current;
}
