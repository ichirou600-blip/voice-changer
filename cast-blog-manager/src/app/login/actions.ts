"use server";

import { redirect } from "next/navigation";

import { assertSameOriginRequest, toUserMessage } from "@/lib/auth/authorize";
import { login } from "@/lib/auth/login";
import { destroyCurrentSession, clearSessionCookie } from "@/lib/auth/session";
import { getSessionUser } from "@/lib/auth/session";
import { writeAudit, getClientIp } from "@/lib/audit";
import { loginSchema, parseForm } from "@/lib/validations";

export type LoginState = { error?: string };

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  // 未認証で呼べる Action のため、defineAction を経由しない。
  // CSRF の二次防御をここで明示的に行う（ログイン CSRF 対策）。
  try {
    await assertSameOriginRequest();
  } catch (error) {
    return { error: toUserMessage(error) };
  }

  const parsed = parseForm(loginSchema, formData);
  // 形式不備でも「どちらが違うか」を漏らさない
  if (!parsed.ok) return { error: "メールアドレスまたはパスワードが違います" };

  const result = await login(parsed.data.email, parsed.data.password);
  if (!result.ok) return { error: result.message };

  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await assertSameOriginRequest();
  const user = await getSessionUser();
  await destroyCurrentSession();
  await clearSessionCookie();
  if (user) {
    await writeAudit({ actorUserId: user.id, action: "LOGOUT", ip: await getClientIp() });
  }
  redirect("/login");
}
