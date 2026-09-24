import { beforeEach, describe, expect, it } from "vitest";

import type { DocumentCommand, ImageDataLike } from "../canvas/commands";
import type { DocumentSnapshot } from "../canvas/documentState";
import {
  ARCHIVED_UNDO_BYTES_LIMIT,
  clearArchivedDocuments,
  commandPixelBytes,
  deleteArchivedDocument,
  getArchivedDocument,
  saveArchivedDocument,
  trimUndoToBudget,
} from "./documentArchive";

const img = (bytes: number): ImageDataLike => ({ data: new Uint8ClampedArray(bytes), width: 1, height: 1 });
const rect = { x: 0, y: 0, width: 1, height: 1 };
const pixels = (bytes: number): DocumentCommand => ({ type: "pixels", rect, image: img(bytes) });
const add = (id: number): DocumentCommand => ({
  type: "add",
  object: { id, shape: { kind: "rectangle", rect, color: "#FF5C8A" } },
  index: 0,
});

describe("commandPixelBytes", () => {
  it("ピクセルを持つコマンド(pixels・flatten、groupの中も)のバイト数を数える", () => {
    expect(commandPixelBytes(add(1))).toBe(0);
    expect(commandPixelBytes(pixels(100))).toBe(100);
    expect(
      commandPixelBytes({
        type: "group",
        commands: [add(1), { type: "flatten", object: { id: 2, shape: { kind: "rectangle", rect, color: "#000000" } }, index: 0, rect, image: img(40) }],
      }),
    ).toBe(40);
  });
});

describe("trimUndoToBudget(退避する取り消しスタックのメモリ上限)", () => {
  it("上限以内ならそのまま", () => {
    const state = { undo: [pixels(10), add(1)], redo: [pixels(10)] };
    expect(trimUndoToBudget(state, 30)).toBe(state);
  });

  it("超えたら最も古い取り消し→最も遠いやり直しの順に捨てる(残りの順序は保つ)", () => {
    const state = { undo: [pixels(50), add(1), pixels(20)], redo: [pixels(30), pixels(5)] };
    // 合計105。上限60 → 古いpixels(50)を捨てて55。
    expect(trimUndoToBudget(state, 60)).toEqual({ undo: [add(1), pixels(20)], redo: [pixels(30), pixels(5)] });
    // 上限30 → undoのピクセルを捨て切っても35 → redoの最も遠い(先頭)pixels(30)も捨てる。
    // 取り消しは古い方から連続して捨てる(途中だけ抜くと戻す順序が壊れるため)。
    expect(trimUndoToBudget(state, 30)).toEqual({ undo: [], redo: [pixels(5)] });
  });

  it("既定の上限は8MB", () => {
    expect(ARCHIVED_UNDO_BYTES_LIMIT).toBe(8 * 1024 * 1024);
  });
});

describe("退避ストア", () => {
  const snapshot = (n: number): DocumentSnapshot => ({ objects: [], nextId: n, undo: { undo: [], redo: [] } });

  beforeEach(() => {
    clearArchivedDocuments();
  });

  it("履歴idごとに保存・取得・削除でき、保存時に取り消しスタックを上限に収める", () => {
    const base = new Blob(["png"]);
    saveArchivedDocument("a", { base, snapshot: snapshot(1) });
    saveArchivedDocument("b", {
      base,
      snapshot: { ...snapshot(2), undo: { undo: [pixels(ARCHIVED_UNDO_BYTES_LIMIT + 1), add(1)], redo: [] } },
    });
    expect(getArchivedDocument("a")?.snapshot.nextId).toBe(1);
    expect(getArchivedDocument("b")?.snapshot.undo.undo).toEqual([add(1)]);
    deleteArchivedDocument("a");
    expect(getArchivedDocument("a")).toBeUndefined();
    expect(getArchivedDocument("b")).toBeDefined();
  });
});
