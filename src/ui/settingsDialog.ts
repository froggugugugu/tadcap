//! 設定画面(エディタの上に出す`<dialog>`のモーダル、KS-T5)。キャプチャのショートカット(2026-10-08
//! 人間の決定)と、区切り線を挟んで「コピーを等倍に縮める」(QE-T09、UI_quick-edits §5.1)を変えられる。
//!
//! - キー入力欄(ボタン)を押すと記録を始め、次に押した組み合わせをその場でキャプチャのキーにする
//!   (保存ボタンは置かない)。修飾キーだけの押下は続きを待ち、Esc は記録の取り消し(記録中でなければ
//!   閉じる)。使えないキー・登録や保存の失敗は理由を出し、表示は元のキーのまま
//! - 記録中は Rust に伝え、現在のキーを押してもキャプチャしないようにする。記録の終了・入力欄から
//!   フォーカスが外れる・閉じるで必ず解除する
//! - モーダルの中で押したキーは`window`へ伝えない(エディタの ⌘Z・⌘C・Delete などが裏で動かないように)
//! - `open()`は既に開いていれば何もしない(トレイとアプリメニューの両方から届いても1つだけ)
//! - 縮めてコピーは切り替えたらすぐ保存する(保存ボタンなし)。保存中はチェックを`disabled`にし、失敗したら
//!   チェックを元に戻して知らせる。開くたびに保存されている値を読み直す
//!
//! DOM の組み立て・イベント結線は他のUIモジュールと同じくVitest(Node)の対象外で、E2E
//! (`e2e/shortcut-settings.spec.ts`・`e2e/shrink-copy.spec.ts`)で検証する。文言・キーの判定は
//! `shortcutFormat.ts`の純粋関数、縮めてコピーの表示の決め方は本ファイルの`shrinkCopyView*`(純粋関数)。

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
  /** 縮めてコピーの設定を読む(QE-T09。`ipc/settings.ts`の`getShrinkCopy`)。 */
  getShrinkCopy: () => Promise<boolean>;
  /** 縮めてコピーの設定を保存し、保存後の値を返す(失敗は reject。`ipc/settings.ts`の`setShrinkCopy`)。 */
  setShrinkCopy: (enabled: boolean) => Promise<boolean>;
  /** 縮めてコピーの設定の保存に成功したとき(コピーの経路が読む値の更新、`main.ts`)。 */
  onShrinkCopyChanged: (enabled: boolean) => void;
}

/** 縮めてコピーの保存の失敗の文(UI_quick-edits §5.1・§6)。 */
export const SHRINK_COPY_SAVE_FAILED_TEXT = "保存できませんでした。元の設定のままです。";

/** 縮めてコピーのチェックと状態の文の表示。 */
export interface ShrinkCopyView {
  checked: boolean;
  /** 状態の文(空文字なら出さない。出すのは保存の失敗だけ)。 */
  status: string;
}

export type ShrinkCopySaveResult = { kind: "saved"; enabled: boolean } | { kind: "failed" };
export type ShrinkCopyLoadResult = { kind: "loaded"; enabled: boolean } | { kind: "failed" };

/**
 * 保存の結果から表示を決める。成功は保存後の値(実際の設定)を出し、失敗は切り替える前の値
 * `previous`に戻して失敗の文を出す。
 */
export function shrinkCopyViewAfterSave(previous: boolean, result: ShrinkCopySaveResult): ShrinkCopyView {
  if (result.kind === "saved") {
    return { checked: result.enabled, status: "" };
  }
  return { checked: previous, status: SHRINK_COPY_SAVE_FAILED_TEXT };
}

/** 開いたときの読み直しの結果から表示を決める。読めなければ既定のオフとして出す。 */
export function shrinkCopyViewAfterLoad(result: ShrinkCopyLoadResult): ShrinkCopyView {
  return { checked: result.kind === "loaded" && result.enabled, status: "" };
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
  // 縮めてコピーには効かないため、どちらを戻すか分かる文言にする(UI_quick-edits §5.1)。
  resetButton.textContent = "キーを既定に戻す";
  const closeButton = document.createElement("button");
  closeButton.value = "close";
  closeButton.className = "confirm-dialog__button";
  closeButton.textContent = "閉じる";
  actions.append(resetButton, closeButton);

  // 縮めてコピー(QE-T09、UI_quick-edits §5.1)。文言は固定文字列を`textContent`で入れる。
  const divider = document.createElement("hr");
  divider.className = "settings-dialog__divider";
  const shrinkLabel = document.createElement("label");
  shrinkLabel.className = "settings-dialog__check";
  const shrinkCheckbox = document.createElement("input");
  shrinkCheckbox.type = "checkbox";
  shrinkCheckbox.id = "shrink-copy";
  shrinkCheckbox.setAttribute("aria-describedby", "shrink-copy-hint");
  shrinkLabel.append(shrinkCheckbox, document.createTextNode("コピーを等倍に縮める"));
  const shrinkHint = document.createElement("p");
  shrinkHint.id = "shrink-copy-hint";
  shrinkHint.className = "settings-dialog__check-hint";
  shrinkHint.textContent =
    "高精細な画面で撮った画像を、画面で見えていた大きさに縮めてコピーします(倍率 2 倍の画面なら縦横 1/2)。編集中の画像は縮めません。";
  const shrinkStatus = document.createElement("p");
  shrinkStatus.id = "shrink-copy-status";
  shrinkStatus.className = "settings-dialog__status settings-dialog__status--error";
  shrinkStatus.setAttribute("role", "status");

  form.append(title, row, hint, status, divider, shrinkLabel, shrinkHint, shrinkStatus, actions);
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

  // --- 縮めてコピー ---
  // 読み込み中・保存中はチェックを使えなくする(古い値の上書き・保存の追い越しを防ぐ)。
  let shrinkSaving: Promise<void> = Promise.resolve();
  let shrinkLoading = false;

  const showShrinkCopy = (view: ShrinkCopyView): void => {
    shrinkCheckbox.checked = view.checked;
    shrinkStatus.textContent = view.status;
  };

  shrinkCheckbox.addEventListener("change", () => {
    const requested = shrinkCheckbox.checked;
    const previous = !requested;
    shrinkCheckbox.disabled = true;
    shrinkStatus.textContent = "";
    shrinkSaving = (async () => {
      let result: ShrinkCopySaveResult;
      try {
        result = { kind: "saved", enabled: await deps.setShrinkCopy(requested) };
      } catch (error) {
        console.warn("縮めてコピーの設定を保存できませんでした", error);
        result = { kind: "failed" };
      }
      if (result.kind === "saved") {
        deps.onShrinkCopyChanged(result.enabled);
      }
      showShrinkCopy(shrinkCopyViewAfterSave(previous, result));
      shrinkCheckbox.disabled = shrinkLoading;
    })();
  });

  const loadShrinkCopy = async (): Promise<void> => {
    shrinkLoading = true;
    shrinkCheckbox.disabled = true;
    shrinkStatus.textContent = "";
    // 閉じる前に始めた保存が残っていれば、終わってから読む(保存前の値で表示を戻さないように)。
    await shrinkSaving;
    let result: ShrinkCopyLoadResult;
    try {
      result = { kind: "loaded", enabled: await deps.getShrinkCopy() };
    } catch (error) {
      console.warn("縮めてコピーの設定を読み込めませんでした", error);
      result = { kind: "failed" };
    }
    showShrinkCopy(shrinkCopyViewAfterLoad(result));
    shrinkLoading = false;
    shrinkCheckbox.disabled = false;
  };

  // モーダルの中のキーをエディタ(`window`の keydown)へ伝えない。
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
  });

  dialog.addEventListener("close", () => {
    setRecording(false);
    showStatus("");
    shrinkStatus.textContent = "";
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
    void loadShrinkCopy();
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
