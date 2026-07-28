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
  const result = await runReminders();
  await writeAudit({
    actorUserId: ctx.user.id,
    action: "REMINDER_RUN",
    detail: `手動実行 sent=${result.sent} failed=${result.failed} targeted=${result.targeted}`,
  });
  revalidatePath("/settings");
  return result;
});

export const getQuotaAction = defineAction("STAFF", async () => getQuotaStatus());
