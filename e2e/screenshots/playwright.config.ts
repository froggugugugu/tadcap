import { defineConfig, devices } from "@playwright/test";

/**
 * UIスクリーンショット撮影専用の設定(T19、UI再設計のBefore/After証跡)。
 *
 * 本ディレクトリ配下のファイルは `*.visual.ts`(`*.spec.ts`/`*.test.ts` ではない)にし、
 * ルートの `playwright.config.ts`(`npm run e2e`、`testDir: "./e2e"` を再帰スキャン)の
 * 既定 `testMatch`(ファイル名に `.spec.`/`.test.` を含むもののみ対象)には一致させない。
 * これにより `npm run e2e` の通常実行に本ファイル群は含まれず、実行時間へ影響しない。
 *
 * 実行: `npm run e2e:screenshots:before` / `npm run e2e:screenshots:after`
 * (`UI_SCREENSHOT_LABEL` 環境変数で出力先 `output/reports/ui/<label>/` を切替える)。
 */
export default defineConfig({
  testDir: "./",
  testMatch: /.*\.visual\.ts/,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "../../testreport/e2e-screenshots-artifacts",

  use: {
    baseURL: "http://localhost:1420",
  },

  // ルートのe2e設定(../../playwright.config.ts)と同じdev serverを使う。
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
