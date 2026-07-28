import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * LINE Push の月間送信数管理。
 *
 * 設計レビューでの指摘:
 * - LINE 無料プランの Push は **月200通**。キャスト20名に毎日送ると月600通で即超過し、
 *   課金 or 送信失敗になる
 *   → 送信は「未更新者のみ」「1キャスト1営業日1通」に絞ったうえで、
 *     月間の実送信数を数えて上限（既定180 = 200通への安全マージン）で止める
 *
 * 上限に達した送信は SKIPPED_QUOTA として記録し、翌月に自然回復する。
 */

export const DEFAULT_MONTHLY_LIMIT = 180;

export function getMonthlyLimit(): number {
  const raw = process.env.LINE_MONTHLY_PUSH_LIMIT;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MONTHLY_LIMIT;
}

/** JST の月初（UTC の Date として返す） */
export function startOfMonthJst(now: Date = new Date()): Date {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth();
  // JST の月初 00:00 = UTC の前月末 15:00
  return new Date(Date.UTC(year, month, 1) - 9 * 60 * 60 * 1000);
}

/** 当月の実送信数（SENT のみを数える） */
export async function countMonthlySent(now: Date = new Date()): Promise<number> {
  return prisma.lineMessageLog.count({
    where: { result: "SENT", sentAt: { gte: startOfMonthJst(now) } },
  });
}

export type QuotaStatus = {
  sent: number;
  limit: number;
  remaining: number;
};

export async function getQuotaStatus(now: Date = new Date()): Promise<QuotaStatus> {
  const limit = getMonthlyLimit();
  const sent = await countMonthlySent(now);
  return { sent, limit, remaining: Math.max(0, limit - sent) };
}
