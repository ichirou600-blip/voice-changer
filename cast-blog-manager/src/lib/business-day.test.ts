import { describe, expect, it } from "vitest";

import {
  addDays,
  businessWeekStart,
  currentBusinessDate,
  isValidBusinessDate,
  jstHour,
  parseBusinessDate,
  recentBusinessDates,
  toBusinessDate,
} from "./business-day";

describe("jstHour", () => {
  it("UTC を JST(+9) の時に変換する", () => {
    expect(jstHour(new Date("2026-07-27T20:59:00Z"))).toBe(5); // JST 7/28 05:59
    expect(jstHour(new Date("2026-07-27T21:00:00Z"))).toBe(6); // JST 7/28 06:00
    expect(jstHour(new Date("2026-07-28T15:00:00Z"))).toBe(0); // JST 7/29 00:00
  });
});

describe("toBusinessDate", () => {
  it("区切り時刻(6時)より前の深夜は前日の営業日になる", () => {
    // JST 7/28 05:59 → 営業日 7/27
    expect(toBusinessDate(new Date("2026-07-27T20:59:00Z"), 6)).toBe("2026-07-27");
    // JST 7/28 06:00 ちょうど → 営業日 7/28
    expect(toBusinessDate(new Date("2026-07-27T21:00:00Z"), 6)).toBe("2026-07-28");
  });

  it("JST 深夜 2 時の更新は前日の営業日として扱う", () => {
    // JST 7/29 02:00（= UTC 7/28 17:00）→ 営業日 7/28
    expect(toBusinessDate(new Date("2026-07-28T17:00:00Z"), 6)).toBe("2026-07-28");
  });

  it("区切り 0 時は JST のカレンダー日と一致する", () => {
    expect(toBusinessDate(new Date("2026-07-28T14:59:00Z"), 0)).toBe("2026-07-28"); // JST 23:59
    expect(toBusinessDate(new Date("2026-07-28T15:00:00Z"), 0)).toBe("2026-07-29"); // JST 00:00
  });

  it("月・年の境界をまたいでも正しい", () => {
    // JST 1/1 02:00（= UTC 12/31 17:00）→ 営業日は前年 12/31
    expect(toBusinessDate(new Date("2025-12-31T17:00:00Z"), 6)).toBe("2025-12-31");
    // JST 8/1 03:00 → 営業日 7/31
    expect(toBusinessDate(new Date("2026-07-31T18:00:00Z"), 6)).toBe("2026-07-31");
  });

  it("不正な区切り時刻は拒否する", () => {
    expect(() => toBusinessDate(new Date(), -1)).toThrow(RangeError);
    expect(() => toBusinessDate(new Date(), 24)).toThrow(RangeError);
    expect(() => toBusinessDate(new Date(), 6.5)).toThrow(RangeError);
  });
});

describe("parseBusinessDate / isValidBusinessDate", () => {
  it("正しい日付をパースできる", () => {
    expect(parseBusinessDate("2026-07-28").toISOString()).toBe("2026-07-28T00:00:00.000Z");
  });

  it("形式違反・実在しない日付を拒否する", () => {
    expect(() => parseBusinessDate("2026/07/28")).toThrow(RangeError);
    expect(() => parseBusinessDate("2026-7-28")).toThrow(RangeError);
    expect(() => parseBusinessDate("2026-02-30")).toThrow(RangeError);
    expect(() => parseBusinessDate("2026-13-01")).toThrow(RangeError);
    expect(isValidBusinessDate("2026-02-28")).toBe(true);
    expect(isValidBusinessDate("2026-02-30")).toBe(false);
  });

  it("うるう年を正しく扱う", () => {
    expect(isValidBusinessDate("2028-02-29")).toBe(true); // 2028 はうるう年
    expect(isValidBusinessDate("2026-02-29")).toBe(false); // 2026 は平年
  });
});

describe("businessWeekStart（月曜はじまり固定）", () => {
  it("月曜はその日自身を返す", () => {
    expect(businessWeekStart("2026-07-27")).toBe("2026-07-27"); // 月曜
  });

  it("火〜日は直前の月曜を返す", () => {
    expect(businessWeekStart("2026-07-28")).toBe("2026-07-27"); // 火曜
    expect(businessWeekStart("2026-08-01")).toBe("2026-07-27"); // 土曜（月またぎ）
    expect(businessWeekStart("2026-08-02")).toBe("2026-07-27"); // 日曜
    expect(businessWeekStart("2026-08-03")).toBe("2026-08-03"); // 翌月曜
  });

  it("年をまたぐ週も正しい", () => {
    // 2027-01-01 は金曜 → 週開始は 2026-12-28（月曜）
    expect(businessWeekStart("2027-01-01")).toBe("2026-12-28");
  });
});

describe("addDays", () => {
  it("加算・減算・月またぎ", () => {
    expect(addDays("2026-07-28", 1)).toBe("2026-07-29");
    expect(addDays("2026-07-28", -1)).toBe("2026-07-27");
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("整数以外は拒否する", () => {
    expect(() => addDays("2026-07-28", 0.5)).toThrow(RangeError);
  });
});

describe("recentBusinessDates", () => {
  it("指定日を含む直近 n 日を新しい順に返す", () => {
    expect(recentBusinessDates("2026-07-28", 1)).toEqual(["2026-07-28"]);
    expect(recentBusinessDates("2026-07-28", 2)).toEqual(["2026-07-28", "2026-07-27"]);
    expect(recentBusinessDates("2026-08-01", 3)).toEqual([
      "2026-08-01",
      "2026-07-31",
      "2026-07-30",
    ]);
  });

  it("0 以下は拒否する", () => {
    expect(() => recentBusinessDates("2026-07-28", 0)).toThrow(RangeError);
  });
});

describe("currentBusinessDate", () => {
  it("now を明示指定して算出できる（cron tick での利用形）", () => {
    // JST 7/28 04:00（= UTC 7/27 19:00）・区切り6時 → 営業日 7/27
    expect(currentBusinessDate(6, new Date("2026-07-27T19:00:00Z"))).toBe("2026-07-27");
  });
});
