"use server";

import { redirect } from "next/navigation";

import { login } from "@/lib/auth/login";
import { destroyCurrentSession, clearSessionCookie } from "@/lib/auth/session";
import { getSessionUser } from "@/lib/auth/session";
import { writeAudit, getClientIp } from "@/lib/audit";
import { loginSchema, parseForm } from "@/lib/validations";

export type LoginState = { error?: string };

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = parseForm(loginSchema, formData);
  // 形式不備でも「どちらが違うか」を漏らさない
  if (!parsed.ok) return { error: "メールアドレスまたはパスワードが違います" };

  const result = await login(parsed.data.email, parsed.data.password);
  if (!result.ok) return { error: result.message };

  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  const user = await getSessionUser();
  await destroyCurrentSession();
  clearSessionCookie();
  if (user) {
    await writeAudit({ actorUserId: user.id, action: "LOGOUT", ip: getClientIp() });
  }
  redirect("/login");
}
