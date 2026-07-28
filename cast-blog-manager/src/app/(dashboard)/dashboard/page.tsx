import Link from "next/link";

import { Badge, Card, EmptyState, PageHeader, Table } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/authorize";
import { getDashboard } from "@/lib/dal/dashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  const data = await getDashboard(user);

  return (
    <>
      <PageHeader
        title="ダッシュボード"
        description={`営業日 ${data.businessDate}（週の開始 ${data.weekStart}）時点の状況`}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-slate-600">在籍キャスト</p>
          <p className="mt-1 text-2xl font-bold">{data.totals.active}人</p>
        </Card>
        <Card>
          <p className="text-sm text-slate-600">要リマインド（未更新）</p>
          <p className="mt-1 text-2xl font-bold text-amber-600">{data.totals.stale}人</p>
        </Card>
        <Card>
          <p className="text-sm text-slate-600">今週の目標達成</p>
          <p className="mt-1 text-2xl font-bold text-emerald-600">
            {data.totals.achieved}/{data.totals.withTarget}人
          </p>
        </Card>
      </div>

      <Card>
        {data.casts.length === 0 ? (
          <EmptyState>
            キャストが登録されていません。
            <Link href="/casts" className="underline">
              キャスト管理
            </Link>
            から追加してください。
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <th className="py-2">キャスト</th>
                <th className="py-2">今週</th>
                <th className="py-2">最終更新</th>
                <th className="py-2">状態</th>
                <th className="py-2">LINE</th>
              </tr>
            }
          >
            {data.casts.map((c) => (
              <tr key={c.castId}>
                <td className="py-2">
                  <Link href={`/casts/${c.castId}`} className="font-medium hover:underline">
                    {c.castName}
                  </Link>
                  <span className="ml-2 text-xs text-slate-500">{c.storeName}</span>
                </td>
                <td className="py-2">
                  {c.progress.target === null
                    ? `${c.progress.postCount}回`
                    : `${c.progress.postCount}/${c.progress.target}回`}
                </td>
                <td className="py-2 text-slate-600">{c.lastPostBusinessDate ?? "記録なし"}</td>
                <td className="py-2">
                  {c.stale ? (
                    <Badge tone="warn">未更新</Badge>
                  ) : c.progress.achieved ? (
                    <Badge tone="ok">達成</Badge>
                  ) : (
                    <Badge>進行中</Badge>
                  )}
                </td>
                <td className="py-2">
                  {c.lineStatus === "LINKED" ? (
                    <Badge tone="ok">連携済</Badge>
                  ) : c.lineStatus === "BLOCKED" ? (
                    <Badge tone="danger">ブロック</Badge>
                  ) : (
                    <Badge>未連携</Badge>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
