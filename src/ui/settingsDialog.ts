//! 設定画面(エディタの上に出す`<dialog>`のモーダル、KS-T5)。いまはキャプチャのショートカットだけを
//! 変えられる(2026-10-08 人間の決定)。
//!
//! - キー入力欄(ボタン)を押すと記録を始め、次に押した組み合わせをその場でキャプチャのキーにする
//!   (保存ボタンは置かない)。修飾キーだけの押下は続きを待ち、Esc は記録の取り消し(記録中でなければ
//!   閉じる)。使えないキー・登録や保存の失敗は理由を出し、表示は元のキーのまま
//! - 記録中は Rust に伝え、現在のキーを押してもキャプチャしないようにする。記録の終了・入力欄から
//!   フォーカスが外れる・閉じるで必ず解除する
//! - モーダルの中で押したキーは`window`へ伝えない(エディタの ⌘Z・⌘C・Delete などが裏で動かないように)
//! - `open()`は既に開いていれば何もしない(トレイとアプリメニューの両方から届いても1つだけ)
//!
//! DOM の組み立て・イベント結線は他のUIモジュールと同じくVitest(Node)の対象外で、E2E
//! (`e2e/shortcut-settings.spec.ts`)で検証する。文言・キーの判定は`shortcutFormat.ts`の純粋関数。

import type { CaptureShortcutInfo } from "../ipc/settings";
import {
  acceleratorFromKeyEvent,
  shortcutErrorMessage,
  shortcutLabel,
  shortcutNotice,
} from "./shortcutFormat";

export interface SettingsDialogDeps {
  getShortcut: () => Promise<CaptureShortcutInfo>;
  setShortcut: (accelerator: string) => Promise<CaptureShortcutInfo>;
  resetShortcut: () => Promise<CaptureShortcutInfo>;
  setRecording: (recording: boolean) => Promise<void>;
  /** キーが変わったとき(表記の追従、`captureShortcutLabel.ts`)。 */
  onChanged: (info: CaptureShortcutInfo) => void;
}

export interface SettingsDialogController {
  /** 設定画面を開く(既に開いていれば何もしない)。 */
  open: () => Promise<void>;
}

const RECORDING_TEXT = "キーを押してください…";
const NOT_REGISTERED_TEXT = "現在のキーは登録できていません。ほかのアプリが使っている可能性があります。別のキーを選んでください。";

/** 設定画面を組み立てて`mount`に追加する。 */
export function initSettingsDialog(mount: HTMLElement, deps: SettingsDialogDeps): SettingsDialogController {
  const dialog = document.createElement("dialog");
  dialog.className = "settings-dialog";
  dialog.setAttribute("aria-labelledby", "settings-title");

  const form = document.createElement("form");
  form.method = "dialog";

  const title = document.createElement("h2");
  title.id = "settings-title";
  title.className = "settings-dialog__title";
  title.textContent = "設定";

  const row = document.createElement("div");
  row.className = "settings-dialog__row";
  const label = document.createElement("span");
  label.id = "capture-shortcut-name";
  label.className = "settings-dialog__label";
  label.textContent = "キャプチャのショートカット";
  const recorder = document.createElement("button");
  recorder.type = "button";
  recorder.className = "shortcut-recorder";
  recorder.setAttribute("aria-labelledby", "capture-shortcut-name capture-shortcut-value");
  recorder.setAttribute("aria-describedby", "capture-shortcut-status");
  const recorderValue = document.createElement("span");
  recorderValue.id = "capture-shortcut-value";
  recorder.appendChild(recorderValue);
  row.append(label, recorder);

  const hint = document.createElement("p");
  hint.className = "settings-dialog__hint";
  hint.textContent = "ボタンを押してから、新しいキーの組み合わせを押してください。";

  const status = document.createElement("p");
  status.id = "capture-shortcut-status";
  status.className = "settings-dialog__status";
  status.setAttribute("role", "status");

  const actions = document.createElement("div");
  actions.className = "confirm-dialog__actions";
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "confirm-dialog__button";
  resetButton.textContent = "既定に戻す";
  const closeButton = document.createElement("button");
  closeButton.value = "close";
  closeButton.className = "confirm-dialog__button";
  closeButton.textContent = "閉じる";
  actions.append(resetButton, closeButton);

  form.append(title, row, hint, status, actions);
  dialog.appendChild(form);
  mount.appendChild(dialog);

  let info: CaptureShortcutInfo | null = null;
  let recording = false;
  let busy = false;

  const showStatus = (text: string, kind: "info" | "error" = "info"): void => {
    status.textContent = text;
    status.classList.toggle("settings-dialog__status--error", kind === "error");
  };

  const render = (): void => {
    recorder.classList.toggle("shortcut-recorder--recording", recording);
    recorder.setAttribute("aria-pressed", String(recording));
    recorderValue.textContent = recording ? RECORDING_TEXT : info ? shortcutLabel(info.accelerator) : "";
    resetButton.disabled = busy || !info || info.isDefault;
    recorder.disabled = busy;
  };

  // 記録中の ON/OFF は順番どおりに届ける(前後すると、記録を終えたのに ON のまま残り、
  // キャプチャのキーが効かなくなる。レビュー 2026-10-08)。
  let recordingQueue: Promise<void> = Promise.resolve();
  const setRecording = (next: boolean): void => {
    if (recording === next) {
      return;
    }
    recording = next;
    render();
    recordingQueue = recordingQueue
      .then(() => deps.setRecording(next))
      .catch((error: unknown) => {
        console.warn("記録中の状態をアプリへ伝えられませんでした", error);
      });
  };

  const applied = (next: CaptureShortcutInfo, message: string): void => {
    info = next;
    deps.onChanged(next);
    showStatus(shortcutNotice(next.accelerator) ?? message);
  };

  const change = async (run: () => Promise<CaptureShortcutInfo>, message: string): Promise<void> => {
    busy = true;
    render();
    try {
      applied(await run(), message);
    } catch (error) {
      console.warn("キャプチャのキーを変更できませんでした", error);
      showStatus(shortcutErrorMessage(error), "error");
      // 元のキーの登録し直しにも失敗していることがあるので、実際の状態を読み直して知らせる
      // (レビュー 2026-10-08)。
      try {
        info = await deps.getShortcut();
        if (!info.registered) {
          showStatus(`${shortcutErrorMessage(error)} ${NOT_REGISTERED_TEXT}`, "error");
        }
      } catch (refreshError) {
        console.warn("キャプチャのキーを読み込めませんでした", refreshError);
      }
    } finally {
      busy = false;
      render();
    }
  };

  recorder.addEventListener("click", () => {
    // macOS の WebKit はボタンをクリックしてもフォーカスしないため、キーを受けられるよう明示する。
    recorder.focus();
    showStatus("");
    setRecording(!recording);
  });
  recorder.addEventListener("blur", () => setRecording(false));

  recorder.addEventListener("keydown", (event) => {
    if (!recording) {
      return;
    }
    if (event.key === "Tab") {
      return; // フォーカス移動に使う(blur で記録を終える)
    }
    // Esc の既定動作(モーダルを閉じる)・ボタンの Enter/Space(押下)を記録中は起こさない。
    event.preventDefault();
    if (event.key === "Escape") {
      setRecording(false);
      return;
    }
    const result = acceleratorFromKeyEvent(event);
    if (result.kind === "wait") {
      return;
    }
    setRecording(false);
    if (result.kind === "error") {
      showStatus(shortcutErrorMessage(result.reason), "error");
      return;
    }
    void change(() => deps.setShortcut(result.accelerator), "変更しました。");
  });

  resetButton.addEventListener("click", () => {
    void change(deps.resetShortcut, "既定のキーに戻しました。");
  });

  // モーダルの中のキーをエディタ(`window`の keydown)へ伝えない。
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
  });

  dialog.addEventListener("close", () => {
    setRecording(false);
    showStatus("");
  });

  const open = async (): Promise<void> => {
    if (dialog.open) {
      return;
    }
    // 先に開いてから中身を入れる(取得を待つ間に2回目の open が来ても二重に開かない)。
    showStatus("");
    info = null;
    // 読み込みが終わるまでは記録・既定に戻すを使えなくする(後から届いた古い値で、変えたばかりの
    // 表示を上書きしないように。レビュー 2026-10-08)。
    busy = true;
    dialog.showModal();
    render();
    try {
      info = await deps.getShortcut();
      if (!info.registered) {
        showStatus(NOT_REGISTERED_TEXT, "error");
      }
    } catch (error) {
      console.warn("キャプチャのキーを読み込めませんでした", error);
      showStatus("現在のキーを読み込めませんでした。", "error");
    } finally {
      busy = false;
    }
    render();
  };

  return { open };
}
