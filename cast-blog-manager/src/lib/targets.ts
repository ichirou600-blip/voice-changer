/**
 * 週次目標（CastTarget）の解決ロジック。
 *
 * 設計ルール（docs/DESIGN.md 決定8）:
 * - 目標は履歴として積み上げ、過去週の達成判定を書き換えない
 * - ある週に適用される目標は「effectiveFrom <= その週の開始日（月曜）」を
 *   満たすもののうち最も新しい effectiveFrom のもの
 * - 週の途中で目標を変更しても、その週の判定は変わらない
 *   （変更は次に開始する週から適用される）
 */

import { businessWeekStart, isValidBusinessDate } from "./business-day";

export type TargetHistoryEntry = {
  postsPerWeek: number;
  /** "YYYY-MM-DD"（営業日） */
  effectiveFrom: string;
};

/**
 * 指定した週（weekStart = 月曜の営業日）に適用される週次目標を返す。
 * 適用対象が無い場合（その週より前の目標が未設定）は null を返す。
 */
export function resolveTargetForWeek(
  targets: readonly TargetHistoryEntry[],
  weekStart: string,
): number | null {
  if (!isValidBusinessDate(weekStart)) {
    throw new RangeError(`weekStart は "YYYY-MM-DD" 形式で指定してください: ${weekStart}`);
  }

  let applicable: TargetHistoryEntry | null = null;
  for (const t of targets) {
    if (!isValidBusinessDate(t.effectiveFrom)) {
      throw new RangeError(`effectiveFrom が不正です: ${t.effectiveFrom}`);
    }
    // 文字列 "YYYY-MM-DD" は辞書順比較がそのまま日付順比較になる
    if (t.effectiveFrom <= weekStart) {
      if (applicable === null || t.effectiveFrom > applicable.effectiveFrom) {
        applicable = t;
      }
    }
  }

  return applicable?.postsPerWeek ?? null;
}

/**
 * 営業日を含む週に適用される目標を返す（weekStart への変換込みの糖衣）。
 */
export function resolveTargetForBusinessDate(
  targets: readonly TargetHistoryEntry[],
  businessDate: string,
): number | null {
  return resolveTargetForWeek(targets, businessWeekStart(businessDate));
}

export type WeeklyProgress = {
  weekStart: string;
  postCount: number;
  target: number | null;
  /** 目標未設定のときは null（達成/未達を判定しない） */
  achieved: boolean | null;
  /** 目標までの残り回数。目標未設定または達成済みは 0 */
  remaining: number;
};

/**
 * 週次の達成状況を組み立てる。
 * postCount は「無効化されていない BlogPost」の件数を渡すこと。
 */
export function buildWeeklyProgress(
  targets: readonly TargetHistoryEntry[],
  weekStart: string,
  postCount: number,
): WeeklyProgress {
  if (!Number.isInteger(postCount) || postCount < 0) {
    throw new RangeError(`postCount は 0 以上の整数で指定してください: ${postCount}`);
  }
  const target = resolveTargetForWeek(targets, weekStart);
  return {
    weekStart,
    postCount,
    target,
    achieved: target === null ? null : postCount >= target,
    remaining: target === null ? 0 : Math.max(0, target - postCount),
  };
}
