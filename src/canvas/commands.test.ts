import { describe, expect, it } from "vitest";

import {
  redoCommand,
  undoCommand,
  type DocumentCommand,
  type ImageDataLike,
  type PixelStore,
} from "./commands";
import type { Rect } from "./coords";
import type { AnnotationObject } from "./objectModel";
import type { BoxShape } from "./shapeEdit";

const COLOR = "#FF5C8A";
const box = (x: number): BoxShape => ({ kind: "rectangle", rect: { x, y: 0, width: 10, height: 10 }, color: COLOR });
const obj = (id: number, x = id * 10): AnnotationObject => ({ id, shape: box(x) });

/** 1チャンネル相当の値で矩形の中身を表す偽のベース(矩形ごとに値を1つ持つ)。 */
function fakePixels(initial: Record<string, number> = {}): PixelStore & { values: Record<string, number> } {
  const values = { ...initial };
  const key = (r: Rect) => `${r.x},${r.y},${r.width},${r.height}`;
  return {
    values,
    read: (r) => ({ data: new Uint8ClampedArray([values[key(r)] ?? 0]), width: 1, height: 1 }),
    write: (r, image) => {
      values[key(r)] = image.data[0]!;
    },
  };
}

const img = (v: number): ImageDataLike => ({ data: new Uint8ClampedArray([v]), width: 1, height: 1 });
const R: Rect = { x: 0, y: 0, width: 4, height: 4 };
const K = "0,0,4,4";

describe("add", () => {
  it("取り消しで除去、やり直しで同じ位置へ戻す", () => {
    const pixels = fakePixels();
    const cmd: DocumentCommand = { type: "add", object: obj(2), index: 1 };
    const undone = undoCommand([obj(1), obj(2), obj(3)], cmd, pixels);
    expect(undone.objects).toEqual([obj(1), obj(3)]);
    const redone = redoCommand(undone.objects, undone.command, pixels);
    expect(redone.objects).toEqual([obj(1), obj(2), obj(3)]);
  });
});

describe("update", () => {
  it("取り消しでbefore、やり直しでafterの形にする", () => {
    const pixels = fakePixels();
    const cmd: DocumentCommand = { type: "update", id: 1, before: box(0), after: box(50) };
    const undone = undoCommand([{ id: 1, shape: box(50) }], cmd, pixels);
    expect(undone.objects).toEqual([{ id: 1, shape: box(0) }]);
    expect(redoCommand(undone.objects, undone.command, pixels).objects).toEqual([{ id: 1, shape: box(50) }]);
  });
});

describe("remove(T34の削除用)", () => {
  it("取り消しで元の位置へ戻し、やり直しで除去する", () => {
    const pixels = fakePixels();
    const cmd: DocumentCommand = { type: "remove", object: obj(2), index: 0 };
    const undone = undoCommand([obj(1)], cmd, pixels);
    expect(undone.objects).toEqual([obj(2), obj(1)]);
    expect(redoCommand(undone.objects, undone.command, pixels).objects).toEqual([obj(1)]);
  });
});

describe("pixels(モザイク・テキスト、差分の入れ替え方式)", () => {
  it("取り消しで保持していたピクセルを書き戻し、今のピクセルをやり直し用に持ち替える", () => {
    const pixels = fakePixels({ [K]: 200 }); // 200 = 加工後
    const cmd: DocumentCommand = { type: "pixels", rect: R, image: img(10) }; // 10 = 加工前
    const undone = undoCommand([], cmd, pixels);
    expect(pixels.values[K]).toBe(10);
    expect(undone.command).toEqual({ type: "pixels", rect: R, image: img(200) });
    const redone = redoCommand([], undone.command, pixels);
    expect(pixels.values[K]).toBe(200);
    expect(redone.command).toEqual(cmd);
  });
});

describe("flatten(上限超過の焼き込み)", () => {
  it("取り消しでベースを焼き込み前に戻してオブジェクトを元の位置へ戻す。やり直しで再び焼き込んで除去", () => {
    const pixels = fakePixels({ [K]: 99 }); // 99 = 焼き込み後
    const cmd: DocumentCommand = { type: "flatten", object: obj(1), index: 0, rect: R, image: img(5) };
    const undone = undoCommand([obj(2)], cmd, pixels);
    expect(undone.objects).toEqual([obj(1), obj(2)]);
    expect(pixels.values[K]).toBe(5);
    const redone = redoCommand(undone.objects, undone.command, pixels);
    expect(redone.objects).toEqual([obj(2)]);
    expect(pixels.values[K]).toBe(99);
  });
});

describe("group", () => {
  it("取り消しは逆順、やり直しは順に適用する(追加→最古の焼き込みを1回で戻す)", () => {
    const pixels = fakePixels({ [K]: 99 });
    const cmd: DocumentCommand = {
      type: "group",
      commands: [
        { type: "add", object: obj(3), index: 2 },
        { type: "flatten", object: obj(1), index: 0, rect: R, image: img(5) },
      ],
    };
    // 実行後の状態: obj(1)は焼き込み済みで配列に無く、obj(2), obj(3)。
    const undone = undoCommand([obj(2), obj(3)], cmd, pixels);
    expect(undone.objects).toEqual([obj(1), obj(2)]);
    expect(pixels.values[K]).toBe(5);
    const redone = redoCommand(undone.objects, undone.command, pixels);
    expect(redone.objects).toEqual([obj(2), obj(3)]);
    expect(pixels.values[K]).toBe(99);
  });
});
