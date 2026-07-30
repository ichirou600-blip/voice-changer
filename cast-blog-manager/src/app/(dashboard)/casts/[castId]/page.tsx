import { notFound } from "next/navigation";

import { Badge, Card, EmptyState, PageHeader, Table } from "@/components/ui";
import { hasRole, requireUserOrRedirect } from "@/lib/auth/authorize";
import { businessWeekStart, currentBusinessDate } from "@/lib/business-day";
import { getCast } from "@/lib/dal/casts";
import { listPosts } from "@/lib/dal/posts";
import { buildWeeklyProgress } from "@/lib/targets";
import { prisma } from "@/lib/prisma";
import { notVoided } from "@/lib/dal/posts";

import { CastDetailForms } from "./cast-detail-forms";

export const dynamic = "force-dynamic";

export default async function CastDetailPage({
  params,
}: {
  params: Promise<{ castId: string }>;
}) {
  const { castId } = await params;
  const user = await requireUserOrRedirect();
  const cast = await getCast(user, castId);
  if (!cast) notFound();

  const today = currentBusinessDate(cast.store.businessDayStart);
  const weekStart = businessWeekStart(today);

  const [weekCount, posts] = await Promise.all([
    prisma.blogPost.count({
      where: { castId: cast.id, businessWeekStart: weekStart, ...notVoided },
    }),
    listPosts(user, { castId: cast.id, limit: 50, includeVoided: true }),
  ]);

  const progress = buildWeeklyProgress(cast.targets, weekStart, weekCount);
  const canManage = hasRole(user, "MANAGER");

  return (
    <>
      <PageHeader
        title={cast.name}
        description={`${cast.store.name} / 営業日 ${today}（週の開始 ${weekStart}）`}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-slate-600">今週の更新</p>
          <p className="mt-1 text-2xl font-bold">
            {progress.postCount}
            {progress.target !== null ? ` / ${progress.target}` : ""} 回
          </p>
          {progress.target !== null ? (
            <p className="mt-1 text-xs text-slate-500">
              {progress.achieved ? "目標達成" : `あと ${progress.remaining} 回`}
            </p>
          ) : null}
        </Card>
        <Card>
          <p className="text-sm text-slate-600">在籍状況</p>
          <p className="mt-2">
            <Badge tone={cast.status === "ACTIVE" ? "ok" : cast.status === "RETIRED" ? "danger" : "neutral"}>
              {cast.status === "ACTIVE" ? "在籍" : cast.status === "INACTIVE" ? "休止" : "退店"}
            </Badge>
          </p>
        </Card>
        <Card>
          <p className="text-sm text-slate-600">LINE 連携</p>
          <p className="mt-2">
            {cast.lineStatus === "LINKED" ? (
              <Badge tone="ok">連携済</Badge>
            ) : cast.lineStatus === "BLOCKED" ? (
              <Badge tone="danger">ブロックされています</Badge>
            ) : (
              <Badge>未連携</Badge>
            )}
          </p>
        </Card>
      </div>

      <CastDetailForms
        castId={cast.id}
        castName={cast.name}
        status={cast.status}
        lineStatus={cast.lineStatus}
        canManage={canManage}
        pendingLinkCode={
          // 連携コードは MANAGER 以上にしか表示しない。
          // STAFF に見せると、キャスト本人より先に自分の LINE を紐付けられてしまう。
          canManage &&
          cast.lineLinkCode &&
          cast.lineLinkCodeExpiresAt &&
          cast.lineLinkCodeExpiresAt > new Date()
            ? cast.lineLinkCode
            : null
        }
        draftEnabled={cast.store.draftEnabled}
        writingProfile={
          cast.writingProfile
            ? {
                firstPerson: cast.writingProfile.firstPerson,
                toneNote: cast.writingProfile.toneNote,
                topics: cast.writingProfile.topics,
                emojiLevel: cast.writingProfile.emojiLevel,
                ngWords: cast.writingProfile.ngWords,
              }
            : null
        }
      />

      <Card className="mt-6">
        <h2 className="mb-3 text-sm font-semibold">週次目標の履歴</h2>
        {cast.targets.length === 0 ? (
          <EmptyState>目標が設定されていません。</EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <th className="py-2">適用開始（週の月曜）</th>
                <th className="py-2">週の目標回数</th>
              </tr>
            }
          >
            {cast.targets.map((t) => (
              <tr key={t.id}>
                <td className="py-2">{t.effectiveFrom}</td>
                <td className="py-2">{t.postsPerWeek} 回</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card className="mt-6">
        <h2 className="mb-3 text-sm font-semibold">更新記録</h2>
        {posts.length === 0 ? (
          <EmptyState>まだ記録がありません。</EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <th className="py-2">営業日</th>
                <th className="py-2">タイトル</th>
                <th className="py-2">入力元</th>
                <th className="py-2">状態</th>
              </tr>
            }
          >
            {posts.map((p) => (
              <tr key={p.id} className={p.voidedAt ? "text-slate-400" : ""}>
                <td className="py-2">{p.businessDate}</td>
                <td className="py-2">{p.title ?? "（タイトルなし）"}</td>
                <td className="py-2">{p.source === "CAST_LINE" ? "LINE自己申告" : "スタッフ入力"}</td>
                <td className="py-2">
                  {p.voidedAt ? <Badge tone="danger">無効化</Badge> : <Badge tone="ok">有効</Badge>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
