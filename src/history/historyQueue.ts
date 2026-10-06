//! 履歴を読み書きする非同期処理の直列化キュー(v0.2.2後、レビュー 2026-10-07)。
//!
//! 履歴のクリック・削除(`ui/sidebar.ts`)とキャプチャ完了の取り込み(`main.ts::handleCaptureCompleted`)は、
//! どれも「選択中の項目を読む → `await` を挟む → 選択中の項目へ書く・退避する」という形をしている。
//! 並行に走ると、待っている間に選択が変わり、別の項目へ画像を上書きしたり、消えた項目の退避を残したり
//! する(MUST-2、レビュー 2026-09-24 と同じ型の競合)。そこで全処理を1本のPromiseチェーンに並べ、
//! 前の処理が完全に終わってから次を始める。

let queue: Promise<void> = Promise.resolve();

/**
 * `task`をキューの末尾に積む。戻り値は`task`自身の成否を伝える。`task`が失敗してもキューは
 * 止めない(後続の処理は進める)。
 */
export function enqueueHistoryTask(task: () => Promise<void>): Promise<void> {
  const next = queue.then(task);
  queue = next.catch(() => {
    // 直列化のためのチェーンは失敗しても止めない。呼び出し元へのエラー伝播は`next`が担う。
  });
  return next;
}
