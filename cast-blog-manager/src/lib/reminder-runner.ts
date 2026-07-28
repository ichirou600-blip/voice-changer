import "server-only";

import { businessWeekStart, currentBusinessDate, recentBusinessDates } from "@/lib/business-day";
import { notVoided } from "@/lib/dal/posts";
import { pushMessage, textMessage } from "@/lib/line/client";
import { prisma } from "@/lib/prisma";
import { countMonthlySent, getMonthlyLimit } from "@/lib/quota";
import {
  decideSend,
  isReminderTimeReached,
  isStale,
  MAX_SEND_ATTEMPTS,
  type SendDecision,
} from "@/lib/reminder-policy";
import { buildWeeklyProgress } from "@/lib/targets";

/**
 * リマインド送信の本体。トリガー（GitHub Actions / Vercel Cron / 手動）非依存。
 *
 * 重要な性質:
 * - **キャッチアップ型**: 送信時刻に到達済みなら送る。
 *   スケジューラが遅延・スキップしても、その営業日のうちに走れば取りこぼさない。
 * - **CAS による claim**: 実装レビューで「upsert しただけでは行ロックにならず、
 *   複数インスタンスが同時に走ると両方が PENDING を読んで二重送信する」と指摘された。
 *   → `updateMany` の where に「現在の attemptCount」を含めた**条件付き更新**にし、
 *     更新できた1プロセスだけが送信する。
 * - **クラッシュ回収**: SENDING のまま残った行は STALE_SENDING_MS 経過後に再取得できる。
 * - **月間上限**: 送信のたびに DB から実数を読み直す（プロセス内カウンタでは
 *   多重起動時に上限を突破するため）。
 */

/** SENDING のまま放置された行を回収するまでの猶予 */
const STALE_SENDING_MS = 5 * 60 * 1000;

/**
 * スキップ理由 → 記録する結果。
 * ALREADY_SENT / MAX_ATTEMPTS / IN_PROGRESS は既存の結果を保持したいので含めない。
 */
const SKIP_RESULT: Partial<
  Record<
    Extract<SendDecision, { action: "SKIP" }>["reason"],
    "SKIPPED_QUOTA" | "SKIPPED_BLOCKED" | "SKIPPED_NOT_LINKED"
  >
> = {
  QUOTA: "SKIPPED_QUOTA",
  BLOCKED: "SKIPPED_BLOCKED",
  NOT_LINKED: "SKIPPED_NOT_LINKED",
};

export type ReminderRunResult = {
  checkedStores: number;
  targeted: number;
  sent: number;
  failed: number;
  skipped: Record<string, number>;
};

export type RunRemindersOptions = {
  /** 対象店舗を限定する（管理画面からの手動実行で自店舗のみに絞るために使う） */
  storeIds?: string[];
};

export async function runReminders(
  now: Date = new Date(),
  options: RunRemindersOptions = {},
): Promise<ReminderRunResult> {
  const result: ReminderRunResult = {
    checkedStores: 0,
    targeted: 0,
    sent: 0,
    failed: 0,
    skipped: {},
  };

  const bump = (reason: string) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
  };

  const limit = getMonthlyLimit();

  const stores = await prisma.store.findMany({
    where: options.storeIds ? { id: { in: options.storeIds } } : {},
    include: {
      casts: {
        where: { status: "ACTIVE" },
        include: { targets: { orderBy: { effectiveFrom: "desc" } } },
      },
    },
  });

  for (const store of stores) {
    result.checkedStores += 1;
    if (!isReminderTimeReached(now, store.reminderHour, store.businessDayStart)) continue;

    const today = currentBusinessDate(store.businessDayStart, now);
    const weekStart = businessWeekStart(today);
    const window = recentBusinessDates(today, store.daysStaleThreshold);
    if (store.casts.length === 0) continue;

    const castIds = store.casts.map((c) => c.id);

    // 直近の更新（stale 判定用）と今週の件数（文面用）をまとめて取得し、
    // キャストごとのクエリ（N+1）を避ける
    const [recentPosts, weeklyCounts] = await Promise.all([
      prisma.blogPost.findMany({
        where: { castId: { in: castIds }, businessDate: { in: window }, ...notVoided },
        select: { castId: true, businessDate: true },
      }),
      prisma.blogPost.groupBy({
        by: ["castId"],
        where: { castId: { in: castIds }, businessWeekStart: weekStart, ...notVoided },
        _count: { _all: true },
      }),
    ]);

    const byCast = new Map<string, Set<string>>();
    for (const p of recentPosts) {
      if (!byCast.has(p.castId)) byCast.set(p.castId, new Set());
      byCast.get(p.castId)!.add(p.businessDate);
    }
    const weeklyCountMap = new Map(weeklyCounts.map((r) => [r.castId, r._count._all]));

    for (const cast of store.casts) {
      if (!isStale(today, store.daysStaleThreshold, byCast.get(cast.id) ?? new Set())) continue;
      result.targeted += 1;

      // 送信のたびに実数を読み直す（プロセス内カウンタだと多重起動で上限を突破する）
      const monthlySent = await countMonthlySent(now);

      // --- 行を用意する（存在しなければ作る） ---
      const log = await prisma.lineMessageLog.upsert({
        where: {
          castId_kind_businessDate: { castId: cast.id, kind: "REMINDER", businessDate: today },
        },
        create: { castId: cast.id, kind: "REMINDER", businessDate: today, result: "PENDING" },
        update: {},
      });

      const decision = decideSend({
        existingResult: log.result,
        existingAttemptCount: log.attemptCount,
        lineStatus: cast.lineStatus,
        monthlySentCount: monthlySent,
        monthlyLimit: limit,
        sendingIsFresh:
          log.result === "SENDING" && now.getTime() - log.updatedAt.getTime() < STALE_SENDING_MS,
      });

      if (decision.action === "SKIP") {
        bump(decision.reason);
        const skipResult = SKIP_RESULT[decision.reason];
        if (skipResult) {
          await prisma.lineMessageLog.updateMany({
            where: { id: log.id, result: { not: "SENT" } },
            data: { result: skipResult, errorDetail: decision.reason },
          });
        }
        continue;
      }

      // --- CAS で claim する。更新できた1プロセスだけが送信する ---
      const claimed = await prisma.lineMessageLog.updateMany({
        where: { id: log.id, result: log.result, attemptCount: log.attemptCount },
        data: { result: "SENDING", attemptCount: { increment: 1 } },
      });
      if (claimed.count !== 1) {
        // 別のインスタンスが先に取った
        bump("IN_PROGRESS");
        continue;
      }

      const attempt = log.attemptCount + 1;

      try {
        const progress = buildWeeklyProgress(
          cast.targets,
          weekStart,
          weeklyCountMap.get(cast.id) ?? 0,
        );
        await pushMessage(cast.lineUserId!, [textMessage(buildReminderText(cast.name, progress))]);
        await prisma.lineMessageLog.update({
          where: { id: log.id },
          data: { result: "SENT", sentAt: new Date(), errorDetail: null },
        });
        result.sent += 1;
      } catch (error) {
        await prisma.lineMessageLog.update({
          where: { id: log.id },
          data: {
            result: "FAILED",
            errorDetail: error instanceof Error ? error.message.slice(0, 300) : "unknown error",
          },
        });
        result.failed += 1;
        if (attempt >= MAX_SEND_ATTEMPTS) bump("MAX_ATTEMPTS_REACHED");
      }
    }
  }

  return result;
}

/** 進捗を添えたリマインド文面を組み立てる（DB アクセスなし） */
function buildReminderText(
  castName: string,
  progress: ReturnType<typeof buildWeeklyProgress>,
): string {
  if (progress.target === null) {
    return `${castName}さん、ブログの更新をお願いします！`;
  }
  return `${castName}さん、ブログの更新をお願いします！\n今週は ${progress.postCount}/${progress.target} 回（あと ${progress.remaining} 回）です。`;
}
