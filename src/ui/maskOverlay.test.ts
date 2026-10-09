import { describe, expect, it } from "vitest";

import type { MaskCandidate, MaskKind } from "../canvas/maskSession";
import {
  labelSide,
  markPressed,
  markTitle,
  maskKindView,
  sortMarksForTabOrder,
  toPercentRect,
} from "./maskOverlay";

function candidate(
  id: number,
  rect: { x: number; y: number; width: number; height: number },
  kind: MaskKind = "contact",
  excluded = false,
): MaskCandidate {
  return { id, rect, kind, excluded };
}

describe("toPercentRect(画素の矩形 → % の left/top/width/height)", () => {
  it("画像の大きさに対する比率を % で返す", () => {
    expect(toPercentRect({ x: 100, y: 50, width: 200, height: 25 }, { width: 1000, height: 500 })).toEqual({
      left: 10,
      top: 10,
      width: 20,
      height: 5,
    });
  });

  it("画像の右下の端に接する候補は 100% ちょうどに収まる", () => {
    const p = toPercentRect({ x: 900, y: 450, width: 100, height: 50 }, { width: 1000, height: 500 });
    expect(p.left + p.width).toBe(100);
    expect(p.top + p.height).toBe(100);
  });

  it("画像の端からはみ出す候補は 100% を超えないよう切り詰める", () => {
    const p = toPercentRect({ x: 950, y: 480, width: 100, height: 50 }, { width: 1000, height: 500 });
    expect(p.left).toBe(95);
    expect(p.top).toBe(96);
    expect(p.left + p.width).toBeLessThanOrEqual(100);
    expect(p.top + p.height).toBeLessThanOrEqual(100);
    expect(p.width).toBe(5);
    expect(p.height).toBe(4);
  });

  it("負の座標は 0% に収め、幅を減らす", () => {
    const p = toPercentRect({ x: -10, y: -5, width: 110, height: 55 }, { width: 1000, height: 500 });
    expect(p).toEqual({ left: 0, top: 0, width: 10, height: 10 });
  });

  it("画像の外にある候補・画像の大きさが 0 のときは幅・高さ 0 を返す(NaN を出さない)", () => {
    expect(toPercentRect({ x: 1200, y: 10, width: 10, height: 10 }, { width: 1000, height: 500 })).toEqual({
      left: 100,
      top: 2,
      width: 0,
      height: 2,
    });
    expect(toPercentRect({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("maskKindView(種類 → ラベル文言・CSS クラス・aria-label)", () => {
  it.each([
    ["contact", "連絡先", "mask-mark--contact", "連絡先の候補"],
    ["credential", "認証情報", "mask-mark--credential", "認証情報の候補"],
    ["identifier", "識別子", "mask-mark--identifier", "識別子の候補"],
    ["financial", "金額・口座", "mask-mark--financial", "金額・口座の候補"],
  ] as const)("%s → %s", (kind, label, className, ariaLabel) => {
    expect(maskKindView(kind)).toEqual({ label, className, ariaLabel });
  });

  it("文言に禁止語(NFR-005)を含まない", () => {
    const kinds: MaskKind[] = ["contact", "credential", "identifier", "financial"];
    const texts = kinds.flatMap((k) => [maskKindView(k).label, maskKindView(k).ariaLabel]);
    texts.push(markTitle(candidate(0, { x: 0, y: 0, width: 1, height: 1 })));
    texts.push(markTitle(candidate(0, { x: 0, y: 0, width: 1, height: 1 }, "contact", true)));
    for (const text of texts) {
      expect(text).not.toMatch(/安全|すべて隠|機密はありません|自動で隠/);
    }
  });
});

describe("markPressed / markTitle(外す/戻すの状態)", () => {
  it("残っている候補は aria-pressed=true、ツールチップは「クリックで外す」", () => {
    const c = candidate(1, { x: 0, y: 0, width: 10, height: 10 });
    expect(markPressed(c)).toBe("true");
    expect(markTitle(c)).toBe("クリックで外す");
  });

  it("外した候補は aria-pressed=false、ツールチップは「クリックで戻す」", () => {
    const c = candidate(1, { x: 0, y: 0, width: 10, height: 10 }, "credential", true);
    expect(markPressed(c)).toBe("false");
    expect(markTitle(c)).toBe("クリックで戻す");
  });
});

describe("labelSide(ラベルを右/左のどちらに置くか)", () => {
  const rect = { x: 100, y: 100, width: 50, height: 20 };

  it("右に置けるなら end", () => {
    expect(labelSide(rect, [], 1000, 40)).toBe("end");
  });

  it("右に置くと画像の右端からはみ出すなら start", () => {
    expect(labelSide({ x: 900, y: 100, width: 80, height: 20 }, [], 1000, 40)).toBe("start");
  });

  it("右端にちょうど収まるなら end", () => {
    expect(labelSide({ x: 900, y: 100, width: 60, height: 20 }, [], 1000, 40)).toBe("end");
  });

  it("右に別の印があり重なるなら start", () => {
    const right = { x: 160, y: 100, width: 50, height: 20 };
    expect(labelSide(rect, [right], 1000, 40)).toBe("start");
  });

  it("右の印が縦にずれて重ならないなら end", () => {
    const right = { x: 160, y: 130, width: 50, height: 20 };
    expect(labelSide(rect, [right], 1000, 40)).toBe("end");
  });

  it("右の印がラベルより遠ければ end(接するだけは重なりとしない)", () => {
    const right = { x: 190, y: 100, width: 50, height: 20 };
    expect(labelSide(rect, [right], 1000, 40)).toBe("end");
  });

  it("左右どちらも重なるときは end", () => {
    const right = { x: 160, y: 100, width: 50, height: 20 };
    const left = { x: 40, y: 100, width: 50, height: 20 };
    expect(labelSide(rect, [left, right], 1000, 40)).toBe("end");
  });

  it("右がはみ出し、左は画像の左端からはみ出すときは end", () => {
    expect(labelSide({ x: 10, y: 0, width: 980, height: 20 }, [], 1000, 40)).toBe("end");
  });

  it("右に印があり、左は画像の左端からはみ出すときは end", () => {
    const right = { x: 60, y: 0, width: 50, height: 20 };
    expect(labelSide({ x: 10, y: 0, width: 40, height: 20 }, [right], 1000, 40)).toBe("end");
  });
});

describe("sortMarksForTabOrder(Tab の順: 上から下、同じ行は左から右)", () => {
  it("y の小さい順、同じ y なら x の小さい順に並べ、入力を変えない", () => {
    const a = candidate(0, { x: 300, y: 50, width: 10, height: 10 });
    const b = candidate(1, { x: 100, y: 50, width: 10, height: 10 });
    const c = candidate(2, { x: 0, y: 10, width: 10, height: 10 });
    const input = [a, b, c];
    expect(sortMarksForTabOrder(input).map((m) => m.id)).toEqual([2, 1, 0]);
    expect(input.map((m) => m.id)).toEqual([0, 1, 2]);
  });
});
