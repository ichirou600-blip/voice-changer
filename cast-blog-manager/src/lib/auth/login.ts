import "server-only";

import { getClientIp, getUserAgent, writeAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

import { verifyDummyPassword, verifyPassword } from "./password";
import { checkLoginRateLimit, recordLoginAttempt } from "./rate-limit";
import { createSession, destroyAllSessionsForUser, setSessionCookie } from "./session";

/**
 * ログイン処理。
 *
 * 設計レビューでの指摘への対策:
 * - **ユーザー列挙の防止**: ユーザー不在時もダミーハッシュを検証して応答時間を揃え、
 *   エラーメッセージも「メールアドレスまたはパスワードが違います」で統一する
 * - **レート制限**: DB を共有ストアとして IP 単位・アカウント単位で制限する
 * - **セッション固定の防止**: ログイン成功時に当該ユーザーの既存セッションを破棄し、
 *   新しいトークンを発行する
 */

export type LoginOutcome =
  | { ok: true }
  | { ok: false; message: string; retryAfterSeconds?: number };

const GENERIC_ERROR = "メールアドレスまたはパスワードが違います";

export async function login(email: string, password: string): Promise<LoginOutcome> {
  const ip = getClientIp();

  const verdict = await checkLoginRateLimit(email, ip);
  if (!verdict.allowed) {
    return {
      ok: false,
      message: `ログイン試行が多すぎます。${Math.ceil(verdict.retryAfterSeconds / 60)}分ほど時間をおいて再度お試しください`,
      retryAfterSeconds: verdict.retryAfterSeconds,
    };
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // ユーザーが存在しない場合も同じ計算コストを消費する（タイミング差による列挙の防止）
  if (!user) {
    await verifyDummyPassword(password);
    await recordLoginAttempt(email, ip, false);
    return { ok: false, message: GENERIC_ERROR };
  }

  const valid = await verifyPassword(user.passwordHash, password);

  // 無効化済みユーザーも、認証失敗と区別できないメッセージにする
  if (!valid || !user.isActive) {
    await recordLoginAttempt(email, ip, false);
    return { ok: false, message: GENERIC_ERROR };
  }

  // セッション固定対策: 既存セッションを破棄してから新規発行する
  await destroyAllSessionsForUser(user.id);
  const session = await createSession(user.id, { ip, userAgent: getUserAgent() });
  setSessionCookie(session);

  await recordLoginAttempt(email, ip, true);
  await writeAudit({
    actorUserId: user.id,
    action: "LOGIN_SUCCEEDED",
    targetType: "User",
    targetId: user.id,
    ip,
  });

  return { ok: true };
}
