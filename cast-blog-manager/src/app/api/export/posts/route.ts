import { NextResponse } from "next/server";

import { storeScope } from "@/lib/auth/authorize";
import { getSessionUser } from "@/lib/auth/session";
import { contentDisposition, toCsv } from "@/lib/csv";
import { notVoided } from "@/lib/dal/posts";
import { prisma } from "@/lib/prisma";

/**
 * 更新記録の CSV 出力。
 *
 * 給与計算・実績確認に使うため、無効化された記録も理由つきで含める
 * （「消えた」のではなく「無効化された」ことが分かる形にする）。
 *
 * 認可は他のページと同じくセッションと店舗スコープで行う。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const includeVoided = url.searchParams.get("includeVoided") === "1";

  const posts = await prisma.blogPost.findMany({
    where: {
      cast: { ...storeScope(user) },
      ...(includeVoided ? {} : notVoided),
      ...(from || to
        ? { businessDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    },
    orderBy: [{ businessDate: "asc" }, { postedAt: "asc" }],
    include: {
      cast: { select: { name: true, store: { select: { name: true } } } },
      recordedBy: { select: { name: true } },
      voidedBy: { select: { name: true } },
    },
  });

  const csv = toCsv(
    [
      "営業日",
      "週開始日",
      "店舗",
      "キャスト",
      "タイトル",
      "URL",
      "入力元",
      "記録者",
      "状態",
      "無効化理由",
      "無効化した人",
      "登録日時",
    ],
    posts.map((p) => [
      p.businessDate,
      p.businessWeekStart,
      p.cast.store.name,
      p.cast.name,
      p.title ?? "",
      p.url ?? "",
      p.source === "CAST_LINE" ? "LINE自己申告" : "スタッフ入力",
      p.recordedBy?.name ?? "",
      p.voidedAt ? "無効" : "有効",
      p.voidReason ?? "",
      p.voidedBy?.name ?? "",
      p.createdAt.toISOString(),
    ]),
  );

  const filename = `更新記録_${from ?? "全期間"}_${to ?? ""}.csv`.replace(/_+\.csv$/, ".csv");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition(filename),
      "Cache-Control": "no-store",
    },
  });
}
