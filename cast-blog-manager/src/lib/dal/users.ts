import "server-only";

import { writeAudit } from "@/lib/audit";
import {
  assertCanManageUser,
  assertStoreAccess,
  storeScope,
  ValidationError,
} from "@/lib/auth/authorize";
import { hashPassword } from "@/lib/auth/password";
import { destroyAllSessionsForUser, type SessionUser } from "@/lib/auth/session";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { prisma } from "@/lib/prisma";

/**
 * 管理ユーザーの DAL。
 *
 * 設計レビューでの指摘への対策:
 * - 招待 / パスワード再設定のトークンは **ハッシュのみ保存**し、URL 提示時のみ平文を返す
 * - リンクプレビュー bot が URL を踏んでもトークンが消費されないよう、
 *   **GET では消費せず POST（確定操作）で消費**する
 * - 退職者が事前に発行したリンクで復活しないよう、**受諾時に isActive を必ず確認**
 * - パスワード変更・無効化時は **当該ユーザーの全セッションを破棄**
 * - 発行者と対象を監査ログに残す（管理者によるなりすまし対策）
 */

/** 招待リンクの有効期間 */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72時間
/** パスワード再設定リンクの有効期間（短く） */
export const RESET_TTL_MS = 30 * 60 * 1000; // 30分

export async function listUsers(user: SessionUser) {
  return prisma.user.findMany({
    where: user.role === "ADMIN" ? {} : { ...storeScope(user) },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    include: { store: { select: { name: true } } },
  });
}

/**
 * スタッフを招待する。パスワードは招待受諾時に本人が設定するため、
 * この時点ではユーザーを作らずトークンのみ発行する。
 */
export async function issueInvitation(
  actor: SessionUser,
  input: { email: string; name: string; role: "ADMIN" | "MANAGER" | "STAFF"; storeId?: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  // MANAGER は ADMIN を作れない（権限昇格の防止）
  if (actor.role !== "ADMIN" && input.role === "ADMIN") {
    throw new ValidationError("管理者を招待できるのは管理者のみです");
  }
  const targetStoreId = input.storeId ?? actor.storeId ?? null;
  if (input.role !== "ADMIN") {
    if (!targetStoreId) throw new ValidationError("所属店舗を指定してください");
    assertStoreAccess(actor, targetStoreId);
  }

  // メールアドレスは全体で一意なので存在確認は避けられないが、
  // 自分のスコープ外のユーザーの登録有無までは確定させない
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    const visible = actor.role === "ADMIN" || existing.storeId === actor.storeId;
    throw new ValidationError(
      visible
        ? "このメールアドレスは既に登録されています"
        : "このメールアドレスは招待できません。管理者にお問い合わせください。",
    );
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  await prisma.invitation.create({
    data: {
      tokenHash: hashToken(token),
      purpose: "INVITE",
      email: input.email,
      role: input.role,
      storeId: targetStoreId,
      issuedById: actor.id,
      expiresAt,
    },
  });

  await writeAudit({
    actorUserId: actor.id,
    action: "USER_INVITED",
    targetType: "User",
    targetId: input.email,
    detail: `role=${input.role} store=${targetStoreId ?? "-"}`,
  });

  return { token, expiresAt };
}

/** パスワード再設定リンクを発行する（管理者が本人に手渡す） */
export async function issuePasswordReset(
  actor: SessionUser,
  targetUserId: string,
): Promise<{ token: string; expiresAt: Date; email: string }> {
  const target = await prisma.user.findFirst({
    where: { id: targetUserId, ...(actor.role === "ADMIN" ? {} : storeScope(actor)) },
  });
  if (!target) throw new ValidationError("対象ユーザーが見つかりません");
  if (!target.isActive) throw new ValidationError("無効化されたユーザーには発行できません");
  assertCanManageUser(actor, target);

  const token = generateToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);

  await prisma.invitation.create({
    data: {
      tokenHash: hashToken(token),
      purpose: "PASSWORD_RESET",
      email: target.email,
      role: target.role,
      storeId: target.storeId,
      issuedById: actor.id,
      expiresAt,
    },
  });

  await writeAudit({
    actorUserId: actor.id,
    action: "PASSWORD_RESET_ISSUED",
    targetType: "User",
    targetId: target.id,
    detail: target.email,
  });

  return { token, expiresAt, email: target.email };
}

export type InvitationPreview = {
  purpose: "INVITE" | "PASSWORD_RESET";
  email: string;
};

/**
 * トークンの内容を **消費せずに** 確認する（画面表示用）。
 * リンクプレビュー bot が GET しても無効化されない。
 */
export async function peekInvitation(token: string): Promise<InvitationPreview | null> {
  const invitation = await prisma.invitation.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!invitation) return null;
  if (invitation.usedAt) return null;
  if (invitation.expiresAt <= new Date()) return null;
  return { purpose: invitation.purpose, email: invitation.email };
}

/**
 * 招待 / パスワード再設定を確定する（POST でのみ呼ぶ）。
 * トークンはここで初めて消費される。
 */
export async function redeemInvitation(input: {
  token: string;
  password: string;
  ip?: string | null;
}): Promise<{ userId: string }> {
  const tokenHash = hashToken(input.token);
  const invitation = await prisma.invitation.findUnique({ where: { tokenHash } });

  if (!invitation || invitation.usedAt || invitation.expiresAt <= new Date()) {
    throw new ValidationError("リンクが無効か、有効期限が切れています");
  }

  const passwordHash = await hashPassword(input.password);

  const userId = await prisma.$transaction(async (tx) => {
    // 二重消費を防ぐ: 未使用のものだけを使用済みにできた場合のみ続行
    const claimed = await tx.invitation.updateMany({
      where: { tokenHash, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ValidationError("リンクが無効か、有効期限が切れています");
    }

    if (invitation.purpose === "INVITE") {
      const existing = await tx.user.findUnique({ where: { email: invitation.email } });
      if (existing) throw new ValidationError("このメールアドレスは既に登録されています");
      const created = await tx.user.create({
        data: {
          email: invitation.email,
          name: invitation.email.split("@")[0],
          passwordHash,
          role: invitation.role,
          storeId: invitation.storeId,
        },
      });
      return created.id;
    }

    // パスワード再設定: 退職者が事前に発行したリンクで復活しないよう isActive を確認
    const target = await tx.user.findUnique({ where: { email: invitation.email } });
    if (!target || !target.isActive) {
      throw new ValidationError("このアカウントは利用できません");
    }
    await tx.user.update({ where: { id: target.id }, data: { passwordHash } });
    return target.id;
  });

  // パスワードが変わったら既存セッションを全て破棄する
  // （乗っ取られた後にパスワードを変えても攻撃者のセッションが残る問題への対策）
  await destroyAllSessionsForUser(userId);

  await writeAudit({
    actorUserId: userId,
    action: invitation.purpose === "INVITE" ? "INVITATION_ACCEPTED" : "PASSWORD_RESET_COMPLETED",
    targetType: "User",
    targetId: userId,
    ip: input.ip ?? null,
  });

  return { userId };
}

/** ユーザーの有効/無効を切り替える。無効化時は全セッションを即時破棄する */
export async function setUserActive(
  actor: SessionUser,
  targetUserId: string,
  isActive: boolean,
): Promise<void> {
  if (actor.id === targetUserId && !isActive) {
    throw new ValidationError("自分自身を無効化することはできません");
  }

  const target = await prisma.user.findFirst({
    where: { id: targetUserId, ...(actor.role === "ADMIN" ? {} : storeScope(actor)) },
  });
  if (!target) throw new ValidationError("対象ユーザーが見つかりません");
  assertCanManageUser(actor, target);

  // 最後の有効な管理者を無効化して締め出されるのを防ぐ
  if (!isActive && target.role === "ADMIN") {
    const activeAdmins = await prisma.user.count({ where: { role: "ADMIN", isActive: true } });
    if (activeAdmins <= 1) {
      throw new ValidationError("有効な管理者が1人しかいないため無効化できません");
    }
  }

  await prisma.user.update({ where: { id: target.id }, data: { isActive } });
  if (!isActive) await destroyAllSessionsForUser(target.id);

  await writeAudit({
    actorUserId: actor.id,
    action: isActive ? "USER_REACTIVATED" : "USER_DEACTIVATED",
    targetType: "User",
    targetId: target.id,
    detail: target.email,
  });
}

/** ユーザーの有効なセッション一覧（管理画面で失効を確認できるようにする） */
export async function listSessionsForUser(actor: SessionUser, targetUserId: string) {
  const target = await prisma.user.findFirst({
    where: { id: targetUserId, ...(actor.role === "ADMIN" ? {} : storeScope(actor)) },
  });
  if (!target) throw new ValidationError("対象ユーザーが見つかりません");
  assertCanManageUser(actor, target);

  return prisma.session.findMany({
    where: { userId: target.id, idleExpiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true },
  });
}

/** 指定ユーザーの全セッションを強制失効させる */
export async function revokeSessions(actor: SessionUser, targetUserId: string): Promise<number> {
  const target = await prisma.user.findFirst({
    where: { id: targetUserId, ...(actor.role === "ADMIN" ? {} : storeScope(actor)) },
  });
  if (!target) throw new ValidationError("対象ユーザーが見つかりません");
  assertCanManageUser(actor, target);

  const count = await destroyAllSessionsForUser(target.id);
  await writeAudit({
    actorUserId: actor.id,
    action: "SESSION_REVOKED",
    targetType: "User",
    targetId: target.id,
    detail: `${count} sessions`,
  });
  return count;
}
