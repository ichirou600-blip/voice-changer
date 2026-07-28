import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

/**
 * ヘルスチェック。
 * 死活監視サービス（UptimeRobot 等）から定期的に叩く想定。
 *
 * 認証情報や設定値は返さない（有無だけを返す）。
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, boolean> = {
    database: false,
    lineConfigured: Boolean(
      process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET,
    ),
    cronConfigured: Boolean(process.env.CRON_SECRET),
    appUrlConfigured: Boolean(process.env.APP_URL),
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch {
    checks.database = false;
  }

  const healthy = checks.database;

  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks, time: new Date().toISOString() },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
