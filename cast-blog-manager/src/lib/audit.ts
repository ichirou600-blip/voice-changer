import "server-only";

import { headers } from "next/headers";

import { prisma } from "@/lib/prisma";

/**
 * 監査ログ。
 *
 * 設計レビューでの指摘:
 * - 管理者は任意のスタッフのパスワードを再設定できるため、
 *   「誰が発行したか」を残さないと投稿の帰属が保証されない
 * - 「退職者を即座に無効化した」ことを後から検証できる必要がある
 */

export type AuditAction =
  | "SETUP_COMPLETED"
  | "LOGIN_SUCCEEDED"
  | "LOGOUT"
  | "USER_INVITED"
  | "INVITATION_ACCEPTED"
  | "PASSWORD_RESET_ISSUED"
  | "PASSWORD_RESET_COMPLETED"
  | "USER_DEACTIVATED"
  | "USER_REACTIVATED"
  | "SESSION_REVOKED"
  | "CAST_CREATED"
  | "CAST_UPDATED"
  | "CAST_RETIRED"
  | "CAST_TARGET_CHANGED"
  | "CAST_LINE_CODE_ISSUED"
  | "CAST_LINE_LINKED"
  | "CAST_LINE_UNLINKED"
  | "POST_CREATED"
  | "POST_VOIDED"
  | "STORE_CREATED"
  | "STORE_UPDATED"
  | "REMINDER_RUN";

export type AuditInput = {
  actorUserId?: string | null;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  detail?: string | null;
  ip?: string | null;
};

export async function writeAudit(input: AuditInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      detail: input.detail ?? null,
      ip: input.ip ?? null,
    },
  });
}

/**
 * リクエストのクライアント IP を推定する。
 *
 * `x-forwarded-for` の先頭はクライアントが送った値がそのまま残る構成
 * （nginx の $proxy_add_x_forwarded_for など）があるため、
 * プロキシが自ら付与する `x-real-ip` を優先する。
 * どちらも信頼できない環境ではレート制限のキーとしては弱いので、
 * IP 単位の制限に加えてアカウント単位の制限も併用している。
 */
export async function getClientIp(): Promise<string | null> {
  const h = await headers();
  const realIp = h.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

export async function getUserAgent(): Promise<string | null> {
  return (await headers()).get("user-agent");
}
