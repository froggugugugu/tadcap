//! 画像描画(ARCH §3.1 フロントエンド Canvas 層、§4 `src/canvas/render.ts`)。
//!
//! T07時点ではキャプチャ画像をCanvasへ原寸描画するところまでを担う。
//! T12でクリップボードコピー用の最終画像抽出(`getCanvasImageData()`)を追加した
//! (ARCH §5.2は `toBlob('image/png')` によるPNGバイト列抽出を想定していたが、
//! Rustフォールバック(`arboard`)が生RGBA8を要求するため `getImageData()` に変更
//! した。詳細は `src/ipc/clipboard.ts` のモジュールdoc・project-config.md §11参照)。
//! T14でセッション内履歴保存用の抽出(`captureHistoryAssets()`、`toBlob('image/png')`
//! + `URL.createObjectURL()`)を追加した(`src/history/historyStore.ts`が呼ぶ、
//! ARCH §3.1「履歴層はcanvas層(編集後画像の取得)に依存可能」)。
//!
//! ブラウザのDOM/Canvas APIに直接依存するため、Vitestの既定環境(Node、DOM無し)
//! では自動テストできない(project-config.md §11参照)。目視確認は手動確認
//! チェックリスト#1に回す(T07仕様)。

/**
 * URLから `HTMLImageElement` を読み込む。
 *
 * 渡すURLは同一オリジン扱いのObjectURL(`blob:`)に限る。別オリジンの画像(asset URL等)を
 * `crossOrigin` 無しで読むとCanvasが汚染され、`getImageData()`/`toBlob()` が
 * `SecurityError` になる(実機不具合②〜⑤)。
 */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`画像の読み込みに失敗した: ${src}`));
    image.src = src;
  });
}

/**
 * Canvasのサイズを画像の原寸(`naturalWidth`/`naturalHeight`)に合わせ、
 * 画像を描画する。
 */
export function renderImageToCanvas(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
): void {
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D描画コンテキストの取得に失敗した");
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
}

/**
 * Canvasの現在ピクセル(矢印・モザイク焼き込み済みの最終画像)をRGBA8(行優先)で
 * 取得する(クリップボードコピー用、T12、`src/ipc/clipboard.ts::ClipboardImagePayload`)。
 *
 * `ImageData.data` は `Uint8ClampedArray` だが、値はいずれも0-255のバイトであり
 * `Uint8Array` と同じ裏付け(`ArrayBuffer`)を指すビューを作るだけでよいため、
 * コピーせずそのまま `Uint8Array` として再解釈する。
 *
 * ブラウザのDOM/Canvas APIに直接依存するため、Vitestの既定環境(Node、DOM無し)
 * では自動テスト対象外とする(上記モジュールdoc参照)。
 */
export function getCanvasImageData(canvas: HTMLCanvasElement): {
  rgba: Uint8Array;
  width: number;
  height: number;
} {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D描画コンテキストの取得に失敗した");
  }
  const { data, width, height } = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return { rgba, width, height };
}

/** `canvas`をPNG化しObjectURLを返す(内部ヘルパー、T14)。 */
function canvasToObjectUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("CanvasのPNG化に失敗した"));
        return;
      }
      resolve(URL.createObjectURL(blob));
    }, "image/png");
  });
}

/**
 * `source`を`maxSize`(px、長辺基準)以内に収まるよう縮小した新しいCanvasを返す
 * (アスペクト比維持、内部ヘルパー、T14)。`source`が既に`maxSize`以下ならば
 * 等倍のまま複製する(拡大はしない)。
 */
function createScaledCanvas(
  source: HTMLCanvasElement,
  maxSize: number,
): HTMLCanvasElement {
  const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const scaled = document.createElement("canvas");
  scaled.width = width;
  scaled.height = height;
  const ctx = scaled.getContext("2d");
  if (!ctx) {
    throw new Error("2D描画コンテキストの取得に失敗した");
  }
  ctx.drawImage(source, 0, 0, width, height);
  return scaled;
}

/**
 * Canvasの現在ピクセル(矢印・モザイク焼き込み済みの最終画像)から、セッション内履歴
 * 保存用の`image`(編集後画像、原寸PNG)・`thumbnail`(縮小PNG、長辺`thumbnailMaxSize`px
 * 以内)をそれぞれObjectURLとして抽出する(T14、FR-010、`src/history/historyStore.ts`
 * の`HistoryItem.image`/`HistoryItem.thumbnail`用)。
 *
 * 戻り値のURLは`URL.createObjectURL()`が生成するため、不要になった時点で呼び出し元
 * (`src/history/historyStore.ts`)が`URL.revokeObjectURL()`を呼ぶ責務を持つ(本関数は
 * URLの生成のみを担う)。
 *
 * ブラウザのDOM/Canvas APIに直接依存するため、Vitestの既定環境(Node、DOM無し)では
 * 自動テスト対象外とする(手動確認チェックリストへ回す。project-config.md §11参照)。
 */
export async function captureHistoryAssets(
  canvas: HTMLCanvasElement,
  thumbnailMaxSize = 160,
): Promise<{ image: string; thumbnail: string }> {
  const [image, thumbnail] = await Promise.all([
    canvasToObjectUrl(canvas),
    canvasToObjectUrl(createScaledCanvas(canvas, thumbnailMaxSize)),
  ]);
  return { image, thumbnail };
}
