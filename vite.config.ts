/// <reference types="vitest/config" />
import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //    テスト・レポートの出力先も除外する(E2E 実行中に dev 画面が再読み込みされるのを防ぐ)
      ignored: ["**/src-tauri/**", "**/testreport/**", "**/output/**", "**/e2e/**"],
    },
  },

  // Vitest options (`npm run test` / `npm run test:run`)
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      reportsDirectory: "testreport/coverage",
    },
  },
}));
