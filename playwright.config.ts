import { defineConfig, devices } from "@playwright/test";

/**
 * E2Eテスト設定(T13、ARCH §10 決定#4)。
 *
 * Tauriランタイムは起動せず、Vite dev serverが配信する素のWebページを chromium で
 * 開き、Tauri IPCは `e2e/fixtures/tauriMock.ts` でモックする(OSネイティブ導線
 * (`screencapture` 実起動・実クリップボード・実権限ダイアログ)は対象外)。
 *
 * レポート出力は `.claude/skills/e2e-testing/SKILL.md` の規約どおり `testreport/e2e/`
 * (ツール生データ、`.gitignore` 対象)に統一する。
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // NOTE: HTMLレポーター(`testreport/e2e/`)はレポート生成のたびに出力先を消去するため、
  // `outputDir`(トレース・スクリーンショット等の生成物)を配下(`testreport/e2e/results`)
  // にすると起動時に「clashes with the tests output folder」警告が出て生成物が消える恐れが
  // ある(Playwright実行時に確認)。両者は `testreport/` 配下の兄弟ディレクトリに分離する
  // (スキル規約「ツール出力は testreport/e2e/」の趣旨は維持しつつ、Playwright側の制約に
  // 合わせて `outputDir` のみ `testreport/e2e-artifacts` にした)。
  reporter: [["html", { outputFolder: "testreport/e2e", open: "never" }]],
  outputDir: "testreport/e2e-artifacts",

  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },

  // Vite dev server はTauriの固定ポート(vite.config.ts、tauri.conf.json devUrl)と
  // 一致させる。`npm run dev` は `vite` 単体起動であり、Tauriランタイムは不要。
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },

  // ブラウザは chromium のみ(タスク指示、`npx playwright install chromium`)。
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
