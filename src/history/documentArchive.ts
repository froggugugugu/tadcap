//! 履歴項目ごとのドキュメント退避(T34【新設 2026-09-25】、PRD FR-010改訂、ARCH §5.2 T34・§6.4)。
//!
//! 別の画像(新規キャプチャ・履歴の別項目)へ切り替える直前に、表示中の項目のドキュメント
//! (ベースのPNG + オブジェクト配列 + 次のid + 取り消しスタック)を履歴idで退避し、その項目へ
//! 戻ったときに復元する(`main.ts`)。これにより戻った後もオブジェクトを再調整・取り消しできる。
//! サムネイル・履歴画像(`HistoryItem.image`)は従来どおり合成結果。
//!
//! # メモリ(【設計判断】)
//!
//! - ベースは`ImageBitmap`や`ImageData`ではなくPNGの`Blob`で持つ。5K(5120x2880)のRGBAは1枚約59MBで、
//!   履歴50件(`HISTORY_LIMIT`)ぶん展開したまま持つと約2.9GBになるため。PNGはスクリーンショットでは
//!   数MB程度に縮む。ベースを変えていなければ読み込み時のPNGを再エンコードせずに使う(`documentSurface.ts`)。
//! - 取り消しスタックのピクセル(モザイク・上限超過の焼き込み)は、退避時に合計
//!   [`ARCHIVED_UNDO_BYTES_LIMIT`]へ収める(古い取り消しから捨てる。捨てた操作は取り消せなくなるだけで、
//!   結果はベース・オブジェクトに残る)。オブジェクトの追加・変更・削除・重ね順はピクセルを持たないため
//!   ほぼ無料で残る。
//! - 履歴の上限超過で消えた項目の退避は`deleteArchivedDocument()`で消す(`main.ts`)。

import type { DocumentCommand } from "../canvas/commands";
import type { DocumentSnapshot } from "../canvas/documentState";
import type { UndoStackState } from "../canvas/undoStack";

/** 退避する1項目の取り消しスタックが持てるピクセルの合計(バイト)。 */
export const ARCHIVED_UNDO_BYTES_LIMIT = 8 * 1024 * 1024;

export interface ArchivedDocument {
  /** ベース(元画像+焼き込み済みの加工)のPNG。 */
  base: Blob;
  snapshot: DocumentSnapshot;
}

/** コマンドが持つピクセルのバイト数(`pixels`・`flatten`、`group`は中身の合計)。 */
export function commandPixelBytes(command: DocumentCommand): number {
  switch (command.type) {
    case "pixels":
    case "flatten":
      return command.image.data.byteLength;
    case "group":
      return command.commands.reduce((sum, child) => sum + commandPixelBytes(child), 0);
    default:
      return 0;
  }
}

/**
 * 取り消しスタックのピクセルの合計を`maxBytes`以下にする。最も古い取り消しから、次に最も遠い
 * やり直しから、連続して捨てる(途中だけ抜くと、残った操作を戻す順序が壊れるため)。
 */
export function trimUndoToBudget(state: UndoStackState, maxBytes: number): UndoStackState {
  const total = (list: DocumentCommand[]) => list.reduce((sum, c) => sum + commandPixelBytes(c), 0);
  let undo = state.undo;
  let redo = state.redo;
  if (total(undo) + total(redo) <= maxBytes) {
    return state;
  }
  while (undo.length > 0 && total(undo) + total(redo) > maxBytes) {
    undo = undo.slice(1);
  }
  while (redo.length > 0 && total(undo) + total(redo) > maxBytes) {
    redo = redo.slice(1);
  }
  return { undo, redo };
}

const archive = new Map<string, ArchivedDocument>();

/** 履歴id`id`の項目のドキュメントを退避する(取り消しスタックは上限に収めてから持つ)。 */
export function saveArchivedDocument(id: string, doc: ArchivedDocument): void {
  const undo = trimUndoToBudget(doc.snapshot.undo, ARCHIVED_UNDO_BYTES_LIMIT);
  archive.set(id, { base: doc.base, snapshot: { ...doc.snapshot, undo } });
}

export function getArchivedDocument(id: string): ArchivedDocument | undefined {
  return archive.get(id);
}

export function deleteArchivedDocument(id: string): void {
  archive.delete(id);
}

export function clearArchivedDocuments(): void {
  archive.clear();
}
