import { beforeEach, describe, expect, it } from "vitest";

import type { Rect } from "./coords";
import {
  addShapeObject,
  applyBaseEdit,
  applyCrop,
  applyBaseEdits,
  arrangeSelected,
  exportDocumentBase,
  getCaptureSize,
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
import { composeDocument } from "./documentSurface";
import { OBJECT_LIMIT, type AnnotationObject } from "./objectModel";
import {
  shapeUndoRect,
  type BoxShape,
  type EditableShape,
  type SpotlightShape,
  type StampShape,
  type TextShape,
} from "./shapeEdit";
import { SPOTLIGHT_SHADE, spotlightShadeRects } from "./spotlight";
import { canRedo, canUndo, getUndoStackState } from "./undoStack";
import {
  commandPixelBytes,
  deleteArchivedDocument,
  getArchivedDocument,
  saveArchivedDocument,
} from "../history/documentArchive";

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
  /** ベースの今の大きさ(トリミングの`swapAll`で変わる、QE-T20)。 */
  width: number;
  height: number;
  burned: EditableShape[];
  renders: { objects: readonly AnnotationObject[]; draft: ShapeDraft | null }[];
  resets: number;
  loaded: unknown[];
}

/** 1画素=1バイトの配列をベースに見立てた偽のサーフェス(DOM無しで状態遷移を検証する)。 */
function createFakeSurface(): FakeSurface {
  const fill = (r: Rect, value: number) => {
    for (let y = r.y; y < r.y + r.height; y += 1) {
      surface.base.fill(value, y * surface.width + r.x, y * surface.width + r.x + r.width);
    }
  };
  const surface: FakeSurface = {
    base: new Uint8ClampedArray(W * H),
    width: W,
    height: H,
    burned: [],
    renders: [],
    resets: 0,
    loaded: [],
    size: () => ({ width: surface.width, height: surface.height }),
    reset: () => {
      surface.resets += 1;
      surface.base.fill(0);
    },
    read: (r) => {
      const data = new Uint8ClampedArray(r.width * r.height);
      const stride = surface.width;
      for (let y = 0; y < r.height; y += 1) {
        data.set(surface.base.subarray((r.y + y) * stride + r.x, (r.y + y) * stride + r.x + r.width), y * r.width);
      }
      return { data, width: r.width, height: r.height };
    },
    write: (r, image) => {
      const stride = surface.width;
      for (let y = 0; y < r.height; y += 1) {
        surface.base.set(image.data.subarray(y * r.width, (y + 1) * r.width), (r.y + y) * stride + r.x);
      }
    },
    swapAll: (image) => {
      const previous = { data: surface.base, width: surface.width, height: surface.height };
      surface.base = new Uint8ClampedArray(image.data);
      surface.width = image.width;
      surface.height = image.height;
      return previous;
    },
    burn: (shape) => {
      surface.burned.push(shape);
      fill(shapeUndoRect(shape, surface.width, surface.height), BURNED);
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

/** 上限に当たらない追加(戻り値が `null` でないことを確かめて返す)。 */
function add(shape: EditableShape): AnnotationObject {
  const object = addShapeObject(shape);
  if (!object) {
    throw new Error("addShapeObject が null を返した");
  }
  return object;
}

/** 色(穴は色を持たないので `undefined`、QE-T15)。 */
function shapeColor(shape: EditableShape | undefined): string | undefined {
  return shape && "color" in shape ? shape.color : undefined;
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
    const first = add(box(10));
    const second = add(box(60));
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
      added.push(add(box(i * 5)));
    }
    const oldest = added[0]!;
    const oldestRect = shapeUndoRect(oldest.shape, W, H);
    expect(sumRegion(surface, oldestRect)).toBe(0);

    const newest = add(box(300, 200));

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
    const o = add(box(10));
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
    const o = add(box(10));
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
    const a = add(box(10));
    const b = add(box(60));
    const c = add(box(110));
    expect(removeShapeObject(b.id)).toBe(true);
    expect(getDocumentState().objects).toEqual([a, c]);
    expect(getDocumentState().selectedId).toBe(c.id);
    undoDocument();
    expect(getDocumentState().objects).toEqual([a, b, c]);
    redoDocument();
    expect(getDocumentState().objects).toEqual([a, c]);
  });

  it("選択中を消したら選択を外し、存在しないidは何もしない", () => {
    const a = add(box(10));
    removeShapeObject(a.id);
    expect(getDocumentState().selectedId).toBeNull();
    const depth = getUndoStackState().undo.length;
    expect(removeShapeObject(999)).toBe(false);
    expect(getUndoStackState().undo.length).toBe(depth);
  });
});

describe("setHiddenObject(再編集中のテキストを入力欄と二重に描かない、T33)", () => {
  it("隠したオブジェクトは描画に渡さず、解除すると戻る。モデル・取り消しには影響しない", () => {
    const a = add(box(10));
    const b = add(box(60));
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
    const a = add(box(10));
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
    const o = add(box(10));
    expect(setSelectedColor(COLOR)).toBe(false);
    expect(setSelectedColor("#007AFF")).toBe(true);
    expect(shapeColor(getDocumentState().objects[0]?.shape)).toBe("#007AFF");
    undoDocument();
    expect(shapeColor(getDocumentState().objects[0]?.shape)).toBe(COLOR);
    expect(getDocumentState().selectedId).toBe(o.id);
  });

  it("previewSelectedColor: 下書きで色だけを見せ、モデル・取り消しは変えない", () => {
    const o = add(box(10));
    const depth = getUndoStackState().undo.length;
    previewSelectedColor("#34C759");
    expect(getDocumentState().draft).toEqual({ id: o.id, shape: { ...box(10), color: "#34C759" } });
    expect(shapeColor(getDocumentState().objects[0]?.shape)).toBe(COLOR);
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
    const t = add(text);
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
    const a = add(box(10));
    const b = add(box(60));
    const c = add(box(110));
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
    const a = add(box(10));
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
    expect(add(box(90)).id).toBeGreaterThan(a.id);
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
    const o = add(box(10));
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

describe("applyBaseEdits(複数矩形のベース加工を1手に、AM-T07)", () => {
  /** 矩形の今のピクセルに`delta`を足して書く(直前のピクセルに依存する加工の見立て)。 */
  const addTo = (delta: number) => (_ctx: CanvasRenderingContext2D, r: Rect) => {
    const image = surface.read(r);
    surface.write(r, { ...image, data: image.data.map((v) => v + delta) });
  };
  const fillPattern = () => {
    for (let i = 0; i < surface.base.length; i += 1) {
      surface.base[i] = i % 97;
    }
  };
  const rects: Rect[] = [
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 50, y: 50, width: 20, height: 5 },
    { x: 200, y: 100, width: 8, height: 30 },
  ];

  it("矩形3件で group が1手だけ積まれ、1回の取り消しで3件とも戻り、やり直しで再びかかる", () => {
    fillPattern();
    const original = surface.base.slice();
    expect(applyBaseEdits(rects, addTo(10))).toBe(3);
    const edited = surface.base.slice();
    expect(edited).not.toEqual(original);

    const undo = getUndoStackState().undo;
    expect(undo).toHaveLength(1);
    const step = undo[0]!;
    expect(step.type).toBe("group");
    expect(step.type === "group" && step.commands.map((c) => c.type)).toEqual(["pixels", "pixels", "pixels"]);

    expect(undoDocument()).toBe(true);
    expect(surface.base).toEqual(original);
    expect(canUndo()).toBe(false);
    expect(redoDocument()).toBe(true);
    expect(surface.base).toEqual(edited);
  });

  it("重なる2矩形でも、取り消し後に元の画素と完全一致し、やり直しで同じ結果に戻る", () => {
    fillPattern();
    const original = surface.base.slice();
    const overlapping: Rect[] = [
      { x: 10, y: 10, width: 30, height: 30 },
      { x: 25, y: 25, width: 30, height: 30 },
    ];
    applyBaseEdits(overlapping, addTo(10));
    // 重なり部分は2回加工される(矩形ごとに直前のピクセルを読んでから加工する)。
    expect(surface.base[30 * W + 30]).toBe(((30 * W + 30) % 97) + 20);
    const edited = surface.base.slice();

    undoDocument();
    expect(surface.base).toEqual(original);
    redoDocument();
    expect(surface.base).toEqual(edited);
    undoDocument();
    expect(surface.base).toEqual(original);
  });

  it("0件なら何も積まず、加工も再描画もしない", () => {
    const renders = surface.renders.length;
    expect(applyBaseEdits([], addTo(10))).toBe(0);
    expect(canUndo()).toBe(false);
    expect(surface.renders).toHaveLength(renders);
  });

  it("幅・高さ0の矩形は飛ばし、残りだけを1手に積む(戻り値は実際に適用した件数)", () => {
    const drawn: Rect[] = [];
    const applied = applyBaseEdits(
      [
        { x: 0, y: 0, width: 0, height: 10 },
        { x: 5, y: 5, width: 10, height: 10 },
        { x: 20, y: 20, width: 10, height: 0 },
      ],
      (ctx, r) => {
        drawn.push(r);
        addTo(1)(ctx, r);
      },
    );
    expect(drawn).toEqual([{ x: 5, y: 5, width: 10, height: 10 }]);
    expect(applied).toBe(1);
    const undo = getUndoStackState().undo;
    expect(undo).toHaveLength(1);
    expect(undo[0]!.type === "group" && undo[0]!.commands).toHaveLength(1);
  });

  it("有効な矩形が1件も無ければ何も積まない", () => {
    expect(applyBaseEdits([{ x: 0, y: 0, width: 0, height: 0 }], addTo(1))).toBe(0);
    expect(canUndo()).toBe(false);
  });

  it("小数の矩形は整数化し、画像の外へはみ出す分は切り詰めてから加工する", () => {
    const drawn: Rect[] = [];
    applyBaseEdits(
      [
        { x: 1.4, y: 2.6, width: 9.6, height: 4.4 },
        { x: W - 5, y: -3, width: 20, height: 10 },
      ],
      (ctx, r) => {
        drawn.push(r);
        addTo(1)(ctx, r);
      },
    );
    expect(drawn).toEqual([
      { x: 1, y: 3, width: 10, height: 4 },
      { x: W - 5, y: 0, width: 5, height: 7 },
    ]);
  });

  it("取り消し後に新しい操作をするとやり直しは消える(既存の取り消しと同じ)", () => {
    applyBaseEdits(rects, addTo(1));
    undoDocument();
    expect(canRedo()).toBe(true);
    applyBaseEdits(rects.slice(0, 1), addTo(1));
    expect(canRedo()).toBe(false);
  });

  it("commandPixelBytes() は group 内の pixels の合計を返す", () => {
    applyBaseEdits(rects, addTo(1));
    const step = getUndoStackState().undo[0]!;
    // 偽のサーフェスは1画素=1バイト。
    expect(commandPixelBytes(step)).toBe(10 * 10 + 20 * 5 + 8 * 30);
  });

  it("サーフェスが無ければ何もしない", () => {
    setDocumentSurface(null);
    expect(applyBaseEdits(rects, addTo(1))).toBe(0);
    expect(canUndo()).toBe(false);
  });
});

describe("selectObject / setDraft / subscribeDocument", () => {
  it("選択は取り消し対象にならず、存在しないidは選べない", () => {
    const o = add(box(10));
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
    const o = add(box(10));
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

describe("スタンプと上限の焼き込みの選び方(QE-T11、ARCH_quick-edits §15 #2・#3)", () => {
  const stamp = (x: number, glyph: StampShape["glyph"] = "number"): StampShape => ({
    kind: "stamp",
    center: { x, y: 150 },
    glyph,
    color: COLOR,
    fontSize: "medium",
  });

  it("50 個 + 1 で最も奥が番号スタンプなら、次の注釈を焼き込む(1 回の取り消しで戻る)", () => {
    const added: AnnotationObject[] = [add(stamp(50))];
    for (let i = 1; i < OBJECT_LIMIT; i += 1) {
      added.push(add(box(i * 5)));
    }
    const newest = add(box(300, 200));
    const { objects } = getDocumentState();
    expect(objects).toHaveLength(OBJECT_LIMIT);
    expect(surface.burned).toEqual([added[1]!.shape]);
    expect(objects[0]).toBe(added[0]); // 番号スタンプは残る
    expect(objects).not.toContain(added[1]);
    expect(last(objects)).toBe(newest);

    undoDocument();
    expect(getDocumentState().objects).toEqual(added);
    redoDocument();
    expect(getDocumentState().objects[0]).toBe(added[0]);
    expect(getDocumentState().objects).not.toContainEqual(added[1]);
  });

  it("全部が番号スタンプなら 51 個目は追加せず null を返し、状態・取り消しを変えない", () => {
    for (let i = 0; i < OBJECT_LIMIT; i += 1) {
      add(stamp(10 + i * 7));
    }
    const before = getDocumentState();
    const undoBefore = getUndoStackState();
    const rendersBefore = surface.renders.length;

    expect(addShapeObject(box(300, 200))).toBeNull();
    expect(addShapeObject(stamp(20))).toBeNull();

    expect(getDocumentState()).toBe(before);
    expect(getUndoStackState()).toEqual(undoBefore);
    expect(surface.burned).toEqual([]);
    expect(surface.renders.length).toBe(rendersBefore);
    // 取り消しは直前の 50 個目の追加を戻す(51 個目の手は積まれていない)
    undoDocument();
    expect(getDocumentState().objects).toHaveLength(OBJECT_LIMIT - 1);
  });

  it("記号スタンプは焼き込まれる", () => {
    const added: AnnotationObject[] = [];
    for (let i = 0; i < OBJECT_LIMIT; i += 1) {
      added.push(add(stamp(10 + i * 7, "check")));
    }
    add(stamp(300, "cross"));
    expect(surface.burned).toEqual([added[0]!.shape]);
    expect(getDocumentState().objects).toHaveLength(OBJECT_LIMIT);
  });

  it("setSelectedFontSize: スタンプは中心を保って文字サイズを変え、1 回の取り消しで戻る(測る手段は要らない)", () => {
    setTextMeasurer(null);
    const s = add(stamp(100));
    expect(setSelectedFontSize("medium")).toBe(false); // 同じサイズ
    const depth = getUndoStackState().undo.length;
    expect(setSelectedFontSize("large")).toBe(true);
    const resized = getDocumentState().objects.find((o) => o.id === s.id)!.shape as StampShape;
    expect(resized).toEqual({ ...stamp(100), fontSize: "large" });
    expect(resized.center).toEqual(stamp(100).center);
    expect(getUndoStackState().undo.length).toBe(depth + 1);
    undoDocument();
    expect(getDocumentState().objects.find((o) => o.id === s.id)!.shape).toEqual(stamp(100));
  });

  it("setSelectedColor: スタンプの色の変更は 1 手", () => {
    const s = add(stamp(100, "exclamation"));
    const depth = getUndoStackState().undo.length;
    expect(setSelectedColor("#007AFF")).toBe(true);
    expect(shapeColor(getDocumentState().objects[0]?.shape)).toBe("#007AFF");
    expect(getUndoStackState().undo.length).toBe(depth + 1);
    undoDocument();
    expect(getDocumentState().objects[0]?.shape).toEqual(stamp(100, "exclamation"));
    expect(getDocumentState().selectedId).toBe(s.id);
  });

  it("履歴への退避(documentArchive)・復元でスタンプが保たれ、取り消しもできる", () => {
    const s = add(stamp(100));
    setSelectedFontSize("small");
    saveArchivedDocument("qe-t11", { base: new Blob(["base"]), snapshot: snapshotDocument() });
    resetDocument();
    const archived = getArchivedDocument("qe-t11")!;
    restoreDocument(archived.snapshot, { width: W, height: H } as unknown as ImageBitmap, null);
    deleteArchivedDocument("qe-t11");
    expect(getDocumentState().objects).toEqual([{ id: s.id, shape: { ...stamp(100), fontSize: "small" } }]);
    undoDocument();
    expect(getDocumentState().objects).toEqual([s]);
  });
});

describe("穴(スポットライト)と上限・色・文字サイズ(QE-T15、ARCH_quick-edits §5.3・§15 #3)", () => {
  const hole = (x: number, y = 100): SpotlightShape => ({
    kind: "spotlight",
    rect: { x, y, width: 30, height: 30 },
  });
  const numberStamp = (x: number): StampShape => ({
    kind: "stamp",
    center: { x, y: 250 },
    glyph: "number",
    color: COLOR,
    fontSize: "medium",
  });

  it("50 個 + 1 で穴と番号スタンプを飛ばし、最初の焼き込める注釈を焼き込む", () => {
    const added: AnnotationObject[] = [add(hole(0)), add(numberStamp(20))];
    for (let i = 2; i < OBJECT_LIMIT; i += 1) {
      added.push(add(box(i * 5)));
    }
    add(box(300, 200));
    expect(surface.burned).toEqual([added[2]!.shape]);
    expect(getDocumentState().objects.slice(0, 2)).toEqual(added.slice(0, 2));
  });

  it("全部が穴なら 51 個目は追加せず null を返し、状態・取り消し・描画を変えない", () => {
    for (let i = 0; i < OBJECT_LIMIT; i += 1) {
      add(hole(i * 7));
    }
    const before = getDocumentState();
    const undoBefore = getUndoStackState();
    const rendersBefore = surface.renders.length;

    expect(addShapeObject(hole(300))).toBeNull();
    expect(addShapeObject(box(300, 200))).toBeNull();

    expect(getDocumentState()).toBe(before);
    expect(getUndoStackState()).toEqual(undoBefore);
    expect(surface.burned).toEqual([]);
    expect(surface.renders.length).toBe(rendersBefore);
  });

  it("穴を選んでいるとき setSelectedColor・previewSelectedColor・setSelectedFontSize は何もしない", () => {
    setTextMeasurer(null);
    add(hole(50));
    const depth = getUndoStackState().undo.length;
    const rendersBefore = surface.renders.length;
    expect(setSelectedColor("#007AFF")).toBe(false);
    previewSelectedColor("#007AFF");
    expect(getDocumentState().draft).toBeNull();
    expect(setSelectedFontSize("large")).toBe(false);
    expect(getDocumentState().objects[0]?.shape).toEqual(hole(50));
    expect(getUndoStackState().undo.length).toBe(depth);
    expect(surface.renders.length).toBe(rendersBefore);
  });

  it("穴の移動・リサイズ・削除はそれぞれ 1 手で取り消せる", () => {
    const h = add(hole(50));
    expect(commitShapeEdit(h.id, hole(80))).toBe(true);
    expect(removeShapeObject(h.id)).toBe(true);
    undoDocument();
    expect(getDocumentState().objects).toEqual([{ id: h.id, shape: hole(80) }]);
    undoDocument();
    expect(getDocumentState().objects).toEqual([h]);
  });
});

describe("composeDocument(合成の段: ベース → 暗さ → 穴以外の注釈 → 穴以外の下書き、QE-T15)", () => {
  type Call = { name: string; args: unknown[] } | { name: "set"; prop: string; value: unknown };

  /** 呼び出しとプロパティの代入を順に記録する偽の 2D コンテキスト。 */
  function fakeContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
    const calls: Call[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_target, prop) => (...args: unknown[]) => {
        calls.push({ name: String(prop), args });
        // スタンプの文字の縦位置に使う寸法(値は描く順の検証に関係しない)
        return prop === "measureText" ? { actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 } : undefined;
      },
      set: (_target, prop, value) => {
        calls.push({ name: "set", prop: String(prop), value });
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  }

  const base = { kind: "base" } as unknown as CanvasImageSource;
  const hole = (x: number, y = 100, size = 40): AnnotationObject["shape"] => ({
    kind: "spotlight",
    rect: { x, y, width: size, height: size },
  });
  const objects = (...shapes: EditableShape[]): AnnotationObject[] =>
    shapes.map((shape, index) => ({ id: index + 1, shape }));

  /** 暗さの塗り(`fillStyle = SPOTLIGHT_SHADE` の後の `fill`)の位置。 */
  function shadeFills(calls: Call[]): number[] {
    const result: number[] = [];
    let style: unknown = null;
    calls.forEach((call, index) => {
      if (call.name === "set" && "prop" in call && call.prop === "fillStyle") {
        style = call.value;
      }
      if (call.name === "fill" && style === SPOTLIGHT_SHADE) {
        result.push(index);
      }
    });
    return result;
  }

  const indexOf = (calls: Call[], name: string): number => calls.findIndex((c) => c.name === name);

  it("穴があれば、ベースの転写の後・注釈より前に、暗さを 1 回だけ塗る(1 本のパス)", () => {
    const { ctx, calls } = fakeContext();
    composeDocument(ctx, base, W, H, objects(box(10), hole(100), hole(120, 110), box(200)), null);

    const fills = shadeFills(calls);
    expect(fills).toHaveLength(1);
    expect(indexOf(calls, "drawImage")).toBeLessThan(fills[0]!);
    expect(indexOf(calls, "stroke")).toBeGreaterThan(fills[0]!);
    // 1 本のパス: beginPath は塗りの前に 1 回で、塗る矩形をすべて rect で足す
    const shadeStart = calls.slice(0, fills[0]).map((c) => c.name).lastIndexOf("beginPath");
    const rects = calls.slice(shadeStart, fills[0]).filter((c) => c.name === "rect");
    const expected = spotlightShadeRects(
      [
        { x: 100, y: 100, width: 40, height: 40 },
        { x: 120, y: 110, width: 40, height: 40 },
      ],
      W,
      H,
    );
    expect(rects.map((c) => ("args" in c ? c.args : null))).toEqual(
      expected.map((r) => [r.x, r.y, r.width, r.height]),
    );
    // 穴以外の注釈(矩形 2 つ)は重ね順に描き、穴そのものは何も描かない
    expect(calls.filter((c) => c.name === "stroke")).toHaveLength(2);
  });

  it("穴が 0 個なら暗さを塗らない", () => {
    const { ctx, calls } = fakeContext();
    composeDocument(ctx, base, W, H, objects(box(10)), null);
    expect(shadeFills(calls)).toEqual([]);
    expect(calls.some((c) => c.name === "rect")).toBe(false);
  });

  it("作成中の穴の下書きも暗さに含め、下書きの穴そのものは描かない", () => {
    const { ctx, calls } = fakeContext();
    composeDocument(ctx, base, W, H, objects(box(10)), { id: null, shape: hole(150) });
    expect(shadeFills(calls)).toHaveLength(1);
    expect(calls.filter((c) => c.name === "stroke")).toHaveLength(1);
  });

  it("移動中の穴は下書きの位置で暗さを求める", () => {
    const { ctx, calls } = fakeContext();
    composeDocument(ctx, base, W, H, objects(hole(0, 0)), { id: 1, shape: hole(200, 150) });
    const rects = calls.filter((c) => c.name === "rect").map((c) => ("args" in c ? c.args : null));
    expect(rects).toEqual(
      spotlightShadeRects([{ x: 200, y: 150, width: 40, height: 40 }], W, H).map((r) => [r.x, r.y, r.width, r.height]),
    );
  });

  it("穴が画像全体を覆えば塗らない", () => {
    const { ctx, calls } = fakeContext();
    composeDocument(ctx, base, W, H, [{ id: 1, shape: { kind: "spotlight", rect: { x: 0, y: 0, width: W, height: H } } }], null);
    expect(shadeFills(calls)).toEqual([]);
  });

  it("番号スタンプには合成ごとの番号を渡す(穴を挟んでも番号は変わらない)", () => {
    const { ctx, calls } = fakeContext();
    const stamp: StampShape = { kind: "stamp", center: { x: 50, y: 50 }, glyph: "number", color: COLOR, fontSize: "medium" };
    composeDocument(ctx, base, W, H, objects(stamp, hole(100), { ...stamp, center: { x: 150, y: 50 } }), null);
    const texts = calls.filter((c) => c.name === "fillText").map((c) => ("args" in c ? c.args[0] : null));
    expect(texts).toEqual(["1", "2"]);
  });
});

describe("captureSize(モザイクの粗さの基準、QE-T18・ADR-002)", () => {
  /** 大きさを後から変えられる偽のサーフェス(トリミング等でベースの大きさが変わった状況を作る)。 */
  function resizable(width: number, height: number) {
    const size = { width, height };
    const fake: FakeSurface = { ...createFakeSurface(), size: () => ({ ...size }) };
    setDocumentSurface(fake);
    return size;
  }

  it("新規(resetDocument)では読み込んだ画像の大きさになる", () => {
    resizable(2000, 1500);
    resetDocument();
    expect(getCaptureSize()).toEqual({ width: 2000, height: 1500 });
  });

  it("ベースの大きさが後から変わっても変わらない", () => {
    const size = resizable(2000, 1500);
    resetDocument();
    size.width = 400;
    size.height = 300;
    expect(getCaptureSize()).toEqual({ width: 2000, height: 1500 });
  });

  it("次の画像を読み込むと、その画像の大きさに置き換わる", () => {
    const size = resizable(2000, 1500);
    resetDocument();
    size.width = 640;
    size.height = 480;
    resetDocument();
    expect(getCaptureSize()).toEqual({ width: 640, height: 480 });
  });

  it("退避(snapshotDocument)に入り、退避からの復元で退避の値に戻る(画像の大きさではない)", () => {
    const size = resizable(2000, 1500);
    resetDocument();
    const snapshot = snapshotDocument();
    expect(snapshot.captureSize).toEqual({ width: 2000, height: 1500 });

    size.width = 640;
    size.height = 480;
    resetDocument(); // 別の画像
    expect(getCaptureSize()).toEqual({ width: 640, height: 480 });

    restoreDocument(snapshot, { width: 400, height: 300 } as unknown as ImageBitmap, null);
    expect(getCaptureSize()).toEqual({ width: 2000, height: 1500 });
  });

  it("captureSize の無い古い退避からの復元では、戻した画像の大きさになる", () => {
    resetDocument();
    const { captureSize: _omitted, ...legacy } = snapshotDocument();
    restoreDocument(legacy, { width: 800, height: 600 } as unknown as ImageBitmap, null);
    expect(getCaptureSize()).toEqual({ width: 800, height: 600 });
  });

  it("履歴への退避(documentArchive)を通しても保たれる", () => {
    resizable(2000, 1500);
    resetDocument();
    saveArchivedDocument("qe-t18", { base: new Blob(["base"]), snapshot: snapshotDocument() });
    resetDocument();
    const archived = getArchivedDocument("qe-t18")!;
    deleteArchivedDocument("qe-t18");
    restoreDocument(archived.snapshot, { width: 10, height: 10 } as unknown as ImageBitmap, null);
    expect(getCaptureSize()).toEqual({ width: 2000, height: 1500 });
  });

  it("サーフェスが無ければ null", () => {
    setDocumentSurface(null);
    resetDocument();
    expect(getCaptureSize()).toBeNull();
  });
});

describe("applyCrop(トリミングの確定、QE-T20・ARCH_quick-edits §5.4・§7.1 C・ADR-002)", () => {
  /** ベースを位置ごとに違う値で埋める(切り詰め・戻しの中身を確かめるため)。 */
  function paintBase(): Uint8ClampedArray {
    for (let i = 0; i < surface.base.length; i += 1) {
      surface.base[i] = i % 251;
    }
    return surface.base.slice();
  }
  const DIAGONAL = Math.hypot(W, H);
  const CROP: Rect = { x: 5, y: 5, width: 100, height: 80 };

  it("確定で大きさ・注釈の位置が変わり、範囲の外へ完全に出た注釈は消え、選んでいれば選択が外れる", () => {
    const original = paintBase();
    const inside = add(box(10)); // (10,10)-(30,30): 残る
    const outside = add(box(300, 200)); // 範囲の外: 消える
    expect(getDocumentState().selectedId).toBe(outside.id);
    const undoDepth = getUndoStackState().undo.length;

    // 端数は四捨五入される(5.4 → 5、4.6 → 5)。
    expect(applyCrop({ x: 5.4, y: 4.6, width: 100, height: 80 })).toBe(true);

    expect(surface.size()).toEqual({ width: 100, height: 80 });
    expect(surface.base[0]).toBe(original[5 * W + 5]);
    expect(surface.base[79 * 100 + 99]).toBe(original[84 * W + 104]);
    expect(getDocumentState().objects).toEqual([
      { id: inside.id, shape: { ...box(5, 5), styleBasis: DIAGONAL } },
    ]);
    expect(getDocumentState().selectedId).toBeNull();
    expect(getDocumentState().draft).toBeNull();
    // 取り消し 1 手(group[crop, update, remove])。
    expect(getUndoStackState().undo).toHaveLength(undoDepth + 1);
    const top = last(getUndoStackState().undo)!;
    expect(top.type).toBe("group");
    expect(top.type === "group" && top.commands.map((c) => c.type)).toEqual(["crop", "update", "remove"]);
    // 撮った時点の大きさ(モザイクの粗さの基準)は変えない。
    expect(getCaptureSize()).toEqual({ width: W, height: H });
    // 再描画・通知された。
    expect(last(surface.renders)?.objects).toEqual(getDocumentState().objects);
  });

  it("選んでいた注釈が残るなら選択を保つ", () => {
    paintBase();
    const inside = add(box(10));
    applyCrop(CROP);
    expect(getDocumentState().selectedId).toBe(inside.id);
  });

  it("1 回の取り消しで元の大きさ・中身・注釈の位置・消えた注釈が戻り、やり直しで再び切り詰める", () => {
    const original = paintBase();
    const inside = add(box(10));
    const outside = add(box(300, 200));
    applyCrop(CROP);
    const cropped = surface.base.slice();
    const croppedObjects = getDocumentState().objects;

    expect(undoDocument()).toBe(true);
    expect(surface.size()).toEqual({ width: W, height: H });
    expect(surface.base).toEqual(original);
    expect(getDocumentState().objects).toEqual([inside, outside]);

    expect(redoDocument()).toBe(true);
    expect(surface.size()).toEqual({ width: 100, height: 80 });
    expect(surface.base).toEqual(cropped);
    expect(getDocumentState().objects).toEqual(croppedObjects);
  });

  it("トリミングより前のモザイク(pixels)・追加(add)を続けて戻せる", () => {
    const original = paintBase();
    const a = add(box(10));
    const mosaic: Rect = { x: 0, y: 0, width: 50, height: 50 };
    applyBaseEdit(mosaic, () => {
      surface.write(mosaic, { data: new Uint8ClampedArray(50 * 50).fill(3), width: 50, height: 50 });
    });
    const mosaicked = surface.base.slice();
    applyCrop(CROP);

    undoDocument(); // トリミング
    expect(surface.base).toEqual(mosaicked);
    expect(getDocumentState().objects).toEqual([a]);
    undoDocument(); // モザイク
    expect(surface.base).toEqual(original);
    undoDocument(); // 追加
    expect(getDocumentState().objects).toEqual([]);
    expect(canUndo()).toBe(false);

    // やり直しも順に戻る。
    redoDocument();
    redoDocument();
    redoDocument();
    expect(surface.size()).toEqual({ width: 100, height: 80 });
    expect(getDocumentState().objects).toEqual([{ id: a.id, shape: { ...box(5, 5), styleBasis: DIAGONAL } }]);
  });

  it("何もしない範囲(全体と同じ・幅や高さが 0)では手を積まず、画像も変えない", () => {
    paintBase();
    add(box(10));
    const depth = getUndoStackState().undo.length;
    const renders = surface.renders.length;
    expect(applyCrop({ x: 0, y: 0, width: W, height: H })).toBe(false);
    expect(applyCrop({ x: -10, y: -10, width: W + 20, height: H + 20 })).toBe(false);
    expect(applyCrop({ x: 10, y: 10, width: 0, height: 50 })).toBe(false);
    expect(applyCrop({ x: 10, y: 10, width: 0.2, height: 50 })).toBe(false);
    expect(getUndoStackState().undo).toHaveLength(depth);
    expect(surface.size()).toEqual({ width: W, height: H });
    expect(surface.renders.length).toBe(renders);
  });

  it("サーフェスが無ければ何もしない", () => {
    setDocumentSurface(null);
    expect(applyCrop(CROP)).toBe(false);
  });

  it("2 回のトリミングを 2 回の取り消しで順に戻せる(2 回目は styleBasis を変えない)", () => {
    const original = paintBase();
    const a = add(box(10));
    applyCrop(CROP); // 100×80、a は (5,5)
    const firstBase = surface.base.slice();
    const firstObjects = getDocumentState().objects;
    applyCrop({ x: 2, y: 3, width: 50, height: 40 }); // 50×40、a は (3,2)
    expect(surface.size()).toEqual({ width: 50, height: 40 });
    expect(getDocumentState().objects).toEqual([{ id: a.id, shape: { ...box(3, 2), styleBasis: DIAGONAL } }]);

    undoDocument();
    expect(surface.size()).toEqual({ width: 100, height: 80 });
    expect(surface.base).toEqual(firstBase);
    expect(getDocumentState().objects).toEqual(firstObjects);
    undoDocument();
    expect(surface.size()).toEqual({ width: W, height: H });
    expect(surface.base).toEqual(original);
    expect(getDocumentState().objects).toEqual([a]);
  });

  it("消えた注釈を再編集中(非表示)なら非表示も外す", () => {
    paintBase();
    const outside = add(box(300, 200));
    setHiddenObject(outside.id);
    applyCrop(CROP);
    expect(getDocumentState().hiddenId).toBeNull();
  });

  it("取り消しの手は切る前のベース全体を数える(commandPixelBytes)", () => {
    paintBase();
    applyCrop(CROP);
    expect(commandPixelBytes(last(getUndoStackState().undo)!)).toBe(W * H);
    undoDocument();
    // 取り消した後のやり直し側は切り詰めたベースを持つ。
    expect(commandPixelBytes(last(getUndoStackState().redo)!)).toBe(100 * 80);
  });
});
