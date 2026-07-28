"use server";

import { revalidatePath } from "next/cache";

import { writeAudit } from "@/lib/audit";
import { defineAction } from "@/lib/auth/authorize";
import { getQuotaStatus } from "@/lib/quota";
import { runReminders } from "@/lib/reminder-runner";

/**
 * 管理画面からの「今すぐリマインドを実行」。
 *
 * cron エンドポイントと同じ処理を呼ぶため、スケジューラが無くても運用できる。
 * 冪等なので、押しすぎても二重送信にはならない。
 */
export const runRemindersNowAction = defineAction("MANAGER", async (ctx) => {
  // 非 ADMIN が押したときに他店舗のリマインドまで発火し、
  // 共有の月間送信枠を消費してしまわないよう自店舗に限定する
  const result = await runReminders(
    new Date(),
    ctx.user.role === "ADMIN" ? {} : { storeIds: ctx.user.storeId ? [ctx.user.storeId] : [] },
  );
  await writeAudit({
    actorUserId: ctx.user.id,
    action: "REMINDER_RUN",
    detail: `手動実行 sent=${result.sent} failed=${result.failed} targeted=${result.targeted}`,
  });
  revalidatePath("/settings");
  return result;
});

export const getQuotaAction = defineAction("MANAGER", async () => getQuotaStatus());
