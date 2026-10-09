import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `@tauri-apps/api` は Tauri ランタイム無しでは動作しないため、モックに差し替える
// (`textScan.test.ts` と同じ作法)。本ファイルの実行の組み立ては IPC を差し込みで受けるため、
// ここでは import 時に読み込まれても失敗しないようにするだけ。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import {
  clearCanvasImage,
  getCanvasState,
  setActiveTool,
  setCanvasImage,
  setDrawing,
  type CanvasImage,
} from "../canvas/canvasState";
import type { Rect } from "../canvas/coords";
import {
  acceptScanResult,
  beginScan,
  discardMaskSession,
  getMaskSession,
  toggleCandidate,
  type MaskSessionState,
} from "../canvas/maskSession";
import { TextScanError, type ScannedCandidate } from "../ipc/textScan";
import { arrangeShortcutCommand } from "./arrangeButtons";
import {
  AUTO_MASK_MESSAGES,
  bindMaskSessionToCanvasImage,
  canApplyMosaic,
  canStartScan,
  createAutoMaskController,
  isAutoMaskShortcut,
  isCancelMaskKey,
  maskBarView,
  resultStatusText,
  toMaskCandidateInputs,
  type AutoMaskDeps,
} from "./autoMask";
import { isCopyShortcut } from "./clipboardButton";
import { undoShortcutCommand } from "./undoButton";

/** 参照比較で別物と判定される画像を作る(`setCanvasImage()` と同じく毎回新しいオブジェクト)。 */
function makeImage(): CanvasImage {
  return { assetUrl: `blob:test-${Math.random()}`, capture: null };
}

const FORBIDDEN_WORDS = ["安全", "すべて隠しました", "機密はありません", "自動で隠す"];

const key = (
  k: string,
  mods: Partial<{ metaKey: boolean; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing: boolean }> = {},
) => ({
  key: k,
  metaKey: false,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  ...mods,
});

const cmdShift = (k: string) => key(k, { metaKey: true, shiftKey: true });

const SCANNED: ScannedCandidate[] = [
  { x: 10, y: 20, width: 30, height: 12, kind: "contact" },
  { x: 50, y: 60, width: 40, height: 10, kind: "credential" },
];

/** 外部から解決できる Promise(処理中の状態を作るため)。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** マイクロタスクを流しきる(exportBase → 前の実行の待ち → scan の連鎖を進める)。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

interface Harness {
  deps: AutoMaskDeps;
  image: { current: CanvasImage | null };
  size: { width: number; height: number };
  calls: string[];
  scan: ReturnType<typeof vi.fn>;
  applyBaseEdits: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  drawing: { current: boolean };
}

function makeHarness(scanImpl: (png: Blob) => Promise<ScannedCandidate[]> = async () => SCANNED): Harness {
  const image = { current: makeImage() as CanvasImage | null };
  const size = { width: 200, height: 100 };
  const calls: string[] = [];
  const scan = vi.fn(async (png: Blob) => {
    calls.push("scan");
    return scanImpl(png);
  });
  // 既定は渡した矩形をすべて適用できた扱い(適用した件数を返す)
  const applyBaseEdits = vi.fn((rects: readonly Rect[]) => rects.length);
  const notify = vi.fn();
  const drawing = { current: false };
  const deps: AutoMaskDeps = {
    getImage: () => image.current,
    getImageSize: () => size,
    isDrawing: () => drawing.current,
    commitPendingText: () => {
      calls.push("commit");
    },
    clearSelection: () => {
      calls.push("deselect");
    },
    exportBase: async () => {
      calls.push("export");
      return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    },
    scan,
    applyBaseEdits,
    notify,
  };
  return { deps, image, size, calls, scan, applyBaseEdits, notify, drawing };
}

beforeEach(() => {
  discardMaskSession();
});

describe("canStartScan(開始できる条件、FR-001・FR-014)", () => {
  it("画像があり idle のときだけ開始できる", () => {
    expect(canStartScan(true, { status: "idle" })).toBe(true);
    expect(canStartScan(false, { status: "idle" })).toBe(false);
  });

  it("scanning・review 中は開始しない(二重実行の防止)", () => {
    const image = makeImage();
    const scanning: MaskSessionState = { status: "scanning", token: 1, image };
    const review: MaskSessionState = { status: "review", token: 1, image, candidates: [] };
    expect(canStartScan(true, scanning)).toBe(false);
    expect(canStartScan(true, review)).toBe(false);
  });

  it("ドラッグ中は開始しない(AM-T25-F1 SHOULD-1)", () => {
    expect(canStartScan(true, { status: "idle" }, true)).toBe(false);
    expect(canStartScan(true, { status: "idle" }, false)).toBe(true);
  });
});

describe("isAutoMaskShortcut(⌘⇧M の判定)", () => {
  it("⌘⇧M だけを受け付ける(Shift で大文字になっても判定する)", () => {
    expect(isAutoMaskShortcut(cmdShift("M"), null)).toBe(true);
    expect(isAutoMaskShortcut(cmdShift("m"), null)).toBe(true);
  });

  it("⌘M・⇧M・Ctrl/Option 併用・IME 変換中は対象外", () => {
    expect(isAutoMaskShortcut(key("m", { metaKey: true }), null)).toBe(false);
    expect(isAutoMaskShortcut(key("M", { shiftKey: true }), null)).toBe(false);
    expect(isAutoMaskShortcut(key("M", { metaKey: true, shiftKey: true, ctrlKey: true }), null)).toBe(false);
    expect(isAutoMaskShortcut(key("M", { metaKey: true, shiftKey: true, altKey: true }), null)).toBe(false);
    expect(isAutoMaskShortcut(key("M", { metaKey: true, shiftKey: true, isComposing: true }), null)).toBe(false);
  });

  it("入力欄にフォーカスがあるときは奪わない", () => {
    expect(isAutoMaskShortcut(cmdShift("M"), { tagName: "INPUT", type: "text" })).toBe(false);
    expect(isAutoMaskShortcut(cmdShift("M"), { tagName: "TEXTAREA" })).toBe(false);
    expect(isAutoMaskShortcut(cmdShift("M"), { isContentEditable: true })).toBe(false);
    // 色の選択(type="color")は文字入力ではないため奪ってよい
    expect(isAutoMaskShortcut(cmdShift("M"), { tagName: "INPUT", type: "color" })).toBe(true);
  });

  it("既存のショートカットと重ならない", () => {
    for (const k of ["F", "B", "Z", "2", "C"]) {
      expect(isAutoMaskShortcut(cmdShift(k), null)).toBe(false);
    }
    expect(isAutoMaskShortcut(key("c", { metaKey: true }), null)).toBe(false);
    expect(isAutoMaskShortcut(key("z", { metaKey: true }), null)).toBe(false);
    // 逆向き: 既存の判定は ⌘⇧M を拾わない
    expect(arrangeShortcutCommand(cmdShift("M"), null)).toBeNull();
    expect(undoShortcutCommand(cmdShift("M"), null)).toBeNull();
    expect(isCopyShortcut(cmdShift("M"))).toBe(false);
  });
});

describe("isCancelMaskKey(Esc でやめる、FR-012)", () => {
  const image = makeImage();
  const review: MaskSessionState = { status: "review", token: 1, image, candidates: [] };

  it("確認中の Esc だけを受け付ける", () => {
    expect(isCancelMaskKey(key("Escape"), null, review)).toBe(true);
    expect(isCancelMaskKey(key("Escape"), null, { status: "idle" })).toBe(false);
    // 読み取りの中断は作らない(UI 仕様 §2)
    expect(isCancelMaskKey(key("Escape"), null, { status: "scanning", token: 1, image })).toBe(false);
  });

  it("修飾キー付き・IME 変換中・入力欄・他のキーは対象外", () => {
    expect(isCancelMaskKey(key("Escape", { metaKey: true }), null, review)).toBe(false);
    expect(isCancelMaskKey(key("Escape", { isComposing: true }), null, review)).toBe(false);
    expect(isCancelMaskKey(key("Escape"), { tagName: "TEXTAREA" }, review)).toBe(false);
    expect(isCancelMaskKey(key("Enter"), null, review)).toBe(false);
  });
});

describe("toMaskCandidateInputs(結果の矩形の再クランプ、ARCH §7.2)", () => {
  it("画像の幅・高さで収め、種類と矩形の数値だけを写す", () => {
    const scanned: ScannedCandidate[] = [
      { x: 190, y: 95, width: 30, height: 20, kind: "financial" },
      { x: 0, y: 0, width: 10, height: 10, kind: "identifier" },
    ];
    expect(toMaskCandidateInputs(scanned, { width: 200, height: 100 })).toEqual([
      { rect: { x: 190, y: 95, width: 10, height: 5 }, kind: "financial" },
      { rect: { x: 0, y: 0, width: 10, height: 10 }, kind: "identifier" },
    ]);
  });

  it("画像の外に出て面積が 0 になる候補は捨てる", () => {
    const scanned: ScannedCandidate[] = [
      { x: 250, y: 10, width: 20, height: 20, kind: "contact" },
      { x: 10, y: 100, width: 20, height: 20, kind: "contact" },
    ];
    expect(toMaskCandidateInputs(scanned, { width: 200, height: 100 })).toEqual([]);
  });
});

describe("文言(UI_auto-masking §5.2、NFR-005)", () => {
  it("件数の文は外した件数の有無で出し分ける", () => {
    expect(resultStatusText(7, 0)).toBe("候補 7 件");
    expect(resultStatusText(7, 2)).toBe("候補 7 件(うち 2 件を外しています)");
  });

  it("確定文言どおり", () => {
    expect(AUTO_MASK_MESSAGES.buttonLabel).toBe("機密らしい箇所を探す(⌘⇧M)");
    expect(AUTO_MASK_MESSAGES.scanning).toBe("機密らしい箇所を探しています…");
    expect(AUTO_MASK_MESSAGES.resultHint).toBe(
      "印をクリックすると外せます。見落としがないか目でも確かめてください。",
    );
    expect(AUTO_MASK_MESSAGES.empty).toBe("候補は見つかりませんでした。");
    expect(AUTO_MASK_MESSAGES.emptyHint).toBe("貼る前に画像を目で確かめてください。");
    expect(AUTO_MASK_MESSAGES.cancel).toBe("やめる");
    expect(AUTO_MASK_MESSAGES.apply).toBe("まとめてモザイク");
    expect(AUTO_MASK_MESSAGES.close).toBe("閉じる");
    expect(AUTO_MASK_MESSAGES.failed).toBe("文字を読み取れませんでした。画像は変更していません。");
    expect(AUTO_MASK_MESSAGES.applied(3)).toBe("候補 3 件にモザイクをかけました。⌘Z で戻せます。");
  });

  it("0 件・失敗を含むすべての文言に禁止語を含まない", () => {
    const texts: string[] = [
      ...Object.values(AUTO_MASK_MESSAGES).filter((v) => typeof v === "string"),
      AUTO_MASK_MESSAGES.applied(0),
      AUTO_MASK_MESSAGES.applied(12),
      resultStatusText(0, 0),
      resultStatusText(5, 5),
    ];
    for (const text of texts) {
      for (const word of FORBIDDEN_WORDS) {
        expect(text.includes(word), `禁止語「${word}」`).toBe(false);
      }
    }
  });
});

describe("canApplyMosaic(残り 0 件では押せない、FR-011)", () => {
  const image = makeImage();
  const cand = (id: number, excluded: boolean) => ({
    id,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    kind: "contact" as const,
    excluded,
  });

  it("確認中で外していない候補が 1 件以上あるときだけ押せる", () => {
    expect(canApplyMosaic({ status: "review", token: 1, image, candidates: [cand(0, false), cand(1, true)] })).toBe(true);
    expect(canApplyMosaic({ status: "review", token: 1, image, candidates: [cand(0, true)] })).toBe(false);
    expect(canApplyMosaic({ status: "review", token: 1, image, candidates: [] })).toBe(false);
    expect(canApplyMosaic({ status: "idle" })).toBe(false);
  });
});

describe("maskBarView(結果バーの表示、UI 仕様 §2・§3)", () => {
  const image = makeImage();
  const cand = (id: number, excluded: boolean) => ({
    id,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    kind: "contact" as const,
    excluded,
  });

  it("idle では隠す", () => {
    expect(maskBarView({ status: "idle" }).hidden).toBe(true);
  });

  it("処理中は回転するリングと文言だけ(ボタンなし)", () => {
    expect(maskBarView({ status: "scanning", token: 1, image })).toEqual({
      hidden: false,
      busy: true,
      status: "機密らしい箇所を探しています…",
      hint: "",
      dismissLabel: null,
      showApply: false,
      applyEnabled: false,
    });
  });

  it("候補ありは件数・補足・やめる・まとめてモザイク", () => {
    const view = maskBarView({ status: "review", token: 1, image, candidates: [cand(0, false), cand(1, true)] });
    expect(view).toEqual({
      hidden: false,
      busy: false,
      status: "候補 2 件(うち 1 件を外しています)",
      hint: AUTO_MASK_MESSAGES.resultHint,
      dismissLabel: "やめる",
      showApply: true,
      applyEnabled: true,
    });
  });

  it("全件を外すとまとめてモザイクは押せない", () => {
    const view = maskBarView({ status: "review", token: 1, image, candidates: [cand(0, true)] });
    expect(view.showApply).toBe(true);
    expect(view.applyEnabled).toBe(false);
  });

  it("0 件は文言と「閉じる」1 つ", () => {
    expect(maskBarView({ status: "review", token: 1, image, candidates: [] })).toEqual({
      hidden: false,
      busy: false,
      status: "候補は見つかりませんでした。",
      hint: "貼る前に画像を目で確かめてください。",
      dismissLabel: "閉じる",
      showApply: false,
      applyEnabled: false,
    });
  });
});

describe("createAutoMaskController(ARCH §7.1 の手順)", () => {
  it("入力中のテキストを確定してからベースを書き出し、結果を再クランプして review へ", async () => {
    const h = makeHarness(async () => [
      ...SCANNED,
      { x: 190, y: 90, width: 50, height: 50, kind: "financial" },
    ]);
    const controller = createAutoMaskController(h.deps);
    await controller.start();

    expect(h.calls).toEqual(["commit", "deselect", "export", "scan"]);
    const session = getMaskSession();
    expect(session.status).toBe("review");
    if (session.status !== "review") return;
    expect(session.candidates.map((c) => ({ rect: c.rect, kind: c.kind }))).toEqual([
      { rect: { x: 10, y: 20, width: 30, height: 12 }, kind: "contact" },
      { rect: { x: 50, y: 60, width: 40, height: 10 }, kind: "credential" },
      { rect: { x: 190, y: 90, width: 10, height: 10 }, kind: "financial" },
    ]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("画像が無いときは何もしない", async () => {
    const h = makeHarness();
    h.image.current = null;
    await createAutoMaskController(h.deps).start();
    expect(h.calls).toEqual([]);
    expect(getMaskSession().status).toBe("idle");
  });

  it("処理中の再押下では invoke を 1 回しか送らない", async () => {
    const pending = deferred<ScannedCandidate[]>();
    const h = makeHarness(() => pending.promise);
    const controller = createAutoMaskController(h.deps);
    const first = controller.start();
    await flush();
    await controller.start();
    await controller.start();
    expect(h.scan).toHaveBeenCalledTimes(1);
    pending.resolve(SCANNED);
    await first;
    expect(getMaskSession().status).toBe("review");
    expect(h.scan).toHaveBeenCalledTimes(1);
  });

  it("前の実行が終わるまで次の invoke を送らない(画像を切り替えてすぐ押した場合)", async () => {
    const firstScan = deferred<ScannedCandidate[]>();
    let n = 0;
    const h = makeHarness(() => {
      n += 1;
      return n === 1 ? firstScan.promise : Promise.resolve(SCANNED);
    });
    const controller = createAutoMaskController(h.deps);
    const first = controller.start();
    await flush();
    expect(h.scan).toHaveBeenCalledTimes(1);

    // 画像の切替(main.ts が差し替える前に破棄する)→ 新しい画像ですぐ押す
    discardMaskSession();
    h.image.current = makeImage();
    const second = controller.start();
    await flush();
    expect(getMaskSession().status).toBe("scanning");
    expect(h.scan).toHaveBeenCalledTimes(1); // 前の invoke がまだ終わっていない

    firstScan.resolve(SCANNED);
    await first;
    await second;
    expect(h.scan).toHaveBeenCalledTimes(2);
    expect(getMaskSession().status).toBe("review");
  });

  it("前の実行が失敗しても次の実行は送られる", async () => {
    const firstScan = deferred<ScannedCandidate[]>();
    let n = 0;
    const h = makeHarness(() => {
      n += 1;
      return n === 1 ? firstScan.promise : Promise.resolve(SCANNED);
    });
    const controller = createAutoMaskController(h.deps);
    const first = controller.start();
    await flush();
    discardMaskSession();
    h.image.current = makeImage();
    const second = controller.start();
    firstScan.reject(new TextScanError("failed"));
    await first;
    await second;
    expect(h.scan).toHaveBeenCalledTimes(2);
    expect(getMaskSession().status).toBe("review");
    // 古い実行の失敗は知らせない(利用者はもう別の画像を見ている)
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("待っている間に破棄された実行は invoke を送らない", async () => {
    const firstScan = deferred<ScannedCandidate[]>();
    const h = makeHarness(() => firstScan.promise);
    const controller = createAutoMaskController(h.deps);
    const first = controller.start();
    await flush();
    discardMaskSession();
    h.image.current = makeImage();
    const second = controller.start();
    await flush();
    discardMaskSession(); // 2 回目も待っている間に画像を切り替えた
    firstScan.resolve(SCANNED);
    await first;
    await second;
    expect(h.scan).toHaveBeenCalledTimes(1);
    expect(getMaskSession().status).toBe("idle");
  });

  it("処理中に画像を切り替えたら古い結果を出さない", async () => {
    const pending = deferred<ScannedCandidate[]>();
    const h = makeHarness(() => pending.promise);
    const controller = createAutoMaskController(h.deps);
    const run = controller.start();
    await flush();
    discardMaskSession();
    h.image.current = makeImage();
    pending.resolve(SCANNED);
    await run;
    expect(getMaskSession().status).toBe("idle");
  });

  it.each([
    ["failed", new TextScanError("failed")],
    ["invalid_response", new TextScanError("invalid_response")],
    ["busy", new TextScanError("busy")],
    ["通信の例外", new Error("boom")],
  ])("失敗(%s)はエラーのトーストを出して idle に戻す", async (_label, error) => {
    const h = makeHarness(() => Promise.reject(error));
    await createAutoMaskController(h.deps).start();
    expect(getMaskSession().status).toBe("idle");
    expect(h.notify).toHaveBeenCalledWith(AUTO_MASK_MESSAGES.failed, "error");
    expect(h.applyBaseEdits).not.toHaveBeenCalled();
  });

  it("0 件でも review に入り、結果バーで知らせる(トーストは出さない)", async () => {
    const h = makeHarness(async () => []);
    await createAutoMaskController(h.deps).start();
    const session = getMaskSession();
    expect(session.status).toBe("review");
    expect(maskBarView(session).status).toBe(AUTO_MASK_MESSAGES.empty);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("まとめてモザイクは外していない候補の矩形を 1 回で渡し、idle に戻してトースト", async () => {
    const h = makeHarness();
    const controller = createAutoMaskController(h.deps);
    await controller.start();
    toggleCandidate(0);
    controller.applyMosaic();
    expect(h.applyBaseEdits).toHaveBeenCalledTimes(1);
    expect(h.applyBaseEdits.mock.calls[0][0]).toEqual([{ x: 50, y: 60, width: 40, height: 10 }]);
    expect(getMaskSession().status).toBe("idle");
    expect(h.notify).toHaveBeenCalledWith("候補 1 件にモザイクをかけました。⌘Z で戻せます。", "info");
  });

  it("残り 0 件ではまとめてモザイクしない", async () => {
    const h = makeHarness();
    const controller = createAutoMaskController(h.deps);
    await controller.start();
    toggleCandidate(0);
    toggleCandidate(1);
    controller.applyMosaic();
    expect(h.applyBaseEdits).not.toHaveBeenCalled();
    expect(getMaskSession().status).toBe("review");
  });

  it("確認中でなければまとめてモザイクしない", () => {
    const h = makeHarness();
    createAutoMaskController(h.deps).applyMosaic();
    expect(h.applyBaseEdits).not.toHaveBeenCalled();
  });

  it("やめるは候補を捨てて idle に戻す(トーストなし)", () => {
    const h = makeHarness();
    const image = makeImage();
    const token = beginScan(image);
    acceptScanResult(token!, image, [{ rect: { x: 0, y: 0, width: 5, height: 5 }, kind: "contact" }]);
    createAutoMaskController(h.deps).cancel();
    expect(getMaskSession().status).toBe("idle");
    expect(h.notify).not.toHaveBeenCalled();
  });
});

// AM-T25-F1: 画像の差し替えの途中に始めた場合・処理中/確認中の制限(レビュー指摘)。
describe("画像の差し替えとの競合(AM-T25-F1 MUST-1)", () => {
  it("処理中に画像が差し替わってから結果が届くと、捨てて idle に戻る(処理中のまま残らない)", async () => {
    const pending = deferred<ScannedCandidate[]>();
    const h = makeHarness(() => pending.promise);
    const run = createAutoMaskController(h.deps).start();
    await flush();
    // `discardMaskSession()` を経ずに画像だけが変わった(差し替えの隙間に始めた)場合
    h.image.current = makeImage();
    pending.resolve(SCANNED);
    await run;
    expect(getMaskSession().status).toBe("idle");
    // 古い画像の結果なので失敗としては知らせない
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("古い token の結果が届いても、今の処理は止めない", async () => {
    const first = deferred<ScannedCandidate[]>();
    const h = makeHarness(() => first.promise);
    const controller = createAutoMaskController(h.deps);
    const run = controller.start();
    await flush();
    // 破棄 → 同じ画像で次の処理を始めた(古い結果が後から届く)
    discardMaskSession();
    const image = h.image.current!;
    const token = beginScan(image);
    first.resolve(SCANNED);
    await run;
    const session = getMaskSession();
    expect(session.status).toBe("scanning");
    expect(session.status === "scanning" && session.token).toBe(token);
  });
});

describe("bindMaskSessionToCanvasImage(表示中の画像が変わったら候補を捨てる、AM-T25-F1 MUST-1)", () => {
  let unbind: () => void = () => {};

  beforeEach(() => {
    clearCanvasImage();
    setDrawing(false);
    unbind = bindMaskSessionToCanvasImage();
  });

  afterEach(() => {
    unbind();
    clearCanvasImage();
    setActiveTool(null);
  });

  /** 表示中の画像で `review` まで進める。 */
  function reviewOnCurrentImage(): void {
    const image = getCanvasState().image!;
    const token = beginScan(image);
    expect(acceptScanResult(token!, image, [{ rect: { x: 0, y: 0, width: 5, height: 5 }, kind: "contact" }])).toBe(
      true,
    );
  }

  it("確認中に画像が差し替わると破棄する(古い印を新しい画像に残さない)", () => {
    setCanvasImage(makeImage());
    reviewOnCurrentImage();
    setCanvasImage(makeImage());
    expect(getMaskSession().status).toBe("idle");
  });

  it("処理中に画像が差し替わると破棄する", () => {
    setCanvasImage(makeImage());
    beginScan(getCanvasState().image!);
    setCanvasImage(makeImage());
    expect(getMaskSession().status).toBe("idle");
  });

  it("画像が消えたときも破棄する", () => {
    setCanvasImage(makeImage());
    reviewOnCurrentImage();
    clearCanvasImage();
    expect(getMaskSession().status).toBe("idle");
  });

  it("画像が同じままの変化(ツールの切替など)では破棄しない", () => {
    setCanvasImage(makeImage());
    reviewOnCurrentImage();
    setActiveTool("arrow");
    expect(getMaskSession().status).toBe("review");
  });

  it("解除後は購読しない", () => {
    setCanvasImage(makeImage());
    reviewOnCurrentImage();
    unbind();
    setCanvasImage(makeImage());
    expect(getMaskSession().status).toBe("review");
    discardMaskSession();
  });
});

describe("開始時の制限(AM-T25-F1 SHOULD-1・SHOULD-2)", () => {
  it("開始時に選択を外す(ベースを書き出す前)", async () => {
    const h = makeHarness();
    await createAutoMaskController(h.deps).start();
    expect(h.calls.indexOf("deselect")).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf("deselect")).toBeLessThan(h.calls.indexOf("export"));
  });

  it("開始できないとき(画像なし・処理中)は選択を外さない", async () => {
    const h = makeHarness();
    h.image.current = null;
    await createAutoMaskController(h.deps).start();
    expect(h.calls).not.toContain("deselect");
  });

  it("ドラッグ中は開始しない", async () => {
    const h = makeHarness();
    h.drawing.current = true;
    await createAutoMaskController(h.deps).start();
    expect(h.calls).toEqual([]);
    expect(getMaskSession().status).toBe("idle");
  });
});

describe("まとめてモザイクの結果の知らせ(AM-T25-F1 C-1)", () => {
  it("実際に適用した件数をトーストに出す", async () => {
    const h = makeHarness();
    h.applyBaseEdits.mockImplementation(() => 1);
    const controller = createAutoMaskController(h.deps);
    await controller.start();
    controller.applyMosaic();
    expect(h.notify).toHaveBeenCalledWith(AUTO_MASK_MESSAGES.applied(1), "info");
    expect(getMaskSession().status).toBe("idle");
  });

  it("1 件も適用できなければ失敗のトーストを出す(完了のトーストは出さない)", async () => {
    const h = makeHarness();
    h.applyBaseEdits.mockImplementation(() => 0);
    const controller = createAutoMaskController(h.deps);
    await controller.start();
    controller.applyMosaic();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(AUTO_MASK_MESSAGES.failed, "error");
    expect(getMaskSession().status).toBe("idle");
  });
});
