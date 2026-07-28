"use server";

import { redirect } from "next/navigation";

import { getClientIp, getUserAgent, writeAudit } from "@/lib/audit";
import { toUserMessage } from "@/lib/auth/authorize";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { completeSetup, isSetupCompleted } from "@/lib/auth/setup";
import { parseForm, setupSchema } from "@/lib/validations";

export type SetupState = { error?: string };

/**
 * 初回セットアップ。
 * この Server Action は「ユーザーが 0 件のときのみ」実行できる。
 * （認証前に呼べる唯一の変更系 Action なので、条件を必ずここで再確認する）
 */
export async function setupAction(_prev: SetupState, formData: FormData): Promise<SetupState> {
  if (await isSetupCompleted()) {
    return { error: "初期セットアップは既に完了しています" };
  }

  const parsed = parseForm(setupSchema, formData);
  if (!parsed.ok) return { error: parsed.error };

  try {
    const { userId } = await completeSetup(parsed.data);
    const session = await createSession(userId, { ip: getClientIp(), userAgent: getUserAgent() });
    setSessionCookie(session);
    await writeAudit({
      actorUserId: userId,
      action: "SETUP_COMPLETED",
      targetType: "User",
      targetId: userId,
      ip: getClientIp(),
    });
  } catch (error) {
    return { error: toUserMessage(error) };
  }

  redirect("/dashboard");
}
