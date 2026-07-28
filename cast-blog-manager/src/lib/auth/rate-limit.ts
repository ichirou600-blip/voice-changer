import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * ログイン試行のレート制限。
 *
 * 設計レビューでの指摘:
 * - Vercel のサーバーレスはリクエストごとに別インスタンスに載りうるため、
 *   `Map` によるインメモリのレート制限は水平スケールで**無効化される**
 *   （「実装したつもりで効いていない」最悪の状態）
 *   → 共有ストアである PostgreSQL に試行を記録して数える。
 *     Redis を足さずに済み、この規模（同時数十人）では十分。
 * - OAuth も MFA も無く、パスワードが唯一の防壁である以上、
 *   IP 単位とアカウント単位の二重で制限する。
 */

/** 制限ウィンドウ */
export const WINDOW_MS = 15 * 60 * 1000; // 15分
/** 同一メールアドレスに対する連続失敗の上限 */
export const MAX_FAILURES_PER_EMAIL = 5;
/** 同一 IP からの連続失敗の上限 */
export const MAX_FAILURES_PER_IP = 20;

export type RateLimitVerdict = {
  allowed: boolean;
  /** 制限中の場合、解除までのおおよその秒数 */
  retryAfterSeconds: number;
};

export function emailKey(email: string): string {
  return `email:${email.trim().toLowerCase()}`;
}

export function ipKey(ip: string): string {
  return `ip:${ip}`;
}

/**
 * 失敗回数から可否を判定する純粋関数（テスト用に切り出し）。
 */
export function judge(
  failures: number,
  max: number,
  oldestFailureAt: Date | null,
  now: Date,
): RateLimitVerdict {
  if (failures < max) return { allowed: true, retryAfterSeconds: 0 };
  const unlockAt = (oldestFailureAt?.getTime() ?? now.getTime()) + WINDOW_MS;
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((unlockAt - now.getTime()) / 1000)),
  };
}

async function countFailures(key: string, since: Date) {
  const rows = await prisma.loginAttempt.findMany({
    where: { key, succeeded: false, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  return { count: rows.length, oldest: rows[0]?.createdAt ?? null };
}

/**
 * ログイン試行が許可されるかを判定する。
 * メール単位と IP 単位のうち、より厳しい方の判定を返す。
 */
export async function checkLoginRateLimit(
  email: string,
  ip: string | null,
  now: Date = new Date(),
): Promise<RateLimitVerdict> {
  const since = new Date(now.getTime() - WINDOW_MS);

  const byEmail = await countFailures(emailKey(email), since);
  const emailVerdict = judge(byEmail.count, MAX_FAILURES_PER_EMAIL, byEmail.oldest, now);
  if (!emailVerdict.allowed) return emailVerdict;

  if (ip) {
    const byIp = await countFailures(ipKey(ip), since);
    const ipVerdict = judge(byIp.count, MAX_FAILURES_PER_IP, byIp.oldest, now);
    if (!ipVerdict.allowed) return ipVerdict;
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/** 試行結果を記録する。成功時は当該メールの失敗履歴を消して即時解除する */
export async function recordLoginAttempt(
  email: string,
  ip: string | null,
  succeeded: boolean,
): Promise<void> {
  const keys = [emailKey(email), ...(ip ? [ipKey(ip)] : [])];

  if (succeeded) {
    await prisma.loginAttempt.deleteMany({ where: { key: emailKey(email), succeeded: false } });
    return;
  }

  await prisma.loginAttempt.createMany({
    data: keys.map((key) => ({ key, succeeded: false })),
  });
}

/** 古い試行記録を掃除する（cron から日次で呼ぶ） */
export async function purgeOldLoginAttempts(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.loginAttempt.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - WINDOW_MS * 4) } },
  });
  return count;
}
