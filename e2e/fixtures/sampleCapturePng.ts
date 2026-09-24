//! E2Eテスト用のキャプチャ画像フィクスチャ(T13、ARCH §10 決定#4)。
//!
//! `capture_screen` モック(`tauriMock.ts`)が返す `CaptureResult.sourcePath` を
//! `convertFileSrc()` 経由でPlaywrightの `page.route()` へ渡す際、実際にブラウザが
//! 読み込める画像バイト列が必要になる(Canvasへの描画・矢印/モザイクのピクセル変化検証のため)。
//! 依存追加なし(NFR-003)でPNGバイト列を生成するため、Node標準の `node:zlib` の
//! `deflateSync` のみを使い、PNG仕様(signature/IHDR/IDAT/IEND、CRC-32)を最小実装する。
//!
//! 画素パターンはチェッカーボード(`TILE_SIZE` px角、2色を交互配置)にしてある。
//! モザイクのブロックサイズ(`src/canvas/tools/mosaicTool.ts::mosaicBlockSize()`、
//! このフィクスチャの解像度では対角線が短く下限の12pxに固定される)より小さいタイルに
//! することで、ドラッグ選択したどの矩形でも「ブロック平均後は元の2色のどちらとも異なる
//! 混色になる」ことを保証し、モザイク適用前後のピクセル変化判定を壊れにくくしている。

import { deflateSync } from "node:zlib";

/** フィクスチャ画像の幅・高さ(px)。対角線 ≈360pxとなり、モザイクのブロックサイズが
 * 下限12pxに固定される値を選んでいる(`mosaicTool.ts::mosaicBlockSize()` 参照)。 */
export const FIXTURE_WIDTH = 300;
export const FIXTURE_HEIGHT = 200;

/** チェッカーボードのタイルサイズ(px)。モザイクのブロックサイズ(12px)の約数にして
 * どのブロックも複数タイルにまたがるようにする。 */
const TILE_SIZE = 6;

/** タイル色A(緑寄り)。矢印の既定色 `#FF5C8A`(255,92,138)と混同しない配色にしてある。 */
const COLOR_A: readonly [number, number, number, number] = [20, 180, 90, 255];
/** タイル色B(青寄り)。 */
const COLOR_B: readonly [number, number, number, number] = [30, 60, 200, 255];

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/** PNG仕様(CRC-32、ISO 3309/ITU-T V.42)。Node標準APIには公開関数が無いため実装する。 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const tableIndex = (crc ^ bytes[i]!) & 0xff;
    crc = CRC_TABLE[tableIndex]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, Buffer.from(data)]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lengthBuf, typeBytes, Buffer.from(data), crcBuf]);
}

/**
 * `width` × `height` のRGBA8チェッカーボードPNGバイト列を生成する(依存追加なし)。
 * 各スキャンラインの先頭にフィルタタイプ`0`(None)を付けた生ピクセル列を`deflateSync`で
 * 圧縮し、PNG(署名 + IHDR + IDAT + IEND)として組み立てる。
 *
 * `colorA`/`colorB`(省略時は既定の緑寄り/青寄り)を渡すと配色を変えられる
 * (MUST-1回帰テスト用。2枚の異なるキャプチャ画像を見分けられるようにするため、
 * `capture-race.spec.ts`が既定と異なる配色のフィクスチャを生成するのに使う)。
 */
export function createFixtureCapturePng(
  width: number = FIXTURE_WIDTH,
  height: number = FIXTURE_HEIGHT,
  colorA: readonly [number, number, number, number] = COLOR_A,
  colorB: readonly [number, number, number, number] = COLOR_B,
): Buffer {
  const bytesPerPixel = 4;
  const stride = 1 + width * bytesPerPixel;
  const raw = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // フィルタタイプ: None
    for (let x = 0; x < width; x++) {
      const tileX = Math.floor(x / TILE_SIZE);
      const tileY = Math.floor(y / TILE_SIZE);
      const color = (tileX + tileY) % 2 === 0 ? colorA : colorB;
      const offset = rowStart + 1 + x * bytesPerPixel;
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
      raw[offset + 3] = color[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const idatData = deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idatData),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
