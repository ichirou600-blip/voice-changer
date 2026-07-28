import "server-only";

import { assertStoreAccess, storeScope, ValidationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { addDays, businessWeekStart, currentBusinessDate } from "@/lib/business-day";
import { prisma } from "@/lib/prisma";

/**
 * キャストの Data Access Layer。
 *
 * 設計レビューでの指摘（IDOR）への対策:
 * **全てのクエリに `storeScope(user)` を必ず混ぜる。**
 * ID を引数で受け取る関数は、取得後に必ず `assertStoreAccess` で
 * 所属店舗を検証してから返す（他店舗の ID を渡されても 404 相当にする）。
 */

export type CastListItem = {
  id: string;
  name: string;
  status: "ACTIVE" | "INACTIVE" | "RETIRED";
  lineStatus: "NOT_LINKED" | "LINKED" | "BLOCKED";
  storeId: string;
  storeName: string;
};

export async function listCasts(
  user: SessionUser,
  options: { includeInactive?: boolean } = {},
): Promise<CastListItem[]> {
  const casts = await prisma.cast.findMany({
    where: {
      ...storeScope(user),
      ...(options.includeInactive ? {} : { status: { not: "RETIRED" } }),
    },
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: { store: { select: { name: true } } },
  });

  return casts.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    lineStatus: c.lineStatus,
    storeId: c.storeId,
    storeName: c.store.name,
  }));
}

/** 単一キャストを取得する。他店舗のものは null（存在を漏らさない） */
export async function getCast(user: SessionUser, castId: string) {
  const cast = await prisma.cast.findFirst({
    where: { id: castId, ...storeScope(user) },
    include: {
      store: true,
      targets: { orderBy: { effectiveFrom: "desc" } },
    },
  });
  return cast;
}

export async function createCast(
  user: SessionUser,
  input: { storeId: string; name: string; postsPerWeek: number },
) {
  assertStoreAccess(user, input.storeId);

  const store = await prisma.store.findUnique({ where: { id: input.storeId } });
  if (!store) throw new ValidationError("店舗が見つかりません");

  const duplicate = await prisma.cast.findFirst({
    where: { storeId: input.storeId, name: input.name },
  });
  if (duplicate) throw new ValidationError("同じ源氏名のキャストが既に登録されています");

  // 初回の目標は「今週の頭」から適用する
  const today = currentBusinessDate(store.businessDayStart);
  return prisma.cast.create({
    data: {
      storeId: input.storeId,
      name: input.name,
      targets: {
        create: { postsPerWeek: input.postsPerWeek, effectiveFrom: businessWeekStart(today) },
      },
    },
  });
}

export async function updateCast(
  user: SessionUser,
  input: { castId: string; name: string; status: "ACTIVE" | "INACTIVE" | "RETIRED" },
) {
  const cast = await getCast(user, input.castId);
  if (!cast) throw new ValidationError("キャストが見つかりません");

  const duplicate = await prisma.cast.findFirst({
    where: { storeId: cast.storeId, name: input.name, id: { not: cast.id } },
  });
  if (duplicate) throw new ValidationError("同じ源氏名のキャストが既に登録されています");

  // 退店時は LINE 連携も解除する。
  // 残したままだと、退店者の端末が follow などで反応し続け、
  // 後で在籍に戻したときに旧端末の紐付けが黙って復活する。
  const clearLine =
    input.status === "RETIRED"
      ? {
          lineUserId: null,
          lineStatus: "NOT_LINKED" as const,
          lineLinkCode: null,
          lineLinkCodeExpiresAt: null,
        }
      : {};

  return prisma.cast.update({
    where: { id: cast.id },
    data: { name: input.name, status: input.status, ...clearLine },
  });
}

/**
 * 週次目標を変更する。
 * 既存レコードは書き換えず履歴として追加する（過去週の達成判定を保全）。
 * 既定では「次に開始する週」から適用し、進行中の週の判定を動かさない。
 */
export async function setCastTarget(
  user: SessionUser,
  input: { castId: string; postsPerWeek: number; effectiveFrom?: string },
) {
  const cast = await getCast(user, input.castId);
  if (!cast) throw new ValidationError("キャストが見つかりません");

  const today = currentBusinessDate(cast.store.businessDayStart);
  const effectiveFrom = input.effectiveFrom ?? addDays(businessWeekStart(today), 7);

  // 同じ適用開始日の目標が既にあれば上書き（重複した履歴を作らない）
  const existing = await prisma.castTarget.findFirst({
    where: { castId: cast.id, effectiveFrom },
  });
  if (existing) {
    return prisma.castTarget.update({
      where: { id: existing.id },
      data: { postsPerWeek: input.postsPerWeek },
    });
  }

  return prisma.castTarget.create({
    data: { castId: cast.id, postsPerWeek: input.postsPerWeek, effectiveFrom },
  });
}
