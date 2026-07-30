import "server-only";

import { writeAudit } from "@/lib/audit";
import { assertStoreAccess, storeScope, ValidationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export async function listStores(user: SessionUser) {
  return prisma.store.findMany({
    where: user.role === "ADMIN" ? {} : { id: storeScope(user).storeId },
    orderBy: { name: "asc" },
  });
}

export async function getStore(user: SessionUser, storeId: string) {
  assertStoreAccess(user, storeId);
  return prisma.store.findUnique({ where: { id: storeId } });
}

export async function updateStoreSettings(
  user: SessionUser,
  input: {
    storeId: string;
    name: string;
    businessDayStart: number;
    reminderHour: number;
    daysStaleThreshold: number;
  },
) {
  assertStoreAccess(user, input.storeId);
  const store = await prisma.store.findUnique({ where: { id: input.storeId } });
  if (!store) throw new ValidationError("店舗が見つかりません");

  const updated = await prisma.store.update({
    where: { id: store.id },
    data: {
      name: input.name,
      businessDayStart: input.businessDayStart,
      reminderHour: input.reminderHour,
      daysStaleThreshold: input.daysStaleThreshold,
    },
  });

  await writeAudit({
    actorUserId: user.id,
    action: "STORE_UPDATED",
    targetType: "Store",
    targetId: store.id,
    detail: `区切り${input.businessDayStart}時 / リマインド${input.reminderHour}時 / ${input.daysStaleThreshold}日`,
  });

  return updated;
}

/**
 * 文面作成の店舗設定。
 *
 * `draftMonthlyLimit` は **null = 無制限**（既定）。
 * 0 は「無制限」ではなく「1件も作らせない」なので、両者を混同しないこと。
 */
export async function updateDraftSettings(
  user: SessionUser,
  input: {
    storeId: string;
    draftEnabled: boolean;
    draftMonthlyLimit: number | null;
    draftGuideline: string;
    draftNgWords: string;
  },
) {
  assertStoreAccess(user, input.storeId);
  const store = await prisma.store.findUnique({ where: { id: input.storeId } });
  if (!store) throw new ValidationError("店舗が見つかりません");

  const updated = await prisma.store.update({
    where: { id: store.id },
    data: {
      draftEnabled: input.draftEnabled,
      draftMonthlyLimit: input.draftMonthlyLimit,
      draftGuideline: input.draftGuideline,
      draftNgWords: input.draftNgWords,
    },
  });

  await writeAudit({
    actorUserId: user.id,
    action: "STORE_DRAFT_SETTINGS_UPDATED",
    targetType: "Store",
    targetId: store.id,
    detail: `${input.draftEnabled ? "有効" : "無効"} / 月間上限${
      input.draftMonthlyLimit === null ? "なし" : `${input.draftMonthlyLimit}回`
    }`,
  });

  return updated;
}

export async function createStore(user: SessionUser, name: string) {
  if (user.role !== "ADMIN") throw new ValidationError("店舗を追加できるのは管理者のみです");
  const store = await prisma.store.create({ data: { name } });
  await writeAudit({
    actorUserId: user.id,
    action: "STORE_CREATED",
    targetType: "Store",
    targetId: store.id,
    detail: name,
  });
  return store;
}
