import "server-only";

import { storeScope } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { businessWeekStart, currentBusinessDate, recentBusinessDates } from "@/lib/business-day";
import { prisma } from "@/lib/prisma";
import { isStale } from "@/lib/reminder-policy";
import { buildWeeklyProgress, type WeeklyProgress } from "@/lib/targets";

import { notVoided } from "./posts";

/**
 * ダッシュボード用の集計。
 * 集計は必ず営業日（businessDate / businessWeekStart）基準で行う。
 */

export type CastStatus = {
  castId: string;
  castName: string;
  storeId: string;
  storeName: string;
  lineStatus: "NOT_LINKED" | "LINKED" | "BLOCKED";
  /** 最後に更新した営業日（無ければ null） */
  lastPostBusinessDate: string | null;
  /** 直近しきい値日数のあいだ更新が無い＝リマインド対象 */
  stale: boolean;
  progress: WeeklyProgress;
};

export type DashboardData = {
  /** 集計に使った営業日（店舗ごとに区切りが違うため代表値） */
  businessDate: string;
  weekStart: string;
  casts: CastStatus[];
  totals: { active: number; stale: number; achieved: number; withTarget: number };
};

export async function getDashboard(
  user: SessionUser,
  now: Date = new Date(),
): Promise<DashboardData> {
  const casts = await prisma.cast.findMany({
    where: { ...storeScope(user), status: "ACTIVE" },
    include: {
      store: true,
      targets: { orderBy: { effectiveFrom: "desc" } },
    },
    orderBy: { name: "asc" },
  });

  if (casts.length === 0) {
    const fallbackDate = currentBusinessDate(6, now);
    return {
      businessDate: fallbackDate,
      weekStart: businessWeekStart(fallbackDate),
      casts: [],
      totals: { active: 0, stale: 0, achieved: 0, withTarget: 0 },
    };
  }

  // 代表の営業日表示（店舗が複数ある場合は最初の店舗の設定を使う）
  const representativeDate = currentBusinessDate(casts[0].store.businessDayStart, now);
  const representativeWeek = businessWeekStart(representativeDate);

  const castIds = casts.map((c) => c.id);

  // 今週の投稿件数（有効なもののみ）をキャスト別に集計
  const weeklyCounts = await prisma.blogPost.groupBy({
    by: ["castId"],
    where: {
      castId: { in: castIds },
      businessWeekStart: representativeWeek,
      ...notVoided,
    },
    _count: { _all: true },
  });
  const weeklyCountMap = new Map(weeklyCounts.map((r) => [r.castId, r._count._all]));

  // 直近の更新営業日と、しきい値判定に使う日付集合を取得
  const maxThreshold = Math.max(...casts.map((c) => c.store.daysStaleThreshold), 1);
  const lookbackDates = recentBusinessDates(representativeDate, maxThreshold);
  const recentPosts = await prisma.blogPost.findMany({
    where: { castId: { in: castIds }, businessDate: { in: lookbackDates }, ...notVoided },
    select: { castId: true, businessDate: true },
  });
  const recentByCast = new Map<string, Set<string>>();
  for (const p of recentPosts) {
    if (!recentByCast.has(p.castId)) recentByCast.set(p.castId, new Set());
    recentByCast.get(p.castId)!.add(p.businessDate);
  }

  const latestPosts = await prisma.blogPost.findMany({
    where: { castId: { in: castIds }, ...notVoided },
    select: { castId: true, businessDate: true },
    orderBy: { businessDate: "desc" },
  });
  const lastPostMap = new Map<string, string>();
  for (const p of latestPosts) {
    if (!lastPostMap.has(p.castId)) lastPostMap.set(p.castId, p.businessDate);
  }

  const result: CastStatus[] = casts.map((cast) => {
    const storeToday = currentBusinessDate(cast.store.businessDayStart, now);
    const weekStart = businessWeekStart(storeToday);
    const progress = buildWeeklyProgress(
      cast.targets,
      weekStart,
      weeklyCountMap.get(cast.id) ?? 0,
    );
    return {
      castId: cast.id,
      castName: cast.name,
      storeId: cast.storeId,
      storeName: cast.store.name,
      lineStatus: cast.lineStatus,
      lastPostBusinessDate: lastPostMap.get(cast.id) ?? null,
      stale: isStale(
        storeToday,
        cast.store.daysStaleThreshold,
        recentByCast.get(cast.id) ?? new Set(),
      ),
      progress,
    };
  });

  return {
    businessDate: representativeDate,
    weekStart: representativeWeek,
    casts: result,
    totals: {
      active: result.length,
      stale: result.filter((c) => c.stale).length,
      achieved: result.filter((c) => c.progress.achieved === true).length,
      withTarget: result.filter((c) => c.progress.target !== null).length,
    },
  };
}
