"use server";

import { revalidatePath } from "next/cache";

import { defineAction, ValidationError } from "@/lib/auth/authorize";
import { issueInvitation, issuePasswordReset, revokeSessions, setUserActive } from "@/lib/dal/users";
import { inviteSchema } from "@/lib/validations";

/**
 * スタッフ管理の Server Action。
 * 招待・再設定リンクは発行結果として **平文トークンを1度だけ**返す
 * （DB にはハッシュしか残らないため、画面を閉じると再表示できない）。
 */

function buildLink(token: string): string {
  const base = process.env.APP_URL?.replace(/\/$/, "") ?? "";
  return `${base}/invite/${token}`;
}

export const inviteUserAction = defineAction("MANAGER", async (ctx, formData: FormData) => {
  const raw = Object.fromEntries(formData);
  const parsed = inviteSchema.safeParse({
    ...raw,
    storeId: raw.storeId ? String(raw.storeId) : null,
  });
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  }
  const { token, expiresAt } = await issueInvitation(ctx.user, parsed.data);
  revalidatePath("/users");
  return { link: buildLink(token), expiresAt: expiresAt.toISOString() };
});

export const issueResetAction = defineAction("MANAGER", async (ctx, userId: string) => {
  const { token, expiresAt, email } = await issuePasswordReset(ctx.user, userId);
  return { link: buildLink(token), expiresAt: expiresAt.toISOString(), email };
});

export const setUserActiveAction = defineAction(
  "MANAGER",
  async (ctx, input: { userId: string; isActive: boolean }) => {
    await setUserActive(ctx.user, input.userId, input.isActive);
    revalidatePath("/users");
    return { ok: true };
  },
);

export const revokeSessionsAction = defineAction("MANAGER", async (ctx, userId: string) => {
  const count = await revokeSessions(ctx.user, userId);
  revalidatePath("/users");
  return { count };
});
