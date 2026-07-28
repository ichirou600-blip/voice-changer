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
 * Vercel では `x-forwarded-for` の先頭が実クライアント。
 */
export function getClientIp(): string | null {
  const h = headers();
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip");
}

export function getUserAgent(): string | null {
  return headers().get("user-agent");
}
