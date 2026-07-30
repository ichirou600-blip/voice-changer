"use server";

import { assertSameOriginRequest, ValidationError } from "@/lib/auth/authorize";
import { createPostFromLine } from "@/lib/dal/posts";
import { generateDrafts } from "@/lib/dal/drafts";
import { verifyCastToken } from "@/lib/draft/cast-link";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { draftGenerateSchema } from "@/lib/validations";

/**
 * キャスト用画面の Server Action。
 *
 * 管理画面の Action は `defineAction`（セッション + ロール）で包む規約だが、
 * ここはキャストがログインを持たないため使えない。
 * 代わりに **フォームに載せた署名付きトークンを毎回検証する**。
 *
 * 守ること:
 * - トークン検証を最初に行い、castId は必ずトークンから取り出す。
 *   フォームの castId を信用すると、他人になりすませてしまう。
 * - Origin 照合（CSRF）は管理画面と同じく必ず通す。
 * - 失敗の理由を細かく返さない（トークンの探索の手がかりになる）。
 */

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; retryable?: boolean };

/** トークンを検証して、在籍中のキャストを返す */
async function resolveCast(token: unknown) {
  if (typeof token !== "string" || token.length === 0) return null;
  const verdict = verifyCastToken(token);
  if (!verdict.ok) return null;

  const cast = await prisma.cast.findUnique({
    where: { id: verdict.castId },
    include: { store: true },
  });
  if (!cast || cast.status !== "ACTIVE") return null;
  return cast;
}

const EXPIRED_MESSAGE =
  "リンクの有効期限が切れています。LINEのメニューからもう一度開いてください。";

/** 文面を生成する */
export async function generateDraftsAction(
  formData: FormData,
): Promise<ActionResult<{ drafts: string[]; warnings: string[] }>> {
  try {
    await assertSameOriginRequest();

    const cast = await resolveCast(formData.get("token"));
    if (!cast) return { ok: false, error: EXPIRED_MESSAGE };

    const parsed = draftGenerateSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
    }

    const result = await generateDrafts({
      castId: cast.id,
      themeKey: parsed.data.theme,
      keywords: parsed.data.keywords ?? "",
      targetLength: parsed.data.length,
    });

    if (!result.ok) return { ok: false, error: result.error, retryable: result.retryable };
    return { ok: true, data: { drafts: result.drafts, warnings: result.warnings } };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, error: error.message };
    logger.error("draft.action_failed", error);
    return { ok: false, error: "処理に失敗しました。時間をおいてお試しください。", retryable: true };
  }
}

/**
 * 「投稿しました」の記録。
 *
 * LINE の自己申告と同じ扱い（PostSource.CAST_LINE）にする。
 * 経路が違うだけで、本人の申告であることは変わらないため。
 */
export async function reportPostedAction(
  formData: FormData,
): Promise<ActionResult<{ created: boolean; businessDate: string }>> {
  try {
    await assertSameOriginRequest();

    const cast = await resolveCast(formData.get("token"));
    if (!cast) return { ok: false, error: EXPIRED_MESSAGE };

    const result = await createPostFromLine({
      castId: cast.id,
      storeBusinessDayStart: cast.store.businessDayStart,
      which: "today",
    });
    return { ok: true, data: result };
  } catch (error) {
    logger.error("draft.report_failed", error);
    return { ok: false, error: "記録できませんでした。LINEから報告してください。", retryable: true };
  }
}
