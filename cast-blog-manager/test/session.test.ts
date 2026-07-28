import { beforeEach, describe, expect, it } from "vitest";

import { hashPassword, verifyDummyPassword, verifyPassword } from "@/lib/auth/password";
import {
  checkLoginRateLimit,
  judge,
  MAX_FAILURES_PER_EMAIL,
  recordLoginAttempt,
} from "@/lib/auth/rate-limit";
import {
  createSession,
  destroyAllSessionsForUser,
  getSessionUser,
  purgeExpiredSessions,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/session";
import { hashToken } from "@/lib/auth/tokens";
import { peekInvitation, redeemInvitation } from "@/lib/dal/users";
import { prisma } from "@/lib/prisma";

import { resetDatabase } from "./helpers/db";

// テストスタブの cookie ストアを直接操作する
import { cookies } from "next/headers";

/**
 * 認証まわりの統合テスト。
 * デビルズアドボケイトが指摘した各リスクが塞がれていることを実 DB で確認する。
 */

let userId: string;
let storeId: string;

const reset = resetDatabase;

beforeEach(async () => {
  await reset();
  const store = await prisma.store.create({ data: { name: "テスト店" } });
  storeId = store.id;
  const user = await prisma.user.create({
    data: {
      email: "u@example.com",
      name: "テスト",
      passwordHash: await hashPassword("correct-horse-battery"),
      role: "MANAGER",
      storeId,
    },
  });
  userId = user.id;
  cookies().set(SESSION_COOKIE_NAME, "");
});

describe("パスワードハッシュ（argon2id）", () => {
  it("自己記述形式でパラメータが埋め込まれる", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(hash.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
  });

  it("同じパスワードでもソルトが異なるためハッシュは一致しない", async () => {
    const a = await hashPassword("same-password-value");
    const b = await hashPassword("same-password-value");
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "same-password-value")).toBe(true);
    expect(await verifyPassword(b, "same-password-value")).toBe(true);
  });

  it("誤ったパスワードは false、壊れたハッシュでも例外を投げない", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(await verifyPassword(hash, "wrong")).toBe(false);
    expect(await verifyPassword("not-a-hash", "whatever")).toBe(false);
  });

  it("ダミー検証は常に false を返す（ユーザー列挙対策）", async () => {
    expect(await verifyDummyPassword("anything")).toBe(false);
  });
});

describe("セッション", () => {
  it("Cookie には平文、DB にはハッシュのみが保存される", async () => {
    const session = await createSession(userId);
    const row = await prisma.session.findFirst();
    expect(row?.tokenHash).toBe(hashToken(session.token));
    // 平文トークンが DB のどこにも残っていない
    expect(row?.tokenHash).not.toBe(session.token);
  });

  it("有効なトークンでユーザーを解決できる", async () => {
    const session = await createSession(userId);
    cookies().set(SESSION_COOKIE_NAME, session.token);
    const user = await getSessionUser();
    expect(user?.id).toBe(userId);
    expect(user?.storeId).toBe(storeId);
  });

  it("退職者（isActive=false）は即座に締め出される", async () => {
    const session = await createSession(userId);
    cookies().set(SESSION_COOKIE_NAME, session.token);
    expect(await getSessionUser()).not.toBeNull();

    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });

    // 行削除を待たずに isActive の確認だけで失効する
    expect(await getSessionUser()).toBeNull();
    // かつ、そのユーザーの全セッションが消える
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
  });

  it("アイドル期限切れは無効になり、行も掃除される", async () => {
    const session = await createSession(userId);
    await prisma.session.updateMany({
      where: { userId },
      data: { idleExpiresAt: new Date(Date.now() - 1000) },
    });
    cookies().set(SESSION_COOKIE_NAME, session.token);
    expect(await getSessionUser()).toBeNull();
    expect(await prisma.session.count()).toBe(0);
  });

  it("絶対期限は延長されない（永久セッションを作らない）", async () => {
    const session = await createSession(userId);
    await prisma.session.updateMany({
      where: { userId },
      data: { absoluteExpiresAt: new Date(Date.now() - 1000) },
    });
    cookies().set(SESSION_COOKIE_NAME, session.token);
    expect(await getSessionUser()).toBeNull();
  });

  it("全セッション破棄で他端末も落ちる", async () => {
    await createSession(userId);
    await createSession(userId);
    expect(await prisma.session.count({ where: { userId } })).toBe(2);
    const removed = await destroyAllSessionsForUser(userId);
    expect(removed).toBe(2);
  });

  it("purgeExpiredSessions は期限切れのみを消す", async () => {
    const alive = await createSession(userId);
    await createSession(userId);
    await prisma.session.updateMany({
      where: { tokenHash: { not: hashToken(alive.token) } },
      data: { idleExpiresAt: new Date(Date.now() - 1000) },
    });
    const purged = await purgeExpiredSessions();
    expect(purged).toBe(1);
    expect(await prisma.session.count()).toBe(1);
  });
});

describe("レート制限", () => {
  it("judge は上限未満なら許可、到達で拒否", () => {
    const now = new Date("2026-07-28T10:00:00Z");
    expect(judge(4, 5, now, now).allowed).toBe(true);
    const denied = judge(5, 5, new Date(now.getTime() - 60_000), now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("同一メールへの連続失敗で制限がかかる", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) {
      await recordLoginAttempt("u@example.com", "203.0.113.1", false);
    }
    const verdict = await checkLoginRateLimit("u@example.com", "203.0.113.1");
    expect(verdict.allowed).toBe(false);
  });

  it("ログイン成功で当該メールの失敗履歴が消える", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) {
      await recordLoginAttempt("u@example.com", "203.0.113.2", false);
    }
    await recordLoginAttempt("u@example.com", "203.0.113.2", true);
    const verdict = await checkLoginRateLimit("u@example.com", "203.0.113.2");
    expect(verdict.allowed).toBe(true);
  });
});

describe("招待・パスワード再設定", () => {
  async function createInvitation(purpose: "INVITE" | "PASSWORD_RESET", token: string, email: string) {
    return prisma.invitation.create({
      data: {
        tokenHash: hashToken(token),
        purpose,
        email,
        role: "STAFF",
        storeId,
        issuedById: userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  it("GET 相当の peek ではトークンを消費しない（プレビュー bot 対策）", async () => {
    await createInvitation("INVITE", "tok-preview", "new@example.com");
    expect(await peekInvitation("tok-preview")).not.toBeNull();
    // 何度 peek しても有効なまま
    expect(await peekInvitation("tok-preview")).not.toBeNull();
    const row = await prisma.invitation.findFirst({ where: { email: "new@example.com" } });
    expect(row?.usedAt).toBeNull();
  });

  it("招待の受諾でユーザーが作られ、トークンは1回で使い切られる", async () => {
    await createInvitation("INVITE", "tok-invite", "new@example.com");
    await redeemInvitation({ token: "tok-invite", password: "brand-new-password" });

    const created = await prisma.user.findUnique({ where: { email: "new@example.com" } });
    expect(created).not.toBeNull();

    // 2回目は失敗する
    await expect(
      redeemInvitation({ token: "tok-invite", password: "another-password" }),
    ).rejects.toThrow();
  });

  it("期限切れリンクは使えない", async () => {
    await createInvitation("INVITE", "tok-expired", "late@example.com");
    await prisma.invitation.updateMany({
      where: { tokenHash: hashToken("tok-expired") },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await peekInvitation("tok-expired")).toBeNull();
    await expect(
      redeemInvitation({ token: "tok-expired", password: "brand-new-password" }),
    ).rejects.toThrow();
  });

  it("退職者が事前に発行した再設定リンクでは復活できない", async () => {
    await createInvitation("PASSWORD_RESET", "tok-reset", "u@example.com");
    // リンク発行後に無効化された
    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });

    await expect(
      redeemInvitation({ token: "tok-reset", password: "brand-new-password" }),
    ).rejects.toThrow();
  });

  it("パスワード再設定で既存セッションが全て破棄される", async () => {
    await createSession(userId);
    await createSession(userId);
    await createInvitation("PASSWORD_RESET", "tok-reset2", "u@example.com");

    await redeemInvitation({ token: "tok-reset2", password: "totally-new-password" });

    expect(await prisma.session.count({ where: { userId } })).toBe(0);
    const updated = await prisma.user.findUnique({ where: { id: userId } });
    expect(await verifyPassword(updated!.passwordHash, "totally-new-password")).toBe(true);
  });
});
