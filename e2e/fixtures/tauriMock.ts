//! Vite dev server 上で動くブラウザページに対し、Tauri IPC をモックするフィクスチャ
//! (T13、ARCH §10 決定#4「Playwright + IPC モック、OSネイティブ導線は対象外」)。
//!
//! # 採用した方式と理由
//!
//! Tauri v2 公式は `@tauri-apps/api/mocks`(`mockIPC`/`mockWindows`/`mockConvertFileSrc`/
//! `clearMocks`)をモック用に提供している(公式ドキュメント
//! <https://v2.tauri.app/develop/tests/mocking/>)。これらは `window.__TAURI_INTERNALS__`
//! (`invoke`/`transformCallback`等)を注入するだけの純粋関数で、jsdom固有の実装には
//! 依存しておらず、実ブラウザ(Playwrightのchromium)でも動作可能(ソース確認済み:
//! `node_modules/@tauri-apps/api/mocks.js`)。
//!
//! ただし `@tauri-apps/api/mocks` はESM importを前提としたパッケージであり、Playwrightの
//! `page.addInitScript()` はアプリの先頭スクリプト実行前に評価される「単体の関数/スクリプト」
//! を注入する仕組みのため、そのままでは `import` を解決できない(事前バンドルが必要になる)。
//! 本タスクは依存追加を `@playwright/test` のみに限定しており、バンドル用ツールチェーンを
//! 追加導入したくないため、`@tauri-apps/api/mocks`(`mockIPC`, `mockWindows`)および
//! `@tauri-apps/api/core`(`invoke`)・`@tauri-apps/api/event`(`listen`/`emit`)が内部で
//! 呼び出す `window.__TAURI_INTERNALS__` への注入ロジックを、上記ソースと完全に同じ挙動で
//! `installTauriMocks()` 内にインライン化し、`page.addInitScript(fn, config)` で注入する
//! (Playwrightは関数を `toString()` して新しいドキュメントの先頭で実行するため、外部import
//! を持たない自己完結した関数である必要がある。公式ドキュメント
//! <https://playwright.dev/docs/api/class-page#page-add-init-script>)。
//!
//! `shouldMockEvents: true`(`mockIPC`のオプション)相当の実装により、アプリ本体が
//! `@tauri-apps/api/event::listen()`/`emit()` 経由で行う `capture://completed` の購読・発火も
//! 同じ `window.__TAURI_INTERNALS__.invoke` 経由でモックされる(公式のイベントモック機構と
//! 同一のプロトコル: `plugin:event|listen`/`plugin:event|emit`)。
//!
//! # 画像の配信経路(実機不具合②〜⑤の再発防止)
//!
//! 以前は `convertFileSrc()` をVite dev serverと**同一オリジン**の相対パスに差し替えて
//! いたため、実機(asset URLは webview と別オリジン)で起きていたCanvas汚染(tainted、
//! `getImageData()`/`toBlob()` の `SecurityError`)を検出できなかった。現在は:
//!
//! - アプリは画像を `read_capture_image` コマンド(生バイナリ)で受け取り、
//!   `Blob` → ObjectURL(同一オリジン扱い)にして描画する。本モックは
//!   `config.captureImageBase64` をデコードして `ArrayBuffer` を返す
//! - `convertFileSrc()` は実機と同じく**別オリジン**(`http://asset.localhost/...`)の
//!   URLを返す。テスト側はこのURLを `page.route()` でTauriのasset protocolと同じ
//!   `Access-Control-Allow-Origin` 付きで配信する。アプリが再び asset URL を
//!   `<img>` で読む実装に戻ると、実機と同じくCanvasが汚染されE2Eが失敗する
//!
//! (カスタムスキーム `asset://` はChromiumで `page.route()` が捕捉できないため、
//! Tauriが Windows/Android で使う `http://asset.localhost` 形式を使う。どちらも
//! webviewとは別オリジンである点は同じ。)

import type { Page } from "@playwright/test";

/** `convertFileSrc()` が返すURLのオリジン(webview と**別オリジン**、実機と同じ条件)。 */
export const ASSET_ORIGIN = "http://asset.localhost";

/** `capture_screen` コマンドの戻り値・`capture://completed` イベントpayload(モック用)。 */
export interface MockCaptureResult {
  id: string;
  sourcePath: string;
  kind: "range";
  createdAt: string;
}

/** `capture_screen` 呼び出し時のモック挙動。 */
export type CaptureMockBehavior =
  | { kind: "success"; result: MockCaptureResult }
  | { kind: "permissionDenied" };

export interface TauriMockConfig {
  /** 起動時の `check_screen_recording_permission` 呼び出しの戻り値。 */
  initialPermissionState: "granted" | "notGranted";
  /** `capture_screen`(アプリ内ボタン)呼び出し時の挙動。 */
  capture: CaptureMockBehavior;
  /** `read_capture_image` が返す画像(PNG)のbase64。 */
  captureImageBase64: string;
  /**
   * 2回目以降の `capture_screen` 呼び出しで使う結果・画像(MUST-1回帰テスト用、
   * `capture-race.spec.ts`)。省略時は毎回 `capture`/`captureImageBase64` を返す
   * (既存テストと後方互換)。`capture.kind === "success"` のときのみ有効。
   */
  secondCapture?: {
    result: MockCaptureResult;
    captureImageBase64: string;
  };
  /**
   * n回目の `capture_screen` 呼び出しで `captureResults[n-1]` を返す(履歴の件数上限の検証用。
   * 各回で別のid・createdAtにするため)。範囲外の回は `capture.result` を返す。画像は
   * `captureImageBase64`(`sourcePath`が同じでも構わない)。
   */
  captureResults?: MockCaptureResult[];
}

/**
 * `page.addInitScript()` へ渡す注入関数の型(ブラウザコンテキストで実行される)。
 * 外部の変数・importを参照できないため、引数の `config` のみに依存する。
 */
type InjectedMockScript = (config: TauriMockConfig) => void;

/**
 * ブラウザページ内で実行される注入スクリプト本体。
 *
 * `@tauri-apps/api/mocks::mockIPC`(`shouldMockEvents: true`)+ `mockWindows("main")` と
 * 同一のロジック(`window.__TAURI_INTERNALS__`/`window.__TAURI_EVENT_PLUGIN_INTERNALS__`
 * への注入。上記モジュールdoc参照)に加え、本アプリが実際に呼ぶコマンド
 * (`capture_screen`/`check_screen_recording_permission`/`open_screen_recording_settings`/
 * `read_capture_image`/
 * `plugin:image|new`/`plugin:resources|close`/`plugin:clipboard-manager|write_image`)への
 * 応答を `config` から解決する。
 */
const injectTauriMocks: InjectedMockScript = (config) => {
  const ASSET_ORIGIN_INLINE = "http://asset.localhost";
  const w = window as unknown as {
    __TAURI_INTERNALS__: Record<string, unknown>;
    __TAURI_EVENT_PLUGIN_INTERNALS__: Record<string, unknown>;
    __tadcapE2E?: {
      clipboardWriteCount: number;
      /** `activate_app`(v0.2.2、IMEが効くようにアプリをアクティブにする)の呼び出し回数。 */
      activateAppCount: number;
      /** 直近に`plugin:image|new`へ渡されたRGBA(コピー内容の検証用、T31)。 */
      lastImage?: { rgba: Uint8Array; width: number; height: number };
    };
  };

  w.__TAURI_INTERNALS__ = w.__TAURI_INTERNALS__ ?? {};
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = w.__TAURI_EVENT_PLUGIN_INTERNALS__ ?? {};
  w.__tadcapE2E = { clipboardWriteCount: 0, activateAppCount: 0 };

  // mockWindows("main") 相当。
  w.__TAURI_INTERNALS__.metadata = {
    currentWindow: { label: "main" },
    currentWebview: { windowLabel: "main", label: "main" },
  };

  // convertFileSrc() 相当。実機と同じく webview と別オリジンのURLを返す
  // (モジュールdoc「画像の配信経路」参照)。
  w.__TAURI_INTERNALS__.convertFileSrc = (filePath: string): string => {
    return `${ASSET_ORIGIN_INLINE}/${encodeURIComponent(filePath)}`;
  };

  // mockIPC(cb, { shouldMockEvents: true }) 相当。
  type EventListenerId = number;
  const eventListeners = new Map<string, EventListenerId[]>();
  const callbacks = new Map<number, (data: unknown) => void>();

  function registerCallback(callback: (data: unknown) => void): number {
    const id = Math.floor(Math.random() * 2 ** 31);
    callbacks.set(id, callback);
    return id;
  }
  function runCallback(id: number, data: unknown): void {
    const callback = callbacks.get(id);
    if (callback) {
      callback(data);
    }
  }
  function emitEvent(event: string, payload: unknown): void {
    const listeners = eventListeners.get(event) ?? [];
    for (const handlerId of listeners) {
      runCallback(handlerId, { event, id: handlerId, payload });
    }
  }

  function handleEventPlugin(cmd: string, args: Record<string, unknown>): unknown {
    switch (cmd) {
      case "plugin:event|listen": {
        const event = args.event as string;
        const handlerId = args.handler as number;
        const list = eventListeners.get(event) ?? [];
        list.push(handlerId);
        eventListeners.set(event, list);
        return handlerId;
      }
      case "plugin:event|emit": {
        emitEvent(args.event as string, args.payload);
        return null;
      }
      case "plugin:event|unlisten": {
        const event = args.event as string;
        const eventId = args.eventId as number;
        const list = eventListeners.get(event);
        if (list) {
          const index = list.indexOf(eventId);
          if (index !== -1) {
            list.splice(index, 1);
          }
        }
        return null;
      }
      default:
        return null;
    }
  }

  let resourceIdCounter = 1;
  let captureCallCount = 0;

  // sourcePath → base64画像のマップ(MUST-1回帰テスト用、`secondCapture`対応)。
  // 通常(`secondCapture`省略)は1エントリのみで、既存の挙動と同じ。
  const imageBySourcePath = new Map<string, string>();
  if (config.capture.kind === "success") {
    imageBySourcePath.set(config.capture.result.sourcePath, config.captureImageBase64);
  }
  if (config.secondCapture) {
    imageBySourcePath.set(
      config.secondCapture.result.sourcePath,
      config.secondCapture.captureImageBase64,
    );
  }

  async function invoke(
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    const actualArgs = args ?? {};
    if (cmd.startsWith("plugin:event|")) {
      return handleEventPlugin(cmd, actualArgs);
    }

    switch (cmd) {
      case "check_screen_recording_permission":
        return config.initialPermissionState;

      case "open_screen_recording_settings":
        return null;

      case "capture_screen": {
        if (config.capture.kind === "permissionDenied") {
          // Rust側 AppError::PermissionDenied は固定文字列でシリアライズされる
          // (src-tauri/src/error.rs)。フロントは文字列一致で判定する
          // (src/ipc/permissions.ts::isPermissionDeniedError())。
          throw "permission_denied";
        }
        captureCallCount += 1;
        // 2回目以降は`secondCapture`があればそちらを返す(MUST-1回帰テスト:
        // ドラッグ中に別経路のキャプチャが完了する状況を再現するため)。
        const result =
          config.captureResults?.[captureCallCount - 1] ??
          (captureCallCount >= 2 && config.secondCapture
            ? config.secondCapture.result
            : config.capture.result);
        // 実際のRust側(commands.rs::run_capture)はemit → 戻り値の順(emit後にOk(Some(result))を
        // 返す)。Canvas反映の主経路はイベント購読側(src/main.ts::handleCaptureCompleted)。
        emitEvent("capture://completed", result);
        return result;
      }

      case "read_capture_image": {
        // Rust側は `tauri::ipc::Response` で生バイナリを返し、`invoke()` は
        // `ArrayBuffer` で解決する。`path`(sourcePath)ごとに異なる画像を返せるようにし、
        // 該当が無ければ既定の`captureImageBase64`にフォールバックする(後方互換)。
        const path = actualArgs.path as string | undefined;
        const base64 = (path && imageBySourcePath.get(path)) || config.captureImageBase64;
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
      }

      case "plugin:image|new":
        // T31: コピーされた画像のピクセルを検証できるよう保持する(ハンドルが写らないこと等)。
        w.__tadcapE2E!.lastImage = {
          rgba: new Uint8Array(actualArgs.rgba as ArrayLike<number>),
          width: actualArgs.width as number,
          height: actualArgs.height as number,
        };
        return resourceIdCounter++;

      case "plugin:resources|close":
        return null;

      case "plugin:clipboard-manager|write_image":
        w.__tadcapE2E!.clipboardWriteCount += 1;
        return null;

      case "activate_app":
        w.__tadcapE2E!.activateAppCount += 1;
        return null;

      default:
        // eslint-disable-next-line no-console
        console.warn(`[tauriMock] unhandled IPC command: ${cmd}`);
        return null;
    }
  }

  w.__TAURI_INTERNALS__.invoke = invoke;
  w.__TAURI_INTERNALS__.transformCallback = registerCallback;
  w.__TAURI_INTERNALS__.unregisterCallback = (id: number) => callbacks.delete(id);
  w.__TAURI_INTERNALS__.runCallback = runCallback;
  w.__TAURI_INTERNALS__.callbacks = callbacks;
  w.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = (
    _event: string,
    id: number,
  ) => callbacks.delete(id);
};

/**
 * `page` のナビゲーション前に Tauri IPC モックを注入する。
 * 必ず `page.goto()` より前に呼ぶこと(`addInitScript` は次回以降のナビゲーションから
 * 効くため)。
 */
export async function installTauriMocks(
  page: Page,
  config: TauriMockConfig,
): Promise<void> {
  await page.addInitScript(injectTauriMocks, config);
}

/** E2Eの webview オリジン(`playwright.config.ts` の `baseURL`)。 */
const WEBVIEW_ORIGIN = "http://localhost:1420";

/**
 * `convertFileSrc()` が返す別オリジンURL宛のリクエストを、Tauriのasset protocolと同じ
 * `Access-Control-Allow-Origin: <webviewのオリジン>` 付きで `png` にフルフィルする
 * (tauri 2.11.6 `src/protocol/asset.rs`)。`crossOrigin` 無しの `<img>` はこのヘッダーが
 * あってもno-corsで読むため、Canvasが汚染される(実機不具合②〜⑤と同じ条件)。
 */
export async function routeCrossOriginAssets(
  page: Page,
  png: Buffer,
): Promise<void> {
  await page.route(`${ASSET_ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: "image/png",
      headers: { "Access-Control-Allow-Origin": WEBVIEW_ORIGIN },
      body: png,
    }),
  );
}

/**
 * `plugin:clipboard-manager|write_image` が呼ばれた回数を返す(クリップボードコピー
 * 成功の検証用)。`installTauriMocks()` 実行後、ページ遷移後に呼ぶこと。
 */
/** `activate_app` が呼ばれた回数(テキスト入力欄のフォーカスでアプリをアクティブにする、v0.2.2)。 */
export async function getActivateAppCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __tadcapE2E?: { activateAppCount: number } };
    return w.__tadcapE2E?.activateAppCount ?? 0;
  });
}

export async function getClipboardWriteCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __tadcapE2E?: { clipboardWriteCount: number } };
    return w.__tadcapE2E?.clipboardWriteCount ?? 0;
  });
}

/** クリップボードへ渡された直近の画像についての集計(T31)。 */
export interface ClipboardImageStats {
  width: number;
  height: number;
  /** 近白色(各チャンネル240以上)の画素数。ハンドル(白塗り)が写っていないことの検証用。 */
  nearWhitePixels: number;
  /** `target`色に`tolerance`以内の画素数。 */
  targetColorPixels: number;
  /** Canvasの現在ピクセルと完全一致するか。 */
  equalsCanvas: boolean;
}

/**
 * 直近に`plugin:image|new`へ渡されたRGBA(=クリップボードにコピーされた画像)を集計する(T31)。
 * コピーがまだ無い場合は`null`。
 */
export async function getClipboardImageStats(
  page: Page,
  target: { r: number; g: number; b: number },
  tolerance: number,
): Promise<ClipboardImageStats | null> {
  return page.evaluate(
    ({ target, tolerance }) => {
      const w = window as unknown as {
        __tadcapE2E?: { lastImage?: { rgba: Uint8Array; width: number; height: number } };
      };
      const image = w.__tadcapE2E?.lastImage;
      if (!image) {
        return null;
      }
      let nearWhitePixels = 0;
      let targetColorPixels = 0;
      const { rgba } = image;
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i] >= 240 && rgba[i + 1] >= 240 && rgba[i + 2] >= 240) {
          nearWhitePixels += 1;
        }
        if (
          Math.abs(rgba[i] - target.r) <= tolerance &&
          Math.abs(rgba[i + 1] - target.g) <= tolerance &&
          Math.abs(rgba[i + 2] - target.b) <= tolerance
        ) {
          targetColorPixels += 1;
        }
      }
      const canvas = document.querySelector<HTMLCanvasElement>("#capture-canvas");
      const ctx = canvas?.getContext("2d");
      let equalsCanvas = false;
      if (canvas && ctx && canvas.width === image.width && canvas.height === image.height) {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        equalsCanvas = data.length === rgba.length && data.every((v, i) => v === rgba[i]);
      }
      return {
        width: image.width,
        height: image.height,
        nearWhitePixels,
        targetColorPixels,
        equalsCanvas,
      };
    },
    { target, tolerance },
  );
}
