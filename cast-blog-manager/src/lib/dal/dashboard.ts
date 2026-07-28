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
 *
 * 実装レビューでの指摘:
 * 「代表の1店舗から営業日・週を決めて DB を引いているのに、
 *   集計時はキャストごとに別の営業日を再計算していた。
 *   区切り時刻の異なる店舗が2つ以上あると、
 *   別の週の件数を突き合わせてしまい数字が壊れる。
 *   しかも代表店舗はキャストの名前順で決まるため、
 *   キャストを1人追加しただけで全店舗の数字が入れ替わりうる」
 * → **店舗ごとにグループ化し、その店舗の営業日・週で引く**ように変更した。
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
  /** 表示用の代表営業日（閲覧者の所属店舗、無ければ最初の店舗） */
  businessDate: string;
  weekStart: string;
  /** 店舗ごとに区切り時刻が異なる場合に true（表示の注記に使う） */
  mixedBusinessDays: boolean;
  casts: CastStatus[];
  totals: { active: number; stale: number; achieved: number; withTarget: number };
};

export async function getDashboard(
  user: SessionUser,
  now: Date = new Date(),
): Promise<DashboardData> {
  const stores = await prisma.store.findMany({
    where: user.role === "ADMIN" ? {} : { id: storeScope(user).storeId },
    include: {
      casts: {
        where: { status: "ACTIVE" },
        orderBy: { name: "asc" },
        include: { targets: { orderBy: { effectiveFrom: "desc" } } },
      },
    },
    orderBy: { name: "asc" },
  });

  const result: CastStatus[] = [];

  // 店舗ごとに、その店舗の営業日・週で集計する
  for (const store of stores) {
    if (store.casts.length === 0) continue;

    const today = currentBusinessDate(store.businessDayStart, now);
    const weekStart = businessWeekStart(today);
    const window = recentBusinessDates(today, store.daysStaleThreshold);
    const castIds = store.casts.map((c) => c.id);

    const [weeklyCounts, recentPosts, lastPosts] = await Promise.all([
      prisma.blogPost.groupBy({
        by: ["castId"],
        where: { castId: { in: castIds }, businessWeekStart: weekStart, ...notVoided },
        _count: { _all: true },
      }),
      prisma.blogPost.findMany({
        where: { castId: { in: castIds }, businessDate: { in: window }, ...notVoided },
        select: { castId: true, businessDate: true },
      }),
      // 最終更新日は集計関数で取る（全件ロードすると記録が増え続けるほど重くなる）
      prisma.blogPost.groupBy({
        by: ["castId"],
        where: { castId: { in: castIds }, ...notVoided },
        _max: { businessDate: true },
      }),
    ]);

    const weeklyCountMap = new Map(weeklyCounts.map((r) => [r.castId, r._count._all]));
    const lastPostMap = new Map(lastPosts.map((r) => [r.castId, r._max.businessDate ?? null]));
    const recentByCast = new Map<string, Set<string>>();
    for (const p of recentPosts) {
      if (!recentByCast.has(p.castId)) recentByCast.set(p.castId, new Set());
      recentByCast.get(p.castId)!.add(p.businessDate);
    }

    for (const cast of store.casts) {
      result.push({
        castId: cast.id,
        castName: cast.name,
        storeId: store.id,
        storeName: store.name,
        lineStatus: cast.lineStatus,
        lastPostBusinessDate: lastPostMap.get(cast.id) ?? null,
        stale: isStale(
          today,
          store.daysStaleThreshold,
          recentByCast.get(cast.id) ?? new Set(),
        ),
        progress: buildWeeklyProgress(cast.targets, weekStart, weeklyCountMap.get(cast.id) ?? 0),
      });
    }
  }

  // 表示用の代表営業日は「閲覧者の所属店舗」を優先する
  const viewerStore = stores.find((s) => s.id === user.storeId) ?? stores[0];
  const representativeDate = currentBusinessDate(viewerStore?.businessDayStart ?? 6, now);

  return {
    businessDate: representativeDate,
    weekStart: businessWeekStart(representativeDate),
    mixedBusinessDays: new Set(stores.map((s) => s.businessDayStart)).size > 1,
    casts: result,
    totals: {
      active: result.length,
      stale: result.filter((c) => c.stale).length,
      achieved: result.filter((c) => c.progress.achieved === true).length,
      withTarget: result.filter((c) => c.progress.target !== null).length,
    },
  };
}
