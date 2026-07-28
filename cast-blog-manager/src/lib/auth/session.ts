import "server-only";

import { cookies } from "next/headers";

import { prisma } from "@/lib/prisma";
import { requestCache } from "@/lib/request-cache";

import { generateToken, hashToken } from "./tokens";

/**
 * DB セッション。
 *
 * 設計レビューでの指摘と対策:
 * - Server Component からは Cookie を **書けない**（Next.js の制約）。
 *   そのため Cookie の有効期限は「絶対期限」に固定して発行し、
 *   セッションの延長は DB 側（idleExpiresAt）のみで行う。
 *   → 真実の情報源は常に DB。Cookie は単なる持ち回りトークン。
 * - 永久セッションを作らないため、アイドル期限と絶対期限の二本立てにする。
 * - 退職者を即座に締め出すため、検証のたびに User.isActive を JOIN で確認する。
 *   （セッション行の削除だけに頼らない）
 * - lastUsedAt の毎リクエスト UPDATE は DB 負荷になるため、
 *   一定間隔を空けたときだけ書き込む。
 * - 同一リクエスト内で複数回呼ばれても DB アクセスは1回にする（React cache）。
 */

/** 未使用が続いた場合の失効までの時間 */
const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日
/** 発行時に決まる絶対失効までの時間（延長されない） */
const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日
/** lastUsedAt / idleExpiresAt を書き戻す最小間隔 */
const TOUCH_THROTTLE_MS = 60 * 1000; // 60秒

const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Cookie 名。
 * 本番では `__Host-` prefix を付ける（Secure + Path=/ + Domain 属性なしが強制され、
 * 他サブドメインや preview 環境からの cookie 上書き = セッション固定を防ぐ）。
 * ローカル開発は http のため prefix なし。
 */
export const SESSION_COOKIE_NAME = IS_PROD ? "__Host-cbm_session" : "cbm_session";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "MANAGER" | "STAFF";
  storeId: string | null;
};

export type CreatedSession = {
  token: string;
  absoluteExpiresAt: Date;
};

/**
 * セッションを新規発行する。
 *
 * セッション固定攻撃を防ぐため、呼び出し側（ログイン処理）は
 * 事前に既存セッションを破棄すること。
 */
export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<CreatedSession> {
  const token = generateToken();
  const now = new Date();
  const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_TTL_MS);

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
      idleExpiresAt: new Date(now.getTime() + IDLE_TTL_MS),
      absoluteExpiresAt,
    },
  });

  return { token, absoluteExpiresAt };
}

/**
 * Cookie にセッショントークンを載せる。
 * **Route Handler か Server Action からのみ呼べる**（Server Component では例外になる）。
 */
export function setSessionCookie(session: CreatedSession): void {
  cookies().set(SESSION_COOKIE_NAME, session.token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    path: "/",
    expires: session.absoluteExpiresAt,
  });
}

/** Cookie からセッションを削除する（Route Handler / Server Action 限定） */
export function clearSessionCookie(): void {
  cookies().set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/**
 * 現在のセッションユーザーを取得する。未認証・失効時は null。
 *
 * React の cache() でリクエストスコープにメモ化されるため、
 * 1画面で何度呼んでも DB アクセスは1回で済む。
 */
export const getSessionUser = requestCache(async (): Promise<SessionUser | null> => {
  const token = cookies().get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: {
        select: { id: true, email: true, name: true, role: true, storeId: true, isActive: true },
      },
    },
  });
  if (!session) return null;

  const now = new Date();

  // 失効判定（アイドル期限・絶対期限のどちらか一方でも過ぎたら無効）
  if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
    await prisma.session.deleteMany({ where: { id: session.id } });
    return null;
  }

  // 退職者の即時失効: 行削除に頼らず毎回 isActive を確認する
  if (!session.user.isActive) {
    await prisma.session.deleteMany({ where: { userId: session.userId } });
    return null;
  }

  // lastUsedAt / idleExpiresAt の書き戻しは間引く（DB 書き込み負荷対策）
  if (now.getTime() - session.lastUsedAt.getTime() > TOUCH_THROTTLE_MS) {
    const nextIdle = new Date(now.getTime() + IDLE_TTL_MS);
    await prisma.session.updateMany({
      where: { id: session.id },
      data: {
        lastUsedAt: now,
        // 絶対期限は延長しない
        idleExpiresAt: nextIdle > session.absoluteExpiresAt ? session.absoluteExpiresAt : nextIdle,
      },
    });
  }

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    storeId: session.user.storeId,
  };
});

/** 現在のセッションを破棄する（ログアウト） */
export async function destroyCurrentSession(): Promise<void> {
  const token = cookies().get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
}

/**
 * 対象ユーザーの全セッションを破棄する。
 * パスワード変更・アカウント無効化・管理者による強制ログアウトで使う。
 */
export async function destroyAllSessionsForUser(userId: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { userId } });
  return count;
}

/** 期限切れセッションを掃除する（cron から日次で呼ぶ） */
export async function purgeExpiredSessions(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: {
      OR: [{ idleExpiresAt: { lte: now } }, { absoluteExpiresAt: { lte: now } }],
    },
  });
  return count;
}
