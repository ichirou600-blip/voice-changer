import "server-only";

import { prisma } from "@/lib/prisma";
import { startOfMonthJst } from "@/lib/quota";

/**
 * 文面生成の実行制限。
 *
 * 方針（依頼者の判断）:
 * - **回数の上限は既定で設けない**。必要になった店舗だけ設定画面から
 *   月間上限を入れる（`Store.draftMonthlyLimit`、null = 無制限）。
 *
 * ただし「上限なし」と「無防備」は別物なので、費用とは別の理由で
 * 次の1つだけは常に効かせる。
 *
 * - **連続実行の抑制（60秒に3回まで）**
 *   キャスト用 URL は署名付きとはいえ URL を知っていれば開ける。
 *   万一 LINE のトーク履歴ごと第三者に渡った場合、
 *   連打だけで API 利用料を短時間に積み上げられてしまう。
 *   これは費用の上限管理ではなく、悪用と誤操作（連打）への防御。
 */

/** 連続実行の判定窓 */
export const BURST_WINDOW_MS = 60 * 1000;
/** 判定窓のなかで許す実行回数 */
export const MAX_BURST_PER_CAST = 3;

export type DraftLimitVerdict =
  | { allowed: true }
  | { allowed: false; reason: "burst"; retryAfterSeconds: number }
  | { allowed: false; reason: "monthly"; used: number; limit: number };

/** 当月（JST）の生成回数。API を実際に叩いた実行のみ数える */
export async function countMonthlyDrafts(
  storeId: string,
  now: Date = new Date(),
): Promise<number> {
  return prisma.draftGeneration.count({
    where: {
      storeId,
      createdAt: { gte: startOfMonthJst(now) },
      // 上限に阻まれて実行しなかったものは消費に数えない
      result: { not: "SKIPPED_LIMIT" },
    },
  });
}

/**
 * 生成してよいかを判定する。
 *
 * 判定順は「連続実行 → 月間上限」。
 * 連続実行を先に見るのは、こちらが件数を数える範囲が狭く安いため。
 */
export async function checkDraftLimits(
  params: { castId: string; storeId: string; monthlyLimit: number | null },
  now: Date = new Date(),
): Promise<DraftLimitVerdict> {
  const recent = await prisma.draftGeneration.findMany({
    where: {
      castId: params.castId,
      createdAt: { gte: new Date(now.getTime() - BURST_WINDOW_MS) },
      result: { not: "SKIPPED_LIMIT" },
    },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  if (recent.length >= MAX_BURST_PER_CAST) {
    const unlockAt = recent[0].createdAt.getTime() + BURST_WINDOW_MS;
    return {
      allowed: false,
      reason: "burst",
      retryAfterSeconds: Math.max(1, Math.ceil((unlockAt - now.getTime()) / 1000)),
    };
  }

  if (params.monthlyLimit !== null) {
    const used = await countMonthlyDrafts(params.storeId, now);
    if (used >= params.monthlyLimit) {
      return { allowed: false, reason: "monthly", used, limit: params.monthlyLimit };
    }
  }

  return { allowed: true };
}

export type DraftUsage = {
  used: number;
  limit: number | null;
  inputTokens: number;
  outputTokens: number;
};

/** 管理画面に出す当月の利用状況 */
export async function getDraftUsage(
  storeId: string,
  monthlyLimit: number | null,
  now: Date = new Date(),
): Promise<DraftUsage> {
  const since = startOfMonthJst(now);
  const [used, tokens] = await Promise.all([
    countMonthlyDrafts(storeId, now),
    prisma.draftGeneration.aggregate({
      where: { storeId, createdAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true },
    }),
  ]);

  return {
    used,
    limit: monthlyLimit,
    inputTokens: tokens._sum.inputTokens ?? 0,
    outputTokens: tokens._sum.outputTokens ?? 0,
  };
}
