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
//! 担い、そちらをユニットテストする。ボタンの押下・無効の判定は純粋関数 `toolButtonState()` に
//! 切り出してユニットテストする(AM-T13)。
//!
//! AM-T13・AM-T25-F1: 自動マスキングの処理中・確認中(`maskSession` が `idle` 以外)は全ツールボタンを無効にする
//! (ARCH_auto-masking §15 #4 A 案「確認モード」、FR-012)。
//!
//! QE-T02: ボタンの名前を `矢印(A)` の形にし、`aria-keyshortcuts` を付けた(UI_quick-edits §1.3)。
//! 名前とキーは `toolKeys.ts` の `TOOL_KEYS` から読む。1 キー切替の可否も本モジュールの
//! `toolButtonState()` を使う(`main.ts` が `bindToolKeys()` に渡す)。
//!
//! QE-T03: ツールを「描く注釈」(色を使う)と「画像を変える」(色を持たない)の 2 組に分け、
//! `initToolbar()` が組の間に細い区切り(`.tool-toolbar__divider`)を 1 本入れる(UI_quick-edits §1.1)。
//! 区切りは見た目だけで、グループの `role="group"` は 1 つのまま。
//!
//! QE-T13: スタンプ(N)のボタンを描く注釈の組の最後(テキストの直後)に加えた(UI_quick-edits §1.1・§1.2)。
//! QE-T16: スポットライト(S)のボタンを画像を変える組のモザイクの後ろに加えた(UI_quick-edits §1.1・§1.2)。

import {
  getCanvasState,
  subscribeCanvasState,
  toggleActiveTool,
  type ToolId,
} from "../canvas/canvasState";
import { isMaskSessionActive, subscribeMaskSession } from "../canvas/maskSession";
import { toolLabel, toolShortcutKey } from "./toolKeys";

/**
 * ツールの組(QE-T03、UI_quick-edits §1.1)。`annotate` = 描く注釈(選択中の色を使う)、
 * `image` = 画像そのものを変える(色を持たない)。
 */
export type ToolGroup = "annotate" | "image";

/** 組の並び(左から)。 */
export const TOOL_GROUP_ORDER: ReadonlyArray<ToolGroup> = ["annotate", "image"];

interface ToolDefinition {
  id: ToolId;
  group: ToolGroup;
  /** インラインSVGアイコン(`viewBox="0 0 20 20"` に統一、T19)。 */
  icon: string;
}

const TOOLS: ToolDefinition[] = [
  {
    id: "arrow",
    group: "annotate",
    icon:
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<path d="M4.5 15.5 14.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      '<path d="M8.5 5.5H14.5V11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>",
  },
  {
    id: "rectangle",
    group: "annotate",
    icon:
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<rect x="3.5" y="5" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      "</svg>",
  },
  {
    id: "ellipse",
    group: "annotate",
    icon:
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<ellipse cx="10" cy="10" rx="6.5" ry="5" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      "</svg>",
  },
  {
    id: "text",
    group: "annotate",
    icon:
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<path d="M4.5 5.5V4.5H15.5V5.5M10 4.5V15.5M7.5 15.5H12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>",
  },
  {
    // QE-T13: スタンプ(N)。丸の輪郭 + 数字の 1(UI_quick-edits §1.2)。描く注釈の組の最後。
    id: "stamp",
    group: "annotate",
    icon:
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      '<path d="M8.4 7.6 10.4 6.3V13.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>",
  },
  {
    id: "mosaic",
    group: "image",
    icon:
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor"/>' +
      '<rect x="11" y="3" width="6" height="6" rx="1" fill="currentColor" opacity="0.45"/>' +
      '<rect x="3" y="11" width="6" height="6" rx="1" fill="currentColor" opacity="0.45"/>' +
      '<rect x="11" y="11" width="6" height="6" rx="1" fill="currentColor"/>' +
      "</svg>",
  },
  {
    // QE-T16: スポットライト(S)。外側を薄く塗り、穴を輪郭で示す(UI_quick-edits §1.2)。モザイクの後ろ。
    id: "spotlight",
    group: "image",
    icon:
      '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
      '<path d="M2 3.5h16v13H2ZM5.5 7v6h9V7Z" fill="currentColor" fill-rule="evenodd" opacity="0.4"/>' +
      '<rect x="5.5" y="7" width="9" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      "</svg>",
  },
];

/** ツールボタンの並び(`TOOL_KEYS` との整合をテストで確かめる、QE-T02)。 */
export const TOOL_IDS: ReadonlyArray<ToolId> = TOOLS.map((tool) => tool.id);

/** ツールの組。 */
export function toolGroupOf(id: ToolId): ToolGroup {
  const tool = TOOLS.find((candidate) => candidate.id === id);
  if (!tool) {
    throw new Error(`TOOLS has no entry for tool: ${id}`);
  }
  return tool.group;
}

/** ツールバーに並べる項目(ツールか、組の区切り)。 */
export type ToolbarItem = ToolId | "divider";

/**
 * ツールの並びに組の区切りを入れた列(QE-T03)。組は `TOOL_GROUP_ORDER` の順に並べ、
 * ツールのある組の間にだけ区切りを 1 本入れる(先頭・末尾・空の組には入れない)。
 */
export function toolbarItems(): ToolbarItem[] {
  const items: ToolbarItem[] = [];
  for (const group of TOOL_GROUP_ORDER) {
    const ids = TOOLS.filter((tool) => tool.group === group).map((tool) => tool.id);
    if (ids.length === 0) {
      continue;
    }
    if (items.length > 0) {
      items.push("divider");
    }
    items.push(...ids);
  }
  return items;
}

/**
 * ツールボタンの名前・ツールチップ・キー(QE-T02、UI_quick-edits §1.3)。名前とキーは
 * `toolKeys.ts` の `TOOL_KEYS` 1 か所から組み立て、ボタンとキーの表示が食い違わないようにする。
 */
export function toolButtonAttributes(id: ToolId): {
  ariaLabel: string;
  title: string;
  ariaKeyShortcuts: string;
} {
  const label = toolLabel(id);
  return { ariaLabel: label, title: label, ariaKeyShortcuts: toolShortcutKey(id) };
}

export interface ToolButtonContext {
  activeTool: ToolId | null;
  isDrawing: boolean;
  /** 自動マスキングの処理中・確認中(`maskSession` が `idle` 以外、AM-T13・AM-T25-F1)。 */
  isMasking: boolean;
}

/** 今のストア(`canvasState`・`maskSession`)からボタンの文脈を組み立てる。 */
export function currentToolButtonContext(): ToolButtonContext {
  const { activeTool, isDrawing } = getCanvasState();
  return { activeTool, isDrawing, isMasking: isMaskSessionActive() };
}

/**
 * ツールボタン 1 つの押下・無効。描画中は選択中以外を、確認中は選択中も含めて全ボタンを無効に
 * する(確認中は押下状態を変えず、確認が終われば同じツールのまま続けられる)。
 */
export function toolButtonState(
  id: ToolId,
  context: ToolButtonContext,
): { pressed: boolean; disabled: boolean } {
  const pressed = context.activeTool === id;
  return { pressed, disabled: context.isMasking || (context.isDrawing && !pressed) };
}

/**
 * ツール切替UIを `mount` 配下に構築し、`canvasState` と結線する(Container相当)。
 * ボタンクリックで `toggleActiveTool()` を呼び、状態変化を購読して押下状態(`aria-pressed`)に
 * 反映する。描画中(`isDrawing`)は非アクティブなボタンを無効化し、ドラッグ中のツール切替を防ぐ。
 * 自動マスキングの処理中・確認中は全ボタンを無効化する(`maskSession` も購読する、AM-T13・AM-T25-F1)。
 */
export function initToolbar(mount: HTMLElement): void {
  const buttons = new Map<ToolId, HTMLButtonElement>();

  for (const item of toolbarItems()) {
    if (item === "divider") {
      const divider = document.createElement("div");
      divider.className = "tool-toolbar__divider";
      divider.setAttribute("aria-hidden", "true");
      mount.appendChild(divider);
      continue;
    }
    const tool = TOOLS.find((candidate) => candidate.id === item);
    if (!tool) {
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button tool-toolbar__button";
    button.innerHTML = tool.icon;
    button.setAttribute("aria-pressed", "false");
    const attributes = toolButtonAttributes(tool.id);
    button.setAttribute("aria-label", attributes.ariaLabel);
    button.setAttribute("aria-keyshortcuts", attributes.ariaKeyShortcuts);
    button.title = attributes.title;
    button.addEventListener("click", () => {
      toggleActiveTool(tool.id);
    });
    buttons.set(tool.id, button);
    mount.appendChild(button);
  }

  const render = (): void => {
    const context = currentToolButtonContext();
    for (const [id, button] of buttons) {
      const { pressed, disabled } = toolButtonState(id, context);
      button.setAttribute("aria-pressed", String(pressed));
      button.classList.toggle("tool-toolbar__button--active", pressed);
      button.disabled = disabled;
    }
  };

  subscribeCanvasState(render);
  subscribeMaskSession(render);
  render();
}
