import "server-only";

import { currentBusinessDate, recentBusinessDates } from "@/lib/business-day";
import { notVoided } from "@/lib/dal/posts";
import { pushMessage, textMessage } from "@/lib/line/client";
import { prisma } from "@/lib/prisma";
import { getMonthlyLimit } from "@/lib/quota";
import { countMonthlySent } from "@/lib/quota";
import {
  decideSend,
  isReminderTimeReached,
  isStale,
  MAX_SEND_ATTEMPTS,
  type SendDecision,
} from "@/lib/reminder-policy";
import { buildWeeklyProgress } from "@/lib/targets";
import { businessWeekStart } from "@/lib/business-day";

/**
 * リマインド送信の本体。トリガー（GitHub Actions / Vercel Cron / 手動）非依存。
 *
 * 設計レビューで確定した重要な性質:
 * - **キャッチアップ型**: 「現在時刻 == reminderHour」ではなく「>= reminderHour」で判定する。
 *   スケジューラが遅延・スキップしても、その日のうちに走れば取りこぼさない。
 * - **claim → 結果更新方式**: 先に LineMessageLog を PENDING で作成（claim）し、
 *   送信後に result を更新する。ユニーク制約で二重送信を防ぎつつ、
 *   FAILED は同じ行を更新して再試行できる（上限 MAX_SEND_ATTEMPTS）。
 * - **月間上限**: 実送信数が上限に達したら SKIPPED_QUOTA として記録し送信しない。
 */

/**
 * スキップ理由 → 記録する結果。
 * ALREADY_SENT / MAX_ATTEMPTS は既存の結果を保持したいので意図的に含めない
 * （undefined になり、上書きされない）。
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

export async function runReminders(now: Date = new Date()): Promise<ReminderRunResult> {
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
  let monthlySent = await countMonthlySent(now);

  const stores = await prisma.store.findMany({ include: { casts: true } });

  for (const store of stores) {
    result.checkedStores += 1;
    if (!isReminderTimeReached(now, store.reminderHour)) continue;

    const today = currentBusinessDate(store.businessDayStart, now);
    const window = recentBusinessDates(today, store.daysStaleThreshold);
    const activeCasts = store.casts.filter((c) => c.status === "ACTIVE");
    if (activeCasts.length === 0) continue;

    const castIds = activeCasts.map((c) => c.id);
    const recentPosts = await prisma.blogPost.findMany({
      where: { castId: { in: castIds }, businessDate: { in: window }, ...notVoided },
      select: { castId: true, businessDate: true },
    });
    const byCast = new Map<string, Set<string>>();
    for (const p of recentPosts) {
      if (!byCast.has(p.castId)) byCast.set(p.castId, new Set());
      byCast.get(p.castId)!.add(p.businessDate);
    }

    for (const cast of activeCasts) {
      if (!isStale(today, store.daysStaleThreshold, byCast.get(cast.id) ?? new Set())) continue;
      result.targeted += 1;

      // --- claim: 先に行を確保する（冪等性の要） ---
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
      });

      if (decision.action === "SKIP") {
        bump(decision.reason);
        // スキップ理由を正確に記録する。
        // ALREADY_SENT / MAX_ATTEMPTS は既存の結果を保持したいので上書きしない。
        const skipResult = SKIP_RESULT[decision.reason];
        if (skipResult) {
          await prisma.lineMessageLog.update({
            where: { id: log.id },
            data: { result: skipResult, errorDetail: decision.reason },
          });
        }
        continue;
      }

      // --- 送信 ---
      try {
        const message = await buildReminderText(cast.id, cast.name, today);
        await pushMessage(cast.lineUserId!, [textMessage(message)]);
        await prisma.lineMessageLog.update({
          where: { id: log.id },
          data: {
            result: "SENT",
            sentAt: new Date(),
            attemptCount: { increment: 1 },
            errorDetail: null,
          },
        });
        monthlySent += 1;
        result.sent += 1;
      } catch (error) {
        const attempt = log.attemptCount + 1;
        await prisma.lineMessageLog.update({
          where: { id: log.id },
          data: {
            result: "FAILED",
            attemptCount: attempt,
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

/** 進捗を添えたリマインド文面を組み立てる */
async function buildReminderText(
  castId: string,
  castName: string,
  businessDate: string,
): Promise<string> {
  const weekStart = businessWeekStart(businessDate);
  const [targets, count] = await Promise.all([
    prisma.castTarget.findMany({ where: { castId }, orderBy: { effectiveFrom: "desc" } }),
    prisma.blogPost.count({ where: { castId, businessWeekStart: weekStart, ...notVoided } }),
  ]);
  const progress = buildWeeklyProgress(targets, weekStart, count);

  if (progress.target === null) {
    return `${castName}さん、ブログの更新をお願いします！`;
  }
  return `${castName}さん、ブログの更新をお願いします！\n今週は ${progress.postCount}/${progress.target} 回（あと ${progress.remaining} 回）です。`;
}
