import { describe, expect, it } from "vitest";

import { buildWeeklyProgress, resolveTargetForBusinessDate, resolveTargetForWeek } from "./targets";

const history = [
  { postsPerWeek: 3, effectiveFrom: "2026-07-06" },
  { postsPerWeek: 5, effectiveFrom: "2026-08-03" },
];

describe("resolveTargetForWeek", () => {
  it("適用対象が無い週は null", () => {
    expect(resolveTargetForWeek(history, "2026-06-29")).toBeNull();
    expect(resolveTargetForWeek([], "2026-07-27")).toBeNull();
  });

  it("effectiveFrom ちょうどの週から適用される", () => {
    expect(resolveTargetForWeek(history, "2026-07-06")).toBe(3);
    expect(resolveTargetForWeek(history, "2026-08-03")).toBe(5);
  });

  it("最も新しい適用可能な目標を選ぶ", () => {
    expect(resolveTargetForWeek(history, "2026-07-27")).toBe(3); // 変更前
    expect(resolveTargetForWeek(history, "2026-08-10")).toBe(5); // 変更後
  });

  it("履歴の順序に依存しない", () => {
    const shuffled = [...history].reverse();
    expect(resolveTargetForWeek(shuffled, "2026-07-27")).toBe(3);
    expect(resolveTargetForWeek(shuffled, "2026-08-10")).toBe(5);
  });

  it("週の途中で目標を変えても、その週の判定は変わらない（過去週の保全）", () => {
    // 2026-07-29（水）に目標変更を登録した場合
    const midWeekChange = [
      { postsPerWeek: 3, effectiveFrom: "2026-07-06" },
      { postsPerWeek: 10, effectiveFrom: "2026-07-29" },
    ];
    // 当該週（開始 2026-07-27）はまだ旧目標 3 のまま
    expect(resolveTargetForWeek(midWeekChange, "2026-07-27")).toBe(3);
    // 次の週から新目標 10 が適用される
    expect(resolveTargetForWeek(midWeekChange, "2026-08-03")).toBe(10);
  });

  it("不正な日付を拒否する", () => {
    expect(() => resolveTargetForWeek(history, "2026/07/27")).toThrow(RangeError);
    expect(() => resolveTargetForWeek([{ postsPerWeek: 1, effectiveFrom: "bad" }], "2026-07-27")).toThrow(
      RangeError,
    );
  });
});

describe("resolveTargetForBusinessDate", () => {
  it("営業日から週を導いて目標を解決する", () => {
    // 2026-07-30（木）は週開始 2026-07-27 → 目標 3
    expect(resolveTargetForBusinessDate(history, "2026-07-30")).toBe(3);
    // 2026-08-05（水）は週開始 2026-08-03 → 目標 5
    expect(resolveTargetForBusinessDate(history, "2026-08-05")).toBe(5);
  });
});

describe("buildWeeklyProgress", () => {
  it("未達の週", () => {
    expect(buildWeeklyProgress(history, "2026-07-27", 1)).toEqual({
      weekStart: "2026-07-27",
      postCount: 1,
      target: 3,
      achieved: false,
      remaining: 2,
    });
  });

  it("達成した週（超過分は remaining 0）", () => {
    expect(buildWeeklyProgress(history, "2026-07-27", 4)).toMatchObject({
      achieved: true,
      remaining: 0,
    });
  });

  it("目標未設定の週は達成判定しない", () => {
    expect(buildWeeklyProgress(history, "2026-06-29", 2)).toMatchObject({
      target: null,
      achieved: null,
      remaining: 0,
    });
  });

  it("負の件数は拒否する", () => {
    expect(() => buildWeeklyProgress(history, "2026-07-27", -1)).toThrow(RangeError);
  });
});
