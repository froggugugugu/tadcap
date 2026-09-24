//! クリップボード書込(プラグイン優先→Rustフォールバック)の薄いラッパー
//! (ARCH §3.1 フロントエンド IPC 層、§4 `src/ipc/clipboard.ts`、FR-005、T12)。
//!
//! `src/ipc/` は Tauri API(`@tauri-apps/api` とそのプラグイン)以外に依存しない
//! (ARCH §3.2 依存方向ルール)。
//!
//! # RGBA8を主経路・フォールバック双方の共通ペイロードにした理由(ARCH §5.2からの変更点)
//!
//! ARCH §5.2は `copyToClipboard(pngBytes)`(PNGバイト列)と記述しているが、実装時に
//! 次の技術的制約が判明したため、Canvasの `getImageData()` 由来の生RGBA8ピクセル列
//! (`width`/`height`込み)を渡す設計に変更した(【仮定】、T12実装報告でPJM/ARCH責務者
//! へ申し送り):
//!
//! - Rustフォールバック(`arboard::Clipboard::set_image`)はPNGを直接受け付けず、
//!   生のRGBA8ピクセル列(`arboard::ImageData { width, height, bytes }`)を要求する
//!   (docs.rs確認済み)。PNGバイト列のままフォールバックへ渡すには、Rust側でPNGを
//!   デコードする追加クレート(`image`/`png`等)が必要になるが、これはARCH §2・§15
//!   決定#3が承認した追加依存(`arboard` のみ)の範囲外になる
//! - `@tauri-apps/plugin-clipboard-manager` の `writeImage()` にUint8Array/ArrayBuffer
//!   を直接渡すと「PNG/ICOの生バイト列」として解釈され(`tauri`公式パッケージの
//!   `JsImage::Bytes`)、デコードに `tauri` クレートの `image-png` Cargo feature(=
//!   `image` クレートの追加取込)が必要になる。一方 `@tauri-apps/api/image` の
//!   `Image.new(rgba, width, height)` は生RGBA8を直接受け付け「追加Cargo feature不要」
//!   と公式ドキュメントに明記されている
//!
//! 以上より、Canvasから一度だけ抽出したRGBA8(`canvas/render.ts::getCanvasImageData()`)
//! を主経路(`Image.new()` 経由の `writeImage()`)・フォールバック双方でそのまま使う
//! 設計にした。PNGエンコード/デコードの往復が発生せず、追加のCargoクレート・feature
//! も不要になる(NFR-003)。
//!
//! # フォールバックの転送方式(IPC転送コスト対応)
//!
//! フォールバックは通常の(JSONシリアライズされる)オブジェクト引数ではなく、
//! `invoke()` の生ボディ渡し(`Uint8Array` をpayload引数に直接渡す。公式ドキュメント
//! <https://v2.tauri.app/develop/calling-rust/#accessing-raw-request>)を使う。
//! オブジェクトの1フィールドとしてRGBAを渡すと要素ごとにカンマ区切りの10進数
//! 文字列(JSON配列)へ展開され、5K Retina全画面相当(数千万バイト)では数十MBの
//! 文字列に膨らみうるため、生ボディで送る(`width`/`height` はヘッダーで渡す)。

import { invoke } from "@tauri-apps/api/core";
import { Image } from "@tauri-apps/api/image";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";

/** Canvasの最終画像(RGBA8、行優先)。`canvas/render.ts::getCanvasImageData()` が生成する。 */
export interface ClipboardImagePayload {
  rgba: Uint8Array;
  width: number;
  height: number;
}

/** どちらの経路でクリップボードへ書き込めたかを表す(フィードバック文言の出し分けに使う、T12)。 */
export type ClipboardCopyMethod = "plugin" | "fallback";

/** Rustフォールバックコマンド名(`src-tauri/src/commands.rs::write_image_fallback` と一致させる)。 */
export const WRITE_IMAGE_FALLBACK_COMMAND = "write_image_fallback";

/**
 * フォールバックコマンドが画像サイズを受け取るヘッダー名
 * (Rust側 `commands.rs::IMAGE_WIDTH_HEADER`/`IMAGE_HEIGHT_HEADER` と一致させる)。
 */
export const IMAGE_WIDTH_HEADER = "x-tadcap-image-width";
export const IMAGE_HEIGHT_HEADER = "x-tadcap-image-height";

/**
 * プラグイン経由・Rustフォールバックの両方が失敗した場合にrejectされるエラー。
 * 両方のエラーを保持し、呼び出し元(`ui/clipboardButton.ts`)が必要なら詳細を
 * 参照できるようにする(UI表示自体は短い失敗フィードバックのみ、T12仕様)。
 */
export class ClipboardCopyError extends Error {
  constructor(
    public readonly pluginError: unknown,
    public readonly fallbackError: unknown,
  ) {
    super("クリップボードへのコピーに失敗しました(プラグイン・フォールバックともに失敗)");
    this.name = "ClipboardCopyError";
  }
}

/**
 * Canvasの最終画像をクリップボードへコピーする。
 *
 * まず `@tauri-apps/plugin-clipboard-manager` の `writeImage()`(主経路)を試行し、
 * 失敗した場合のみRustフォールバックコマンド({@link WRITE_IMAGE_FALLBACK_COMMAND})
 * へ切り替える(FR-005、ARCH §7.1手順7)。両方失敗した場合は {@link ClipboardCopyError}
 * をrejectする。
 */
export async function copyToClipboard(
  payload: ClipboardImagePayload,
): Promise<ClipboardCopyMethod> {
  try {
    await writeViaPlugin(payload);
    return "plugin";
  } catch (pluginError) {
    try {
      await writeViaFallback(payload);
      return "fallback";
    } catch (fallbackError) {
      throw new ClipboardCopyError(pluginError, fallbackError);
    }
  }
}

/**
 * 主経路: `Image.new(rgba, width, height)` でリソースを作成し `writeImage()` へ渡す。
 * `Image` はRustリソーステーブルを消費するため、使用後は必ず `close()` する。
 */
async function writeViaPlugin(payload: ClipboardImagePayload): Promise<void> {
  const image = await Image.new(payload.rgba, payload.width, payload.height);
  try {
    await writeImage(image);
  } finally {
    await image.close();
  }
}

/** フォールバック経路: 生ボディ + ヘッダーでRustコマンドを呼ぶ(上記モジュール doc 参照)。 */
async function writeViaFallback(payload: ClipboardImagePayload): Promise<void> {
  await invoke(WRITE_IMAGE_FALLBACK_COMMAND, payload.rgba, {
    headers: {
      [IMAGE_WIDTH_HEADER]: String(payload.width),
      [IMAGE_HEIGHT_HEADER]: String(payload.height),
    },
  });
}
