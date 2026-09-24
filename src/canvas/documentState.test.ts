import { beforeEach, describe, expect, it } from "vitest";

import type { Rect } from "./coords";
import {
  addShapeObject,
  applyBaseEdit,
  arrangeSelected,
  exportDocumentBase,
  previewSelectedColor,
  restoreDocument,
  setSelectedColor,
  setSelectedFontSize,
  setTextMeasurer,
  snapshotDocument,
  commitShapeEdit,
  getDocumentState,
  redoDocument,
  removeShapeObject,
  resetDocument,
  selectObject,
  setDocumentSurface,
  setDraft,
  setHiddenObject,
  subscribeDocument,
  undoDocument,
  type DocumentSurface,
  type ShapeDraft,
} from "./documentState";
import { OBJECT_LIMIT, type AnnotationObject } from "./objectModel";
import { shapeUndoRect, type BoxShape, type EditableShape, type TextShape } from "./shapeEdit";
import { canRedo, canUndo, getUndoStackState } from "./undoStack";

function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

const W = 400;
const H = 300;
const COLOR = "#FF5C8A";
const BURNED = 255;

const box = (x: number, y = 10): BoxShape => ({
  kind: "rectangle",
  rect: { x, y, width: 20, height: 20 },
  color: COLOR,
});

interface FakeSurface extends DocumentSurface {
  base: Uint8ClampedArray;
  burned: EditableShape[];
  renders: { objects: readonly AnnotationObject[]; draft: ShapeDraft | null }[];
  resets: number;
  loaded: unknown[];
}

/** 1画素=1バイトの配列をベースに見立てた偽のサーフェス(DOM無しで状態遷移を検証する)。 */
function createFakeSurface(): FakeSurface {
  const base = new Uint8ClampedArray(W * H);
  const fill = (r: Rect, value: number) => {
    for (let y = r.y; y < r.y + r.height; y += 1) {
      base.fill(value, y * W + r.x, y * W + r.x + r.width);
    }
  };
  const surface: FakeSurface = {
    base,
    burned: [],
    renders: [],
    resets: 0,
    loaded: [],
    size: () => ({ width: W, height: H }),
    reset: () => {
      surface.resets += 1;
      base.fill(0);
    },
    read: (r) => {
      const data = new Uint8ClampedArray(r.width * r.height);
      for (let y = 0; y < r.height; y += 1) {
        data.set(base.subarray((r.y + y) * W + r.x, (r.y + y) * W + r.x + r.width), y * r.width);
      }
      return { data, width: r.width, height: r.height };
    },
    write: (r, image) => {
      for (let y = 0; y < r.height; y += 1) {
        base.set(image.data.subarray(y * r.width, (y + 1) * r.width), (r.y + y) * W + r.x);
      }
    },
    burn: (shape) => {
      surface.burned.push(shape);
      fill(shapeUndoRect(shape, W, H), BURNED);
    },
    editBase: (draw) => draw(null as unknown as CanvasRenderingContext2D),
    load: (image) => {
      surface.loaded.push(image);
    },
    exportBase: () => Promise.resolve(new Blob(["base"])),
    render: (objects, draft) => {
      surface.renders.push({ objects, draft });
    },
  };
  return surface;
}

function sumRegion(surface: FakeSurface, r: Rect): number {
  let total = 0;
  for (const v of surface.read(r).data) {
    total += v;
  }
  return total;
}

let surface: FakeSurface;

beforeEach(() => {
  surface = createFakeSurface();
  setDocumentSurface(surface);
  resetDocument();
});

describe("resetDocument", () => {
  it("表示をベースへ取り込み、オブジェクト・選択・下書き・取り消しスタックを空にして再描画する", () => {
    addShapeObject(box(10));
    setDraft({ id: null, shape: box(50) });
    resetDocument();
    expect(getDocumentState()).toEqual({ objects: [], selectedId: null, draft: null, hiddenId: null });
    expect(canUndo()).toBe(false);
    expect(surface.resets).toBe(2);
    expect(last(surface.renders)).toEqual({ objects: [], draft: null });
  });
});

describe("addShapeObject", () => {
  it("オブジェクトを最前面に追加して選択し、1コマンドとして取り消し・やり直しできる", () => {
    const first = addShapeObject(box(10));
    const second = addShapeObject(box(60));
    expect(getDocumentState().objects).toEqual([first, second]);
    expect(getDocumentState().selectedId).toBe(second.id);
    expect(first.id).not.toBe(second.id);
    expect(last(surface.renders)?.objects).toEqual([first, second]);

    expect(undoDocument()).toBe(true);
    expect(getDocumentState().objects).toEqual([first]);
    // 取り消しで消えたオブジェクトの選択は外れる。
    expect(getDocumentState().selectedId).toBeNull();
    expect(last(surface.renders)?.objects).toEqual([first]);

    expect(redoDocument()).toBe(true);
    expect(getDocumentState().objects).toEqual([first, second]);
  });

  it("下書きを消してから描く(作成ドラッグの終わり)", () => {
    setDraft({ id: null, shape: box(10) });
    addShapeObject(box(10));
    expect(getDocumentState().draft).toBeNull();
  });

  it("新しい操作はやり直しスタックを空にする", () => {
    addShapeObject(box(10));
    undoDocument();
    expect(canRedo()).toBe(true);
    addShapeObject(box(60));
    expect(canRedo()).toBe(false);
  });
});

describe("上限(OBJECT_LIMIT)と焼き込み", () => {
  it(`${OBJECT_LIMIT}個までは焼き込まない`, () => {
    for (let i = 0; i < OBJECT_LIMIT; i += 1) {
      addShapeObject(box(i * 5));
    }
    expect(getDocumentState().objects).toHaveLength(OBJECT_LIMIT);
    expect(surface.burned).toEqual([]);
  });

  it("51個目で最古をベースへ焼き込んで配列から外し、同じ1回の取り消しで元へ戻る", () => {
    const added: AnnotationObject[] = [];
    for (let i = 0; i < OBJECT_LIMIT; i += 1) {
      added.push(addShapeObject(box(i * 5)));
    }
    const oldest = added[0]!;
    const oldestRect = shapeUndoRect(oldest.shape, W, H);
    expect(sumRegion(surface, oldestRect)).toBe(0);

    const newest = addShapeObject(box(300, 200));

    const { objects, selectedId } = getDocumentState();
    expect(objects).toHaveLength(OBJECT_LIMIT);
    expect(objects[0]).toBe(added[1]);
    expect(last(objects)).toBe(newest);
    expect(selectedId).toBe(newest.id);
    expect(surface.burned).toEqual([oldest.shape]);
    expect(sumRegion(surface, oldestRect)).toBe(oldestRect.width * oldestRect.height * BURNED);

    // 1回の取り消しで「追加」と「焼き込み」が両方戻る(最古が再び編集可能になる)。
    undoDocument();
    expect(getDocumentState().objects).toEqual(added);
    expect(sumRegion(surface, oldestRect)).toBe(0);

    redoDocument();
    expect(getDocumentState().objects).toHaveLength(OBJECT_LIMIT);
    expect(getDocumentState().objects[0]).toBe(added[1]);
    expect(last(getDocumentState().objects)).toEqual(newest);
    expect(sumRegion(surface, oldestRect)).toBe(oldestRect.width * oldestRect.height * BURNED);
    // やり直しは描画し直さず、保存したピクセルを戻すだけ。
    expect(surface.burned).toHaveLength(1);
  });

  it("上限を超えて描き続けても常に50個に保たれる", () => {
    for (let i = 0; i < OBJECT_LIMIT + 10; i += 1) {
      addShapeObject(box(i * 5));
    }
    expect(getDocumentState().objects).toHaveLength(OBJECT_LIMIT);
    expect(surface.burned).toHaveLength(10);
  });
});

describe("commitShapeEdit(移動・リサイズの確定)", () => {
  it("形が変わればupdateコマンドを積み、取り消しで元の形へ戻る", () => {
    const o = addShapeObject(box(10));
    setDraft({ id: o.id, shape: box(100) });
    expect(commitShapeEdit(o.id, box(100))).toBe(true);
    expect(getDocumentState().objects).toEqual([{ id: o.id, shape: box(100) }]);
    expect(getDocumentState().draft).toBeNull();

    undoDocument();
    expect(getDocumentState().objects).toEqual([{ id: o.id, shape: box(10) }]);
    // 変更の取り消しでは選択を保つ。
    expect(getDocumentState().selectedId).toBe(o.id);
    redoDocument();
    expect(getDocumentState().objects).toEqual([{ id: o.id, shape: box(100) }]);
  });

  it("形が変わらない(クリックだけ)ならコマンドを積まない", () => {
    const o = addShapeObject(box(10));
    const depth = getUndoStackState().undo.length;
    expect(commitShapeEdit(o.id, box(10))).toBe(false);
    expect(getUndoStackState().undo.length).toBe(depth);
  });

  it("存在しないid(差し替え後など)は何もしない", () => {
    expect(commitShapeEdit(999, box(10))).toBe(false);
    expect(canUndo()).toBe(false);
  });
});

describe("removeShapeObject(テキストを空にして確定、T33。T34の削除キーも使う)", () => {
  it("元の位置から除去してremoveコマンドを積み、取り消しで同じ位置へ戻る", () => {
    const a = addShapeObject(box(10));
    const b = addShapeObject(box(60));
    const c = addShapeObject(box(110));
    expect(removeShapeObject(b.id)).toBe(true);
    expect(getDocumentState().objects).toEqual([a, c]);
    expect(getDocumentState().selectedId).toBe(c.id);
    undoDocument();
    expect(getDocumentState().objects).toEqual([a, b, c]);
    redoDocument();
    expect(getDocumentState().objects).toEqual([a, c]);
  });

  it("選択中を消したら選択を外し、存在しないidは何もしない", () => {
    const a = addShapeObject(box(10));
    removeShapeObject(a.id);
    expect(getDocumentState().selectedId).toBeNull();
    const depth = getUndoStackState().undo.length;
    expect(removeShapeObject(999)).toBe(false);
    expect(getUndoStackState().undo.length).toBe(depth);
  });
});

describe("setHiddenObject(再編集中のテキストを入力欄と二重に描かない、T33)", () => {
  it("隠したオブジェクトは描画に渡さず、解除すると戻る。モデル・取り消しには影響しない", () => {
    const a = addShapeObject(box(10));
    const b = addShapeObject(box(60));
    const depth = getUndoStackState().undo.length;
    setHiddenObject(a.id);
    expect(getDocumentState().hiddenId).toBe(a.id);
    expect(last(surface.renders)?.objects).toEqual([b]);
    expect(getDocumentState().objects).toEqual([a, b]);
    setHiddenObject(null);
    expect(last(surface.renders)?.objects).toEqual([a, b]);
    expect(getUndoStackState().undo.length).toBe(depth);
  });

  it("画像の差し替えで解除される", () => {
    const a = addShapeObject(box(10));
    setHiddenObject(a.id);
    resetDocument();
    expect(getDocumentState().hiddenId).toBeNull();
  });
});

describe("選択中のオブジェクトの操作(T34)", () => {
  const text: TextShape = {
    kind: "text",
    text: "Hi",
    x: 10,
    top: 10,
    fontSize: "medium",
    color: COLOR,
    metrics: { width: 40, left: 0, right: 38, ascent: 13, descent: 1, fontAscent: 17, fontDescent: 4 },
  };

  it("setSelectedColor: 選択中の色を変えるupdateを積み、取り消せる。選択が無い・同じ色なら何もしない", () => {
    expect(setSelectedColor("#007AFF")).toBe(false);
    const o = addShapeObject(box(10));
    expect(setSelectedColor(COLOR)).toBe(false);
    expect(setSelectedColor("#007AFF")).toBe(true);
    expect(getDocumentState().objects[0]?.shape.color).toBe("#007AFF");
    undoDocument();
    expect(getDocumentState().objects[0]?.shape.color).toBe(COLOR);
    expect(getDocumentState().selectedId).toBe(o.id);
  });

  it("previewSelectedColor: 下書きで色だけを見せ、モデル・取り消しは変えない", () => {
    const o = addShapeObject(box(10));
    const depth = getUndoStackState().undo.length;
    previewSelectedColor("#34C759");
    expect(getDocumentState().draft).toEqual({ id: o.id, shape: { ...box(10), color: "#34C759" } });
    expect(getDocumentState().objects[0]?.shape.color).toBe(COLOR);
    expect(getUndoStackState().undo.length).toBe(depth);
  });

  it("setSelectedFontSize: テキストだけ、寸法を測り直してupdateを積む", () => {
    const measured: [string, number][] = [];
    setTextMeasurer((value, fontPx) => {
      measured.push([value, fontPx]);
      return { ...text.metrics, width: fontPx * 2 };
    });
    addShapeObject(box(10));
    expect(setSelectedFontSize("large")).toBe(false); // 矩形は対象外
    const t = addShapeObject(text);
    expect(setSelectedFontSize("medium")).toBe(false); // 同じサイズ
    expect(setSelectedFontSize("large")).toBe(true);
    const resized = getDocumentState().objects.find((o) => o.id === t.id)!.shape as TextShape;
    expect(resized.fontSize).toBe("large");
    expect(resized.metrics.width).toBe(measured[0]![1] * 2);
    expect(measured[0]![0]).toBe("Hi");
    undoDocument();
    expect(getDocumentState().objects.find((o) => o.id === t.id)!.shape).toEqual(text);
    setTextMeasurer(null);
  });

  it("arrangeSelected: 最前面・最背面へ動かすreorderを積み、端にあれば何もしない", () => {
    const a = addShapeObject(box(10));
    const b = addShapeObject(box(60));
    const c = addShapeObject(box(110));
    selectObject(a.id);
    expect(arrangeSelected("back")).toBe(false);
    expect(arrangeSelected("front")).toBe(true);
    expect(getDocumentState().objects).toEqual([b, c, a]);
    expect(getDocumentState().selectedId).toBe(a.id);
    expect(arrangeSelected("front")).toBe(false);
    expect(arrangeSelected("back")).toBe(true);
    expect(getDocumentState().objects).toEqual([a, b, c]);
    undoDocument();
    expect(getDocumentState().objects).toEqual([b, c, a]);
    selectObject(null);
    expect(arrangeSelected("front")).toBe(false);
  });
});

describe("snapshotDocument / restoreDocument(履歴ごとの保持、T34)", () => {
  it("オブジェクト・次のid・取り消しスタックを退避し、別の画像を挟んで戻すと再調整・取り消しできる", async () => {
    const a = addShapeObject(box(10));
    commitShapeEdit(a.id, box(40));
    const snapshot = snapshotDocument();
    expect(await exportDocumentBase()).toBeInstanceOf(Blob);

    resetDocument(); // 別の画像
    addShapeObject(box(200));

    const baseImage = { width: W, height: H };
    restoreDocument(snapshot, baseImage as unknown as ImageBitmap, null);
    expect(last(surface.loaded)).toBe(baseImage);
    expect(getDocumentState()).toEqual({ objects: [{ id: a.id, shape: box(40) }], selectedId: null, draft: null, hiddenId: null });
    expect(canUndo()).toBe(true);
    undoDocument();
    expect(getDocumentState().objects).toEqual([{ id: a.id, shape: box(10) }]);
    // idは戻した後も重ならない。
    expect(addShapeObject(box(90)).id).toBeGreaterThan(a.id);
  });

  it("退避した内容は戻した後の操作で変わらない(別々の値)", () => {
    addShapeObject(box(10));
    const snapshot = snapshotDocument();
    addShapeObject(box(60));
    expect(snapshot.objects).toHaveLength(1);
    expect(snapshot.undo.undo).toHaveLength(1);
  });
});

describe("applyBaseEdit(モザイク・テキストのベース加工)", () => {
  it("ベースだけを変えてpixelsコマンドを積み、取り消し・やり直しでベースを戻す", () => {
    const o = addShapeObject(box(10));
    const rect: Rect = { x: 0, y: 0, width: 50, height: 50 };
    applyBaseEdit(rect, () => {
      surface.write(rect, { data: new Uint8ClampedArray(50 * 50).fill(7), width: 50, height: 50 });
    });
    expect(sumRegion(surface, rect)).toBe(50 * 50 * 7);
    // オブジェクトはそのまま(ベースより上に描かれる)。
    expect(getDocumentState().objects).toEqual([o]);

    undoDocument();
    expect(sumRegion(surface, rect)).toBe(0);
    expect(getDocumentState().objects).toEqual([o]);
    redoDocument();
    expect(sumRegion(surface, rect)).toBe(50 * 50 * 7);
  });

  it("空の矩形は何もしない", () => {
    applyBaseEdit({ x: 0, y: 0, width: 0, height: 10 }, () => {
      throw new Error("呼ばれない");
    });
    expect(canUndo()).toBe(false);
  });
});

describe("selectObject / setDraft / subscribeDocument", () => {
  it("選択は取り消し対象にならず、存在しないidは選べない", () => {
    const o = addShapeObject(box(10));
    selectObject(null);
    expect(getDocumentState().selectedId).toBeNull();
    selectObject(12345);
    expect(getDocumentState().selectedId).toBeNull();
    selectObject(o.id);
    expect(getDocumentState().selectedId).toBe(o.id);
    expect(getUndoStackState().undo).toHaveLength(1);
  });

  it("下書きは描画に渡され、変更は購読者へ通知される", () => {
    const seen: (number | null)[] = [];
    const unsubscribe = subscribeDocument((state) => seen.push(state.selectedId));
    const o = addShapeObject(box(10));
    const draft: ShapeDraft = { id: o.id, shape: box(30) };
    setDraft(draft);
    expect(last(surface.renders)).toEqual({ objects: [o], draft });
    selectObject(null);
    unsubscribe();
    expect(seen).toContain(o.id);
    expect(last(seen)).toBeNull();
  });

  it("サーフェス未登録なら取り消し・やり直しは何もしない", () => {
    addShapeObject(box(10));
    setDocumentSurface(null);
    expect(undoDocument()).toBe(false);
    setDocumentSurface(surface);
    expect(undoDocument()).toBe(true);
  });
});
