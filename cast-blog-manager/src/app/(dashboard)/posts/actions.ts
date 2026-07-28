"use server";

import { revalidatePath } from "next/cache";

import { defineAction, ValidationError } from "@/lib/auth/authorize";
import { createPostByStaff, voidPost } from "@/lib/dal/posts";
import { postCreateSchema, postVoidSchema } from "@/lib/validations";

/** 更新記録の Server Action（必ず defineAction で認可を通す） */

export const createPostAction = defineAction("STAFF", async (ctx, formData: FormData) => {
  const raw = Object.fromEntries(formData);
  const parsed = postCreateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  }
  const post = await createPostByStaff(ctx.user, {
    castId: parsed.data.castId,
    businessDate: parsed.data.businessDate || undefined,
    title: parsed.data.title || undefined,
    url: parsed.data.url || undefined,
  });
  revalidatePath("/posts");
  revalidatePath("/dashboard");
  revalidatePath(`/casts/${parsed.data.castId}`);
  return { postId: post.id };
});

/** 記録の無効化は MANAGER 以上に限定する（実績の改ざん防止） */
export const voidPostAction = defineAction("MANAGER", async (ctx, formData: FormData) => {
  const parsed = postVoidSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "理由を入力してください");
  }
  await voidPost(ctx.user, parsed.data);
  revalidatePath("/posts");
  revalidatePath("/dashboard");
  return { ok: true };
});
