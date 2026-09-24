//! 矢印/矩形/モザイクのツール切替UI(ARCH §4 `src/ui/toolbar.ts`、FR-006・FR-007・FR-008
//! 共通、T09)。
//!
//! T09時点では「矢印」のみ有効だったが、T10で `TOOLS` にモザイクのエントリを追加した。
//! 同じ描画・切替ロジックがそのまま使える構造にしてあったため、UI側の変更のみで拡張できた
//! (「T10でモザイクを追加できる構造」PJM指示。過剰な汎用化はしない)。T25で矩形のエントリを
//! 追加した(同じ構造のまま拡張、FR-007)。T26で円(楕円)のエントリを矩形の直後に追加した
//! (同じ構造のまま拡張、FR-011)。T27でテキストのエントリを円の直後・モザイクの前に追加した(FR-012)。
//!
//! T19: 文言ボタンからアイコンボタンへ変更した(「主役はキャプチャ画像、UIは脇役」方針)。
//! 意味はテキストの代わりに `aria-label`/`title`(ツールチップ)で保持するため、
//! アクセシビリティツリー上の名前(`aria-label`)は変更していない
//! (`e2e/capture-flow.spec.ts` の `getByRole("button", { name: "矢印" })` 等はそのまま通る)。
//! アイコンは依存追加を避け、インラインSVG文字列を直接埋め込む。
//!
//! DOM生成・購読を伴うため、Vitestの既定環境(Node、DOM API無し)では自動テスト対象外と
//! する(project-config.md §11。`permissionBanner.ts`と同じ方針)。ツール状態の切替ロジック
//! 自体は `canvas/canvasState.ts` の `toggleTool()`/`toggleActiveTool()` が純粋関数として
//! 担い、そちらをユニットテストする。

import {
  getCanvasState,
  subscribeCanvasState,
  toggleActiveTool,
  type ToolId,
} from "../canvas/canvasState";

interface ToolDefinition {
  id: ToolId;
  label: string;
  /** インラインSVGアイコン(`viewBox="0 0 20 20"` に統一、T19)。 */
  icon: string;
}

const TOOLS: ToolDefinition[] = [
  {
    id: "arrow",
    label: "矢印",
    icon:
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<path d="M4.5 15.5 14.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      '<path d="M8.5 5.5H14.5V11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>",
  },
  {
    id: "rectangle",
    label: "矩形",
    icon:
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<rect x="3.5" y="5" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      "</svg>",
  },
  {
    id: "ellipse",
    label: "円",
    icon:
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<ellipse cx="10" cy="10" rx="6.5" ry="5" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      "</svg>",
  },
  {
    id: "text",
    label: "テキスト",
    icon:
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<path d="M4.5 5.5V4.5H15.5V5.5M10 4.5V15.5M7.5 15.5H12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>",
  },
  {
    id: "mosaic",
    label: "モザイク",
    icon:
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor"/>' +
      '<rect x="11" y="3" width="6" height="6" rx="1" fill="currentColor" opacity="0.45"/>' +
      '<rect x="3" y="11" width="6" height="6" rx="1" fill="currentColor" opacity="0.45"/>' +
      '<rect x="11" y="11" width="6" height="6" rx="1" fill="currentColor"/>' +
      "</svg>",
  },
];

/**
 * ツール切替UIを `mount` 配下に構築し、`canvasState` と結線する(Container相当)。
 * ボタンクリックで `toggleActiveTool()` を呼び、状態変化を購読して押下状態(`aria-pressed`)に
 * 反映する。描画中(`isDrawing`)は非アクティブなボタンを無効化し、ドラッグ中のツール切替を防ぐ。
 */
export function initToolbar(mount: HTMLElement): void {
  const buttons = new Map<ToolId, HTMLButtonElement>();

  for (const tool of TOOLS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button tool-toolbar__button";
    button.innerHTML = tool.icon;
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", tool.label);
    button.title = tool.label;
    button.addEventListener("click", () => {
      toggleActiveTool(tool.id);
    });
    buttons.set(tool.id, button);
    mount.appendChild(button);
  }

  const render = (): void => {
    const { activeTool, isDrawing } = getCanvasState();
    for (const [id, button] of buttons) {
      const active = activeTool === id;
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("tool-toolbar__button--active", active);
      button.disabled = isDrawing && !active;
    }
  };

  subscribeCanvasState(render);
  render();
}
