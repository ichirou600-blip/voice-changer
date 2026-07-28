"use server";

import { redirect } from "next/navigation";

import { getClientIp } from "@/lib/audit";
import { toUserMessage } from "@/lib/auth/authorize";
import { redeemInvitation } from "@/lib/dal/users";
import { acceptInvitationSchema, parseForm } from "@/lib/validations";

export type AcceptState = { error?: string };

/**
 * 招待 / パスワード再設定の確定。
 *
 * トークンは **この POST でのみ消費される**。
 * （GET でのプレビュー表示では消費しないため、
 *   LINE などのリンクプレビュー bot が URL を踏んでもリンクが切れない）
 */
export async function acceptAction(_prev: AcceptState, formData: FormData): Promise<AcceptState> {
  const parsed = parseForm(acceptInvitationSchema, formData);
  if (!parsed.ok) return { error: parsed.error };

  try {
    await redeemInvitation({
      token: parsed.data.token,
      password: parsed.data.password,
      ip: getClientIp(),
    });
  } catch (error) {
    return { error: toUserMessage(error) };
  }

  redirect("/login?reset=done");
}
