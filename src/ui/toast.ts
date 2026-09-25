//! 右下のトースト(`#capture-status` / `#clipboard-status`、T19)の自動消去(v0.2.0後の人間フィードバック)。
//!
//! 文言は数秒後に自動で消える。新しい文言が来たらタイマーをやり直す。`prefers-reduced-motion`
//! ではフェードせずに消す。要素は`role="status"`(aria-live=polite)のまま使うため、
//! スクリーンリーダーへの読み上げは従来どおり(消えるときは空文字になるだけで読み上げは発生しない)。
//! 権限の案内バナー(`permissionBanner.ts`)は操作が必要な案内のため対象外(消さない)。
//!
//! DOM(`HTMLElement`)に依存せず`textContent`と`classList`だけを使うため、Nodeでもテストできる。

export type ToastKind = "info" | "error";

/**
 * 表示時間(ミリ秒)。成功・情報は一目で読める短い文言のため約2.5秒、エラーは読み直せるよう
 * 倍の約5秒にした(人間の要望の目安どおり)。
 */
export const TOAST_DURATION_MS: Readonly<Record<ToastKind, number>> = { info: 2500, error: 5000 };

/** フェードアウトの長さ(ミリ秒)。`styles.css`の`.toast--leaving`の`transition`と揃える。 */
export const TOAST_FADE_MS = 200;

/** フェードアウト中に付けるクラス。 */
export const TOAST_LEAVING_CLASS = "toast--leaving";

export interface ToastTarget {
  textContent: string | null;
  classList: { add(name: string): void; remove(name: string): void };
}

export interface ShowToastOptions {
  /** 省略時は`prefers-reduced-motion: reduce`を問い合わせる。 */
  reducedMotion?: boolean;
}

export function toastDurationMs(kind: ToastKind): number {
  return TOAST_DURATION_MS[kind];
}

const timers = new WeakMap<ToastTarget, ReturnType<typeof setTimeout>>();

function cancelTimer(el: ToastTarget): void {
  const timer = timers.get(el);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(el);
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** トーストを即座に消し、予約済みの自動消去も取り消す。 */
export function clearToast(el: ToastTarget): void {
  cancelTimer(el);
  el.classList.remove(TOAST_LEAVING_CLASS);
  el.textContent = "";
}

/**
 * トーストに`message`を出し、`kind`に応じた時間の後に消す。表示中・フェード中に呼ばれたら
 * 前のタイマーを捨ててやり直す。空文字は`clearToast()`と同じ。
 */
export function showToast(
  el: ToastTarget,
  message: string,
  kind: ToastKind,
  options: ShowToastOptions = {},
): void {
  clearToast(el);
  if (message === "") {
    return;
  }
  el.textContent = message;
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion();
  timers.set(
    el,
    setTimeout(() => {
      if (reducedMotion) {
        clearToast(el);
        return;
      }
      el.classList.add(TOAST_LEAVING_CLASS);
      timers.set(
        el,
        setTimeout(() => clearToast(el), TOAST_FADE_MS),
      );
    }, toastDurationMs(kind)),
  );
}
