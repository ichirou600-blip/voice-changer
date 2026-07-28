/**
 * 営業日（businessDate）計算ユーティリティ
 *
 * ナイトラウンジは深夜〜早朝営業で日付をまたぐため、
 * 「カレンダー日」ではなく店舗ごとの区切り時刻（既定: 朝6時 JST）で
 * 区切った「営業日」を集計の基準にする。
 *
 * 設計ルール:
 * - 営業日は "YYYY-MM-DD" 形式の文字列として扱う（TZ 混入の余地を残さない）
 * - タイムゾーンは JST（UTC+9、サマータイムなし）固定
 * - 日付計算は必ずこのモジュールを経由する（アプリ内で独自に日付演算をしない）
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Date の UTC 成分を "YYYY-MM-DD" に整形する */
function formatUtcDate(d: Date): string {
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function assertHour(hour: number, label: string): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`${label} は 0〜23 の整数で指定してください: ${hour}`);
  }
}

/** 与えた時刻の JST での「時」(0-23) を返す */
export function jstHour(date: Date): number {
  return new Date(date.getTime() + JST_OFFSET_MS).getUTCHours();
}

/**
 * 時刻を営業日 "YYYY-MM-DD" に変換する。
 *
 * JST に変換したうえで、businessDayStart（区切り時刻）より前なら前日の営業日とする。
 * 例: businessDayStart=6 のとき、JST 7/28 05:59 → "2026-07-27"、JST 7/28 06:00 → "2026-07-28"
 */
export function toBusinessDate(date: Date, businessDayStart: number): string {
  assertHour(businessDayStart, "businessDayStart");
  let shifted = new Date(date.getTime() + JST_OFFSET_MS);
  if (shifted.getUTCHours() < businessDayStart) {
    shifted = new Date(shifted.getTime() - DAY_MS);
  }
  return formatUtcDate(shifted);
}

/**
 * "YYYY-MM-DD" を検証して UTC 深夜0時の Date として返す。
 * 実在しない日付（例: 2026-02-30）は不正として扱う。
 */
export function parseBusinessDate(businessDate: string): Date {
  if (!BUSINESS_DATE_RE.test(businessDate)) {
    throw new RangeError(`営業日は "YYYY-MM-DD" 形式で指定してください: ${businessDate}`);
  }
  const [y, m, d] = businessDate.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (formatUtcDate(parsed) !== businessDate) {
    throw new RangeError(`実在しない日付です: ${businessDate}`);
  }
  return parsed;
}

/** 営業日文字列として妥当かどうか */
export function isValidBusinessDate(businessDate: string): boolean {
  try {
    parseBusinessDate(businessDate);
    return true;
  } catch {
    return false;
  }
}

/**
 * 営業日が属する「週の開始日（月曜）」を "YYYY-MM-DD" で返す。
 * 週は月曜はじまり固定（アプリ全体で共通）。
 */
export function businessWeekStart(businessDate: string): string {
  const d = parseBusinessDate(businessDate);
  const daysFromMonday = (d.getUTCDay() + 6) % 7; // 月=0, 火=1, ..., 日=6
  return formatUtcDate(new Date(d.getTime() - daysFromMonday * DAY_MS));
}

/** 営業日に日数を加算（負数で減算）した営業日を返す */
export function addDays(businessDate: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new RangeError(`days は整数で指定してください: ${days}`);
  }
  const d = parseBusinessDate(businessDate);
  return formatUtcDate(new Date(d.getTime() + days * DAY_MS));
}

/**
 * 指定営業日を含む直近 count 日分の営業日リストを新しい順に返す。
 * 例: recentBusinessDates("2026-07-28", 2) → ["2026-07-28", "2026-07-27"]
 * リマインド対象判定（直近 n 営業日に更新が無い）に使う。
 */
export function recentBusinessDates(businessDate: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`count は 1 以上の整数で指定してください: ${count}`);
  }
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    result.push(addDays(businessDate, -i));
  }
  return result;
}

/**
 * 現時刻・店舗設定から「今の営業日」を返すショートカット。
 * cron tick や記録 API での利用を想定。
 */
export function currentBusinessDate(businessDayStart: number, now: Date = new Date()): string {
  return toBusinessDate(now, businessDayStart);
}
