# サードパーティのライセンス表示

Tadcap 本体は MIT License（[LICENSE](LICENSE)）です。

## アプリ（Tadcap.app）

アプリが使う Rust クレート（Tauri など）と npm パッケージのライセンスは、それぞれのパッケージに同梱されたライセンスファイルに従います（依存の一覧は `src-tauri/Cargo.lock` と `package-lock.json`）。

## 紹介ページ（.github/pages/assets/）

紹介ページ（GitHub Pages）は、次のスクリプトを同じサイトから配信しています。

- Tailwind CSS 3.4.17 の Play CDN スクリプト（`tailwindcss-3.4.17.js`）
- Lucide 1.45.0（`lucide-1.45.0.min.js`）

```text
Tailwind CSS

MIT License

Copyright (c) Tailwind Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

```text
Lucide

ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2023 as part of
Feather (MIT). All other copyright (c) for Lucide are held by Lucide
Contributors 2025.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

Lucide のうち Feather に由来する部分は、MIT License（Copyright (c) 2013-2023 Cole Bemis）です。条文は上の Tailwind CSS と同じ MIT License です。

紹介ページは Google Fonts（Inter、JetBrains Mono。いずれも SIL Open Font License 1.1）を Google のサーバーから読み込みます。

## 商標

macOS は Apple Inc. の商標です。Tadcap は Apple Inc. とは関係のない、個人が作っているツールです。
