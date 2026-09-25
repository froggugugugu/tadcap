import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TOAST_DURATION_MS,
  TOAST_FADE_MS,
  TOAST_LEAVING_CLASS,
  clearToast,
  showToast,
  toastDurationMs,
  type ToastTarget,
} from "./toast";

/** DOM無し(Node)でも動く最小のトースト要素。 */
function makeTarget(): ToastTarget & { classes: Set<string> } {
  const classes = new Set<string>();
  return {
    textContent: "",
    classes,
    classList: {
      add: (name: string) => void classes.add(name),
      remove: (name: string) => void classes.delete(name),
    },
  };
}

describe("toastDurationMs(表示時間、定数1か所)", () => {
  it("成功・情報は約2.5秒、エラーは約5秒", () => {
    expect(toastDurationMs("info")).toBe(2500);
    expect(toastDurationMs("error")).toBe(5000);
    expect(TOAST_DURATION_MS).toEqual({ info: 2500, error: 5000 });
  });
});

describe("showToast / clearToast(自動消去)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("表示時間が過ぎるとフェードしてから消える", () => {
    const el = makeTarget();
    showToast(el, "クリップボードにコピーしました。", "info", { reducedMotion: false });
    expect(el.textContent).toBe("クリップボードにコピーしました。");

    vi.advanceTimersByTime(2499);
    expect(el.textContent).toBe("クリップボードにコピーしました。");
    expect(el.classes.has(TOAST_LEAVING_CLASS)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(el.classes.has(TOAST_LEAVING_CLASS)).toBe(true);
    expect(el.textContent).toBe("クリップボードにコピーしました。");

    vi.advanceTimersByTime(TOAST_FADE_MS);
    expect(el.textContent).toBe("");
    expect(el.classes.has(TOAST_LEAVING_CLASS)).toBe(false);
  });

  it("エラーは5秒表示する", () => {
    const el = makeTarget();
    showToast(el, "コピーに失敗しました。", "error", { reducedMotion: true });
    vi.advanceTimersByTime(4999);
    expect(el.textContent).toBe("コピーに失敗しました。");
    vi.advanceTimersByTime(1);
    expect(el.textContent).toBe("");
  });

  it("新しいメッセージが来たらタイマーをやり直す(フェード中でも)", () => {
    const el = makeTarget();
    showToast(el, "1回目", "info", { reducedMotion: false });
    vi.advanceTimersByTime(2500 + TOAST_FADE_MS / 2);
    expect(el.classes.has(TOAST_LEAVING_CLASS)).toBe(true);

    showToast(el, "2回目", "info", { reducedMotion: false });
    expect(el.classes.has(TOAST_LEAVING_CLASS)).toBe(false);
    vi.advanceTimersByTime(2499);
    expect(el.textContent).toBe("2回目");
    vi.advanceTimersByTime(1 + TOAST_FADE_MS);
    expect(el.textContent).toBe("");
  });

  it("prefers-reduced-motionではフェードせず表示時間ちょうどで消える", () => {
    const el = makeTarget();
    showToast(el, "情報", "info", { reducedMotion: true });
    vi.advanceTimersByTime(2500);
    expect(el.textContent).toBe("");
    expect(el.classes.has(TOAST_LEAVING_CLASS)).toBe(false);
  });

  it("clearToastは即座に消し、予約済みのタイマーも取り消す", () => {
    const el = makeTarget();
    showToast(el, "情報", "info", { reducedMotion: false });
    clearToast(el);
    expect(el.textContent).toBe("");
    el.textContent = "別経路で書かれた文言";
    vi.advanceTimersByTime(10_000);
    expect(el.textContent).toBe("別経路で書かれた文言");
  });

  it("空文字のメッセージはclearToastと同じ", () => {
    const el = makeTarget();
    showToast(el, "情報", "info", { reducedMotion: false });
    showToast(el, "", "info", { reducedMotion: false });
    expect(el.textContent).toBe("");
    vi.advanceTimersByTime(10_000);
    expect(el.textContent).toBe("");
  });
});
