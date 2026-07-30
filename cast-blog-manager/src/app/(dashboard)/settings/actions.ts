"use server";

import { revalidatePath } from "next/cache";

import { defineAction, ValidationError } from "@/lib/auth/authorize";
import { createStore, updateDraftSettings, updateStoreSettings } from "@/lib/dal/stores";
import { draftSettingsSchema, storeSettingsSchema } from "@/lib/validations";

export const updateStoreAction = defineAction("MANAGER", async (ctx, formData: FormData) => {
  const parsed = storeSettingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  }
  await updateStoreSettings(ctx.user, parsed.data);
  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return { ok: true };
});

/**
 * 文面作成の設定。
 *
 * 未チェックのチェックボックスは FormData に現れないため、
 * `Object.fromEntries` だけだとキーごと欠落する。
 * スキーマ側で optional にしたうえで false に落としている。
 */
export const updateDraftSettingsAction = defineAction("MANAGER", async (ctx, formData: FormData) => {
  const parsed = draftSettingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  }
  await updateDraftSettings(ctx.user, parsed.data);
  revalidatePath("/settings");
  return { ok: true };
});

export const createStoreAction = defineAction("ADMIN", async (ctx, formData: FormData) => {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new ValidationError("店舗名を入力してください");
  await createStore(ctx.user, name);
  revalidatePath("/settings");
  return { ok: true };
});
