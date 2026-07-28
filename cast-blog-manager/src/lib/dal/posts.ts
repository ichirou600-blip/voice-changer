import "server-only";

import { writeAudit } from "@/lib/audit";
import { storeScope, ValidationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  addDays,
  businessWeekStart,
  currentBusinessDate,
  parseBusinessDate,
  toBusinessDate,
} from "@/lib/business-day";
import { prisma } from "@/lib/prisma";

/**
 * ブログ更新記録の DAL。
 *
 * - 記録は物理削除せず論理無効化（voidedAt）する
 * - businessDate / businessWeekStart は書き込み時に確定させる
 * - 全クエリを店舗スコープで絞る
 */

/** 有効な（無効化されていない）記録に絞る条件 */
export const notVoided = { voidedAt: null } as const;

export type PostListItem = {
  id: string;
  castId: string;
  castName: string;
  title: string | null;
  url: string | null;
  postedAt: Date;
  businessDate: string;
  source: "CAST_LINE" | "STAFF_ENTRY";
  recordedByName: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
};

export async function listPosts(
  user: SessionUser,
  options: { castId?: string; limit?: number; includeVoided?: boolean } = {},
): Promise<PostListItem[]> {
  const posts = await prisma.blogPost.findMany({
    where: {
      cast: { ...storeScope(user) },
      ...(options.castId ? { castId: options.castId } : {}),
      ...(options.includeVoided ? {} : notVoided),
    },
    orderBy: [{ businessDate: "desc" }, { postedAt: "desc" }],
    take: options.limit ?? 100,
    include: {
      cast: { select: { name: true } },
      recordedBy: { select: { name: true } },
    },
  });

  return posts.map((p) => ({
    id: p.id,
    castId: p.castId,
    castName: p.cast.name,
    title: p.title,
    url: p.url,
    postedAt: p.postedAt,
    businessDate: p.businessDate,
    source: p.source,
    recordedByName: p.recordedBy?.name ?? null,
    voidedAt: p.voidedAt,
    voidReason: p.voidReason,
  }));
}

/**
 * スタッフによる更新記録の作成。
 *
 * businessDate を明示指定した場合は、その営業日の営業開始時刻を postedAt とみなす
 * （過去日の記録を後から入力できるようにするため）。
 */
export async function createPostByStaff(
  user: SessionUser,
  input: { castId: string; businessDate?: string; title?: string; url?: string },
  now: Date = new Date(),
) {
  const cast = await prisma.cast.findFirst({
    where: { id: input.castId, ...storeScope(user) },
    include: { store: true },
  });
  if (!cast) throw new ValidationError("キャストが見つかりません");
  if (cast.status === "RETIRED") throw new ValidationError("退店したキャストには記録できません");

  const todayBusinessDate = currentBusinessDate(cast.store.businessDayStart, now);
  const businessDate = input.businessDate ?? todayBusinessDate;

  if (businessDate > todayBusinessDate) {
    throw new ValidationError("未来の日付には記録できません");
  }

  // 指定営業日の場合、postedAt はその営業日の開始時刻（JST）を UTC で表したもの
  const postedAt =
    input.businessDate && input.businessDate !== todayBusinessDate
      ? businessDateStartInstant(input.businessDate, cast.store.businessDayStart)
      : now;

  const post = await prisma.blogPost.create({
    data: {
      castId: cast.id,
      title: input.title?.trim() || null,
      url: input.url?.trim() || null,
      postedAt,
      businessDate,
      businessWeekStart: businessWeekStart(businessDate),
      source: "STAFF_ENTRY",
      recordedById: user.id,
    },
  });

  await writeAudit({
    actorUserId: user.id,
    action: "POST_CREATED",
    targetType: "BlogPost",
    targetId: post.id,
    detail: `${cast.name} / ${businessDate}`,
  });

  return post;
}

/**
 * 営業日の開始時刻（JST の businessDayStart 時）を表す Date を返す。
 * 過去日の記録に postedAt を与えるために使う。
 */
export function businessDateStartInstant(businessDate: string, businessDayStart: number): Date {
  const base = parseBusinessDate(businessDate); // UTC 深夜0時
  // JST の businessDayStart 時 = UTC で (businessDayStart - 9) 時
  return new Date(base.getTime() + (businessDayStart - 9) * 60 * 60 * 1000);
}

/** 記録を論理無効化する（物理削除しない） */
export async function voidPost(user: SessionUser, input: { postId: string; reason: string }) {
  const post = await prisma.blogPost.findFirst({
    where: { id: input.postId, cast: { ...storeScope(user) } },
    include: { cast: { select: { name: true } } },
  });
  if (!post) throw new ValidationError("記録が見つかりません");
  if (post.voidedAt) throw new ValidationError("この記録は既に無効化されています");

  const updated = await prisma.blogPost.update({
    where: { id: post.id },
    data: { voidedAt: new Date(), voidedById: user.id, voidReason: input.reason },
  });

  await writeAudit({
    actorUserId: user.id,
    action: "POST_VOIDED",
    targetType: "BlogPost",
    targetId: post.id,
    detail: `${post.cast.name} / ${post.businessDate} / 理由: ${input.reason}`,
  });

  return updated;
}

/**
 * キャスト本人の LINE 自己申告による記録。
 * 誤タップ・連打による量産を防ぐため、直近の重複をここで弾く。
 */
export const SELF_REPORT_DEDUPE_WINDOW_MS = 10 * 60 * 1000; // 10分

export async function createPostFromLine(input: {
  castId: string;
  storeBusinessDayStart: number;
  /** "today" | "yesterday" */
  which: "today" | "yesterday";
  now?: Date;
}): Promise<{ created: boolean; businessDate: string }> {
  const now = input.now ?? new Date();
  const today = toBusinessDate(now, input.storeBusinessDayStart);
  const businessDate = input.which === "today" ? today : addDays(today, -1);

  // 直近ウィンドウ内に同じキャストの自己申告があれば作成しない（連打ガード）
  const recent = await prisma.blogPost.findFirst({
    where: {
      castId: input.castId,
      source: "CAST_LINE",
      createdAt: { gte: new Date(now.getTime() - SELF_REPORT_DEDUPE_WINDOW_MS) },
      ...notVoided,
    },
  });
  if (recent) return { created: false, businessDate };

  await prisma.blogPost.create({
    data: {
      castId: input.castId,
      postedAt:
        input.which === "today"
          ? now
          : businessDateStartInstant(businessDate, input.storeBusinessDayStart),
      businessDate,
      businessWeekStart: businessWeekStart(businessDate),
      source: "CAST_LINE",
      // 重複ガードの基準時刻を DB の now() ではなく渡された now に揃える。
      // （DB 側の時計と混在させると判定がずれるため）
      createdAt: now,
    },
  });

  return { created: true, businessDate };
}
