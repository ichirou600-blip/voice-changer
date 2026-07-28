import { NextResponse } from "next/server";

import { writeAudit } from "@/lib/audit";
import { purgeExpiredSessions } from "@/lib/auth/session";
import { purgeOldLoginAttempts } from "@/lib/auth/rate-limit";
import { runReminders } from "@/lib/reminder-runner";

/**
 * リマインド実行エンドポイント（トリガー非依存）。
 *
 * 呼び出し元は次のいずれでもよい:
 * - GitHub Actions の schedule（無料・既定）
 * - Vercel Cron（Pro プラン）
 * - 管理画面の「今すぐ実行」ボタン
 *
 * いずれから何度呼ばれても、LineMessageLog のユニーク制約と
 * decideSend の判定により「1営業日1通」に収束する（冪等）。
 *
 * 認可は `CRON_SECRET` の Bearer トークンのみ（Cookie は使わない）。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;

  // Vercel Cron は独自ヘッダを付与するため、そちらも許容する
  return request.headers.get("x-vercel-cron-secret") === secret;
}

async function handle(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const reminders = await runReminders();

  // ついでに期限切れレコードを掃除する（DB 肥大化の防止）
  const [purgedSessions, purgedAttempts] = await Promise.all([
    purgeExpiredSessions(),
    purgeOldLoginAttempts(),
  ]);

  await writeAudit({
    action: "REMINDER_RUN",
    detail: `sent=${reminders.sent} failed=${reminders.failed} targeted=${reminders.targeted}`,
  });

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - started,
    reminders,
    purged: { sessions: purgedSessions, loginAttempts: purgedAttempts },
  });
}

export async function POST(request: Request) {
  return handle(request);
}

/**
 * Vercel Cron は GET で呼び出すため GET も受ける。
 * 「GET で状態を変えない」原則の例外だが、
 * CRON_SECRET を知る呼び出し元しか実行できず、かつ冪等であるため許容する。
 */
export async function GET(request: Request) {
  return handle(request);
}
