# Tadcap 🐸

macOS専用の、キャプチャを主役にしたスクリーンショットツール。
「撮る → すぐ描き込む → すぐ渡す」を最短の操作で。

> tadpole（オタマジャクシ）+ capture

## 特徴（予定）

- グローバルショートカットで範囲 / ウィンドウ / 全画面キャプチャ
- キャプチャ直後に軽量エディタで矢印・枠・テキスト・モザイク
- クリップボードへ即コピー、ドラッグ＆ドロップで他アプリへ

## 動作環境

- macOS 14 (Sonoma) 以降
- 初回起動時に「画面収録」の許可が必要

## 開発

```bash
npm install
npm run tauri dev     # 開発起動
npm run tauri build   # .app / .dmg 生成
```

前提: Rust (stable)、Node.js 20+、Xcode Command Line Tools

## 構成

```
src/          フロントエンド（TypeScript + Vite）: エディタUI
src-tauri/    バックエンド（Rust）: キャプチャ、ショートカット、トレイ、クリップボード
docs/         要件・設計
```

## ライセンス

MIT
