//! 矢印・矩形・円・テキスト共通の現在色・フォントサイズ段階の状態(ARCH §5.1・§6.1、
//! PRD FR-013、T21【新設 2026-09-24】)。
//!
//! `canvasState.ts`(ARCH §1.3 決定#1)と同じ作法(純粋関数 + モジュール単位の薄い
//! シングルトンストア)で実装する。モザイクは色の概念を持たないため本ストアを参照しない
//! (ARCH §5.2・§6.3、FR-013受け入れ基準)。メモリ上のみで永続化しない(ARCH §6.2)。

/** プリセット色見本・カラーピッカー共通の既定色(PRD §5、FR-013)。 */
export const DEFAULT_COLOR = "#FF5C8A";
/** テキストツールのフォントサイズ既定値(T21で「中」に確定、PRD §5「既定値は実装時に確定」)。 */
export const DEFAULT_FONT_SIZE: FontSize = "medium";

/** テキストのフォントサイズ段階(PRD §5、FR-012・FR-013)。 */
export type FontSize = "small" | "medium" | "large";

export interface ToolSettings {
  /** `#RRGGBB` 形式の色コード(FR-013)。 */
  color: string;
  fontSize: FontSize;
}

/** 既定色・既定フォントサイズの初期状態を返す純粋関数。 */
export function createToolSettings(): ToolSettings {
  return { color: DEFAULT_COLOR, fontSize: DEFAULT_FONT_SIZE };
}

/** 色をセットした新しい状態を返す純粋関数(イミュータブル)。 */
export function withColor(state: ToolSettings, color: string): ToolSettings {
  return { ...state, color };
}

/** フォントサイズをセットした新しい状態を返す純粋関数(イミュータブル)。 */
export function withFontSize(
  state: ToolSettings,
  fontSize: FontSize,
): ToolSettings {
  return { ...state, fontSize };
}

/**
 * `#RRGGBB` 形式(16進数6桁、大文字・小文字いずれも可)かを判定する純粋関数
 * (PRD §8「色コード(`#RRGGBB`)の妥当性判定」テスト対象)。将来UI(T28の自由入力欄等)が
 * 呼び出す想定で、`setColor()` 自体はこの検証をゲートしない(プリセット・ネイティブ
 * カラーピッカーはいずれも常に正しい形式を渡すため、本ストア内部での強制は行わない)。
 */
export function isValidColorCode(value: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(value);
}

type Listener = (state: ToolSettings) => void;

let state: ToolSettings = createToolSettings();
const listeners = new Set<Listener>();

/** 現在の状態を返す(`canvas/tools/*` `ui/colorPicker.ts` 等が読み取り用に参照する)。 */
export function getToolSettings(): ToolSettings {
  return state;
}

/** 色をセットし、購読者へ通知する(`ui/colorPicker.ts` から呼ぶ想定、T28)。 */
export function setColor(color: string): void {
  state = withColor(state, color);
  notify();
}

/** フォントサイズをセットし、購読者へ通知する(`ui/fontSizePicker.ts` から呼ぶ想定、T28)。 */
export function setFontSize(fontSize: FontSize): void {
  state = withFontSize(state, fontSize);
  notify();
}

/** 状態変化を購読する。戻り値の関数を呼ぶと購読解除する。 */
export function subscribeToolSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) {
    listener(state);
  }
}
