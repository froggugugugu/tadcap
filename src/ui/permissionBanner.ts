//! 画面収録権限未許可時の案内バナー(ARCH §3.1 フロントエンド UI 層、§4
//! `src/ui/permissionBanner.ts`、NFR-002、T08)。
//!
//! バナーの表示要否は3状態(`"unconfirmed"`/`"granted"`/`"notGranted"`)の
//! 純粋関数([`shouldShowPermissionBanner`])で判定し、DOM生成・操作
//! (Presentational: [`renderPermissionBannerView`] / Container:
//! [`initPermissionBanner`])とは分離する(ARCH §9.1 規約)。フロントの3つの
//! 入口(ボタンの `invoke` reject、トレイ/ショートカット起点の
//! `capture://error` イベント、起動時の事前確認、いずれも `src/main.ts` が
//! 結線する)は、どこから来ても同じ [`PermissionBannerController.showDenied`]
//! を呼び同じバナーを表示する(PJM決定 2026-09-23)。

import {
  openScreenRecordingSettings,
  type PermissionState,
} from "../ipc/permissions";

/** バナーの開閉操作(`initPermissionBanner` が返すController、T08)。 */
export interface PermissionBannerController {
  /** 画面収録権限が未許可であることを示すバナーを表示する。 */
  showDenied(): void;
  /** バナーを非表示にする(許可済み・未確認への遷移時)。 */
  hide(): void;
}

/**
 * 権限状態からバナーを表示すべきかを判定する純粋関数(テスト対象)。
 *
 * `"unconfirmed"`(起動直後、未確認)・`"granted"`(許可済み)のいずれも
 * 表示しない。`"notGranted"` のときのみ表示する。
 */
export function shouldShowPermissionBanner(state: PermissionState): boolean {
  return state === "notGranted";
}

/**
 * バナー本文(純粋関数、テスト対象)。
 *
 * T19: 「説明過多にせず一行程度に」の方針で短縮した(「システム設定を開く」ボタンへの
 * 言及と、再起動が必要な場合がある旨のみ残す。手順の詳細(プライバシーとセキュリティ→
 * 画面収録)はボタン導線に任せ、文言からは省く)。
 *
 * 【仮定】macOSの画面収録権限は、システム設定で許可した直後はアプリに反映されず、
 * アプリの再起動が必要になる場合がある(TCCの既知の挙動として広く知られているが、
 * Apple公式ドキュメントに明記された一次情報は確認できなかった)。ユーザーが
 * 「許可したのに変わらない」と誤解しないよう文言に残す。実機での要否確認は
 * 手動確認チェックリスト#2へ回す。
 */
export function permissionBannerMessage(): string {
  return (
    "画面収録の権限が許可されていません。" +
    "「システム設定を開く」から許可してください(反映されない場合は再起動)。"
  );
}

/** バナーのDOM構造を組み立てる(Presentational)。 */
function renderPermissionBannerView(): {
  container: HTMLElement;
  openSettingsButton: HTMLButtonElement;
} {
  const container = document.createElement("div");
  container.className = "permission-banner";
  container.hidden = true;
  container.setAttribute("role", "alert");

  const message = document.createElement("p");
  message.className = "permission-banner__message";
  message.textContent = permissionBannerMessage();
  container.appendChild(message);

  const openSettingsButton = document.createElement("button");
  openSettingsButton.type = "button";
  openSettingsButton.className = "permission-banner__button";
  openSettingsButton.textContent = "システム設定を開く";
  container.appendChild(openSettingsButton);

  return { container, openSettingsButton };
}

/**
 * バナーを `mount` の先頭に挿入し、開閉操作を提供するコントローラを返す
 * (Container相当)。ボタンクリックで `openScreenRecordingSettings()` を呼ぶ。
 *
 * DOM操作を伴うため、Vitestの既定環境(Node、DOM API無し)では自動テスト対象
 * 外とする(project-config.md §11参照)。表示分岐ロジックは
 * [`shouldShowPermissionBanner`]、文言は [`permissionBannerMessage`] を
 * それぞれ独立してユニットテストする。
 */
export function initPermissionBanner(
  mount: HTMLElement,
): PermissionBannerController {
  const { container, openSettingsButton } = renderPermissionBannerView();
  mount.prepend(container);

  openSettingsButton.addEventListener("click", () => {
    void openScreenRecordingSettings();
  });

  return {
    showDenied: () => {
      container.hidden = false;
    },
    hide: () => {
      container.hidden = true;
    },
  };
}
