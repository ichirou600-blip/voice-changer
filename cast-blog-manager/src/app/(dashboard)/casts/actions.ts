"use server";

import { revalidatePath } from "next/cache";

import { writeAudit } from "@/lib/audit";
import { defineAction, ValidationError } from "@/lib/auth/authorize";
import { generateLinkCode } from "@/lib/auth/tokens";
import { createCast, getCast, setCastTarget, updateCast } from "@/lib/dal/casts";
import { prisma } from "@/lib/prisma";
import { castCreateSchema, castTargetSchema, castUpdateSchema } from "@/lib/validations";

/**
 * キャスト関連の Server Action。
 *
 * **必ず `defineAction` で包む**（生の "use server" 関数を作らない）。
 * defineAction が認証・ロール検証・例外の正規化をまとめて行うため、
 * 認可の書き忘れによるフェイルオープンが構造的に起きない。
 */

/** LINE 連携コードの有効期間 */
const LINK_CODE_TTL_MS = 24 * 60 * 60 * 1000;

export const createCastAction = defineAction("MANAGER", async (ctx, formData: FormData) => {
  const parsed = castCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues[0]?.message ?? "入力内容を確認してください",
    );
  }
  const cast = await createCast(ctx.user, parsed.data);
  await writeAudit({
    actorUserId: ctx.user.id,
    action: "CAST_CREATED",
    targetType: "Cast",
    targetId: cast.id,
    detail: cast.name,
  });
  revalidatePath("/casts");
  revalidatePath("/dashboard");
  return { castId: cast.id };
});

export const updateCastAction = defineAction("MANAGER", async (ctx, formData: FormData) => {
  const parsed = castUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  }
  const cast = await updateCast(ctx.user, parsed.data);
  await writeAudit({
    actorUserId: ctx.user.id,
    action: parsed.data.status === "RETIRED" ? "CAST_RETIRED" : "CAST_UPDATED",
    targetType: "Cast",
    targetId: cast.id,
    detail: `${cast.name} / ${cast.status}`,
  });
  revalidatePath("/casts");
  revalidatePath(`/casts/${cast.id}`);
  revalidatePath("/dashboard");
  return { ok: true };
});

export const setCastTargetAction = defineAction("MANAGER", async (ctx, formData: FormData) => {
  const parsed = castTargetSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  }
  const target = await setCastTarget(ctx.user, parsed.data);
  await writeAudit({
    actorUserId: ctx.user.id,
    action: "CAST_TARGET_CHANGED",
    targetType: "Cast",
    targetId: parsed.data.castId,
    detail: `週${target.postsPerWeek}回 / ${target.effectiveFrom}〜`,
  });
  revalidatePath(`/casts/${parsed.data.castId}`);
  revalidatePath("/dashboard");
  return { effectiveFrom: target.effectiveFrom };
});

/**
 * LINE 連携用のワンタイムコードを発行する（キャスト本人に手渡す）。
 *
 * 実装レビューで「STAFF が任意のキャストのコードを発行し、
 * 自分の LINE を紐付けて実績を捏造できる」と指摘されたため MANAGER 以上に限定した。
 * （解除も MANAGER のみなので、STAFF は不正な紐付けを作ることも直すこともできない）
 */
export const issueLinkCodeAction = defineAction("MANAGER", async (ctx, castId: string) => {
  const cast = await getCast(ctx.user, castId);
  if (!cast) throw new ValidationError("キャストが見つかりません");
  if (cast.lineStatus === "LINKED") throw new ValidationError("既に連携済みです");

  // 衝突しないコードを引き当てる（極めて低確率だが念のため再試行）。
  // 最終回で衝突したまま抜けないよう、必ず検証してから採用する。
  let code: string | null = null;
  for (let i = 0; i < 5; i++) {
    const candidate = generateLinkCode();
    const clash = await prisma.cast.findFirst({ where: { lineLinkCode: candidate } });
    if (!clash) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new ValidationError("連携コードを発行できませんでした。再度お試しください。");

  await prisma.cast.update({
    where: { id: cast.id },
    data: {
      lineLinkCode: code,
      lineLinkCodeExpiresAt: new Date(Date.now() + LINK_CODE_TTL_MS),
    },
  });

  await writeAudit({
    actorUserId: ctx.user.id,
    action: "CAST_LINE_CODE_ISSUED",
    targetType: "Cast",
    targetId: cast.id,
    detail: cast.name,
  });

  revalidatePath(`/casts/${cast.id}`);
  return { code };
});

/** LINE 連携を解除する（機種変更・誤連携の是正） */
export const unlinkLineAction = defineAction("MANAGER", async (ctx, castId: string) => {
  const cast = await getCast(ctx.user, castId);
  if (!cast) throw new ValidationError("キャストが見つかりません");

  await prisma.cast.update({
    where: { id: cast.id },
    data: {
      lineUserId: null,
      lineStatus: "NOT_LINKED",
      lineLinkCode: null,
      lineLinkCodeExpiresAt: null,
    },
  });

  await writeAudit({
    actorUserId: ctx.user.id,
    action: "CAST_LINE_UNLINKED",
    targetType: "Cast",
    targetId: cast.id,
    detail: cast.name,
  });

  revalidatePath(`/casts/${cast.id}`);
  revalidatePath("/casts");
  revalidatePath("/dashboard");
  return { ok: true };
});
