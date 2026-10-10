import { describe, expect, it } from "vitest";

import {
  SHRINK_COPY_SAVE_FAILED_TEXT,
  shrinkCopyViewAfterLoad,
  shrinkCopyViewAfterSave,
} from "./settingsDialog";

describe("shrinkCopyViewAfterSave(縮めてコピーの保存の結果、QE-T09)", () => {
  it("保存に成功したら、保存後の値をチェックに出し、状態の文は出さない", () => {
    expect(shrinkCopyViewAfterSave(false, { kind: "saved", enabled: true })).toEqual({
      checked: true,
      status: "",
    });
    expect(shrinkCopyViewAfterSave(true, { kind: "saved", enabled: false })).toEqual({
      checked: false,
      status: "",
    });
  });

  it("保存後の値が頼んだ値と違っても、保存後の値(実際の設定)を出す", () => {
    expect(shrinkCopyViewAfterSave(false, { kind: "saved", enabled: false })).toEqual({
      checked: false,
      status: "",
    });
  });

  it("保存に失敗したら、チェックを元の値に戻して失敗の文を出す", () => {
    expect(shrinkCopyViewAfterSave(false, { kind: "failed" })).toEqual({
      checked: false,
      status: SHRINK_COPY_SAVE_FAILED_TEXT,
    });
    expect(shrinkCopyViewAfterSave(true, { kind: "failed" })).toEqual({
      checked: true,
      status: SHRINK_COPY_SAVE_FAILED_TEXT,
    });
  });

  it("失敗の文は UI 仕様の文言どおり", () => {
    expect(SHRINK_COPY_SAVE_FAILED_TEXT).toBe("保存できませんでした。元の設定のままです。");
  });
});

describe("shrinkCopyViewAfterLoad(開いたときの読み直し、QE-T09)", () => {
  it("読めた値をそのままチェックに出す", () => {
    expect(shrinkCopyViewAfterLoad({ kind: "loaded", enabled: true })).toEqual({ checked: true, status: "" });
    expect(shrinkCopyViewAfterLoad({ kind: "loaded", enabled: false })).toEqual({ checked: false, status: "" });
  });

  it("読み込みに失敗したらオフとして出し、状態の文は出さない(既定のオフと同じ扱い)", () => {
    expect(shrinkCopyViewAfterLoad({ kind: "failed" })).toEqual({ checked: false, status: "" });
  });
});
