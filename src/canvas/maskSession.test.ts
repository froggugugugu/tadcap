import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import type { CanvasImage } from "./canvasState";
import {
  acceptScanResult,
  activeRects,
  beginScan,
  discardMaskSession,
  failScan,
  getMaskSession,
  subscribeMaskSession,
  toggleCandidate,
  type MaskCandidate,
  type MaskCandidateInput,
  type MaskKind,
  type MaskSessionState,
} from "./maskSession";

/** 参照比較で別物と判定される画像を作る(`setCanvasImage()` と同じく毎回新しいオブジェクト)。 */
function makeImage(): CanvasImage {
  return { assetUrl: "blob:test", capture: null };
}

const INPUTS: MaskCandidateInput[] = [
  { rect: { x: 10, y: 20, width: 30, height: 40 }, kind: "contact" },
  { rect: { x: 100, y: 0, width: 50, height: 12 }, kind: "credential" },
  { rect: { x: 5, y: 5, width: 8, height: 8 }, kind: "financial" },
];

/** `review` まで進めて、開始時の画像と token を返す。 */
function enterReview(inputs: MaskCandidateInput[] = INPUTS): {
  image: CanvasImage;
  token: number;
} {
  const image = makeImage();
  const token = beginScan(image);
  if (token === null) throw new Error("beginScan が開始しなかった");
  expect(acceptScanResult(token, image, inputs)).toBe(true);
  return { image, token };
}

beforeEach(() => {
  discardMaskSession();
});

describe("状態遷移 idle → scanning → review → idle", () => {
  it("初期状態は idle", () => {
    expect(getMaskSession()).toEqual({ status: "idle" });
  });

  it("beginScan() で token を発行し scanning へ、結果を受け取ると review へ、破棄で idle へ", () => {
    const image = makeImage();
    const token = beginScan(image);

    expect(token).not.toBeNull();
    const scanning = getMaskSession();
    expect(scanning.status).toBe("scanning");
    if (scanning.status !== "scanning") return;
    expect(scanning.token).toBe(token);
    expect(scanning.image).toBe(image);

    expect(acceptScanResult(token as number, image, INPUTS)).toBe(true);
    const review = getMaskSession();
    expect(review.status).toBe("review");
    if (review.status !== "review") return;
    expect(review.token).toBe(token);
    expect(review.image).toBe(image);
    expect(review.candidates.map((c) => c.kind)).toEqual(["contact", "credential", "financial"]);
    expect(review.candidates.every((c) => c.excluded === false)).toBe(true);
    expect(new Set(review.candidates.map((c) => c.id)).size).toBe(3);

    discardMaskSession();
    expect(getMaskSession()).toEqual({ status: "idle" });
  });

  it("0 件の結果でも review へ進む(0 件の文言を出すため)", () => {
    enterReview([]);
    const state = getMaskSession();
    expect(state.status).toBe("review");
    if (state.status !== "review") return;
    expect(state.candidates).toEqual([]);
  });

  it("beginScan() のたびに別の token を発行する", () => {
    const first = beginScan(makeImage());
    discardMaskSession();
    const second = beginScan(makeImage());
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});

describe("二重実行の防止", () => {
  it("scanning 中の beginScan() は何もせず null を返す(token・画像は変わらない)", () => {
    const image = makeImage();
    const token = beginScan(image);
    const before = getMaskSession();

    expect(beginScan(makeImage())).toBeNull();
    expect(getMaskSession()).toBe(before);
    const state = getMaskSession();
    if (state.status !== "scanning") throw new Error("scanning のはず");
    expect(state.token).toBe(token);
    expect(state.image).toBe(image);
  });

  it("review 中の beginScan() も何もしない【仮定】", () => {
    enterReview();
    const before = getMaskSession();
    expect(beginScan(makeImage())).toBeNull();
    expect(getMaskSession()).toBe(before);
  });
});

describe("古い結果の破棄(acceptScanResult)", () => {
  it("古い token の結果は捨てて状態を変えない", () => {
    const oldImage = makeImage();
    const oldToken = beginScan(oldImage) as number;
    discardMaskSession(); // 画像の切替
    const image = makeImage();
    beginScan(image);
    const before = getMaskSession();

    expect(acceptScanResult(oldToken, image, INPUTS)).toBe(false);
    expect(getMaskSession()).toBe(before);
  });

  it("開始時と別の CanvasImage の結果は捨てて状態を変えない", () => {
    const token = beginScan(makeImage()) as number;
    const before = getMaskSession();

    expect(acceptScanResult(token, makeImage(), INPUTS)).toBe(false);
    expect(getMaskSession()).toBe(before);
  });

  it("idle(破棄後)に届いた結果は捨てて idle のまま", () => {
    const image = makeImage();
    const token = beginScan(image) as number;
    discardMaskSession();

    expect(acceptScanResult(token, image, INPUTS)).toBe(false);
    expect(getMaskSession()).toEqual({ status: "idle" });
  });

  it("review 中に同じ token の結果が再度届いても候補を差し替えない", () => {
    const { image, token } = enterReview();
    const before = getMaskSession();

    expect(acceptScanResult(token, image, [])).toBe(false);
    expect(getMaskSession()).toBe(before);
  });
});

describe("failScan()", () => {
  it("scanning から idle に戻す", () => {
    const token = beginScan(makeImage()) as number;
    failScan(token);
    expect(getMaskSession()).toEqual({ status: "idle" });
  });

  it("古い token の失敗は今の処理を止めない【仮定】", () => {
    const oldToken = beginScan(makeImage()) as number;
    discardMaskSession();
    beginScan(makeImage());
    const before = getMaskSession();

    failScan(oldToken);
    expect(getMaskSession()).toBe(before);
  });

  it("review 中の失敗通知は無視する", () => {
    const { token } = enterReview();
    const before = getMaskSession();
    failScan(token);
    expect(getMaskSession()).toBe(before);
  });
});

describe("toggleCandidate() と activeRects()", () => {
  it("外す → 戻すで excluded が切り替わる", () => {
    enterReview();
    const id = (getMaskSession() as Extract<MaskSessionState, { status: "review" }>).candidates[1]
      .id;

    toggleCandidate(id);
    let state = getMaskSession() as Extract<MaskSessionState, { status: "review" }>;
    expect(state.candidates.map((c) => c.excluded)).toEqual([false, true, false]);

    toggleCandidate(id);
    state = getMaskSession() as Extract<MaskSessionState, { status: "review" }>;
    expect(state.candidates.map((c) => c.excluded)).toEqual([false, false, false]);
  });

  it("切り替えは前の状態オブジェクトを書き換えない(イミュータブル)", () => {
    enterReview();
    const before = getMaskSession() as Extract<MaskSessionState, { status: "review" }>;
    toggleCandidate(before.candidates[0].id);
    expect(before.candidates[0].excluded).toBe(false);
  });

  it("存在しない id は何もしない", () => {
    enterReview();
    const before = getMaskSession();
    toggleCandidate(9999);
    expect(getMaskSession()).toBe(before);
  });

  it("review 以外では何もしない", () => {
    beginScan(makeImage());
    const before = getMaskSession();
    toggleCandidate(0);
    expect(getMaskSession()).toBe(before);
  });

  it("activeRects() は外した候補を含まず、入力の順に矩形を返す", () => {
    enterReview();
    const state = getMaskSession() as Extract<MaskSessionState, { status: "review" }>;
    toggleCandidate(state.candidates[0].id);

    expect(activeRects()).toEqual([
      { x: 100, y: 0, width: 50, height: 12 },
      { x: 5, y: 5, width: 8, height: 8 },
    ]);
  });

  it("すべて外すと activeRects() は空", () => {
    enterReview();
    const state = getMaskSession() as Extract<MaskSessionState, { status: "review" }>;
    for (const c of state.candidates) toggleCandidate(c.id);
    expect(activeRects()).toEqual([]);
  });

  it("review 以外では activeRects() は空", () => {
    expect(activeRects()).toEqual([]);
    beginScan(makeImage());
    expect(activeRects()).toEqual([]);
  });

  it("activeRects() の戻り値を書き換えても候補は変わらない", () => {
    enterReview();
    const rects = activeRects();
    rects[0].x = 999;
    expect(activeRects()[0].x).toBe(10);
  });
});

describe("discardMaskSession()", () => {
  it("scanning から idle", () => {
    beginScan(makeImage());
    discardMaskSession();
    expect(getMaskSession()).toEqual({ status: "idle" });
  });

  it("review から idle(候補も消える)", () => {
    enterReview();
    discardMaskSession();
    expect(getMaskSession()).toEqual({ status: "idle" });
    expect(activeRects()).toEqual([]);
  });

  it("idle からでも idle のまま(例外にならない)", () => {
    discardMaskSession();
    expect(getMaskSession()).toEqual({ status: "idle" });
  });
});

describe("subscribeMaskSession()", () => {
  it("状態が変わるたびに購読者へ通知する", () => {
    const received: string[] = [];
    const unsubscribe = subscribeMaskSession((state) => {
      received.push(state.status);
    });

    const image = makeImage();
    const token = beginScan(image) as number;
    acceptScanResult(token, image, INPUTS);
    const state = getMaskSession() as Extract<MaskSessionState, { status: "review" }>;
    toggleCandidate(state.candidates[0].id);
    discardMaskSession();
    unsubscribe();

    expect(received).toEqual(["scanning", "review", "review", "idle"]);
  });

  it("状態が変わらない操作(無視された呼び出し)では通知しない", () => {
    const image = makeImage();
    const token = beginScan(image) as number;
    const received: string[] = [];
    const unsubscribe = subscribeMaskSession((s) => received.push(s.status));

    beginScan(makeImage()); // scanning 中は無視
    acceptScanResult(token + 100, image, INPUTS); // 古い token
    acceptScanResult(token, makeImage(), INPUTS); // 別の画像
    failScan(token + 100); // 古い token
    toggleCandidate(0); // review でない
    unsubscribe();
    discardMaskSession(); // 解除後
    discardMaskSession(); // idle → idle

    expect(received).toEqual([]);
  });

  it("購読を解除すると通知されない", () => {
    let count = 0;
    const unsubscribe = subscribeMaskSession(() => {
      count += 1;
    });
    unsubscribe();
    beginScan(makeImage());
    expect(count).toBe(0);
  });
});

describe("候補に文字列を持たせない(NFR-002・ARCH §6.1)", () => {
  /** いずれかのフィールドが任意の文字列を入れられる型なら true(`kind` のリテラル型は該当しない)。 */
  type HasFreeString<T> = {
    [K in keyof T]-?: string extends T[K] ? true : false;
  }[keyof T];

  it("MaskCandidate・MaskCandidateInput・矩形は任意の文字列フィールドを持たない(型)", () => {
    expectTypeOf<HasFreeString<MaskCandidate>>().toEqualTypeOf<false>();
    expectTypeOf<HasFreeString<MaskCandidateInput>>().toEqualTypeOf<false>();
    expectTypeOf<HasFreeString<MaskCandidate["rect"]>>().toEqualTypeOf<false>();
    expectTypeOf<keyof MaskCandidate>().toEqualTypeOf<"id" | "rect" | "kind" | "excluded">();
    expectTypeOf<MaskKind>().toEqualTypeOf<
      "contact" | "credential" | "identifier" | "financial"
    >();
  });

  it("入力に余分なフィールドが紛れ込んでも候補には写さない(実行時)", () => {
    const smuggled = {
      rect: { x: 1, y: 2, width: 3, height: 4, label: "secret" },
      kind: "credential",
      text: "secret",
    } as unknown as MaskCandidateInput;
    enterReview([smuggled]);

    const state = getMaskSession() as Extract<MaskSessionState, { status: "review" }>;
    expect(Object.keys(state.candidates[0]).sort()).toEqual(["excluded", "id", "kind", "rect"]);
    expect(Object.keys(state.candidates[0].rect).sort()).toEqual(["height", "width", "x", "y"]);
    expect(JSON.stringify(state.candidates)).not.toContain("secret");
  });
});
