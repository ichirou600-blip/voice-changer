import Link from "next/link";

import { Badge, Card, EmptyState, PageHeader, Table } from "@/components/ui";
import { hasRole, requireUserOrRedirect } from "@/lib/auth/authorize";
import { listCasts } from "@/lib/dal/casts";
import { listStores } from "@/lib/dal/stores";

import { CastCreateForm } from "./cast-create-form";

export const dynamic = "force-dynamic";

const STATUS_LABEL = { ACTIVE: "在籍", INACTIVE: "休止", RETIRED: "退店" } as const;

export default async function CastsPage() {
  const user = await requireUserOrRedirect();
  const [casts, stores] = await Promise.all([
    listCasts(user, { includeInactive: true }),
    listStores(user),
  ]);
  const canManage = hasRole(user, "MANAGER");

  return (
    <>
      <PageHeader title="キャスト管理" description="在籍状況と週次目標を管理します。" />

      {canManage ? (
        <Card className="mb-6">
          <h2 className="mb-3 text-sm font-semibold">キャストを追加</h2>
          <CastCreateForm stores={stores.map((s) => ({ id: s.id, name: s.name }))} />
        </Card>
      ) : null}

      <Card>
        {casts.length === 0 ? (
          <EmptyState>キャストがまだ登録されていません。</EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <th className="py-2">源氏名</th>
                <th className="py-2">店舗</th>
                <th className="py-2">在籍</th>
                <th className="py-2">LINE</th>
                <th className="py-2"></th>
              </tr>
            }
          >
            {casts.map((c) => (
              <tr key={c.id}>
                <td className="py-2 font-medium">{c.name}</td>
                <td className="py-2 text-slate-600">{c.storeName}</td>
                <td className="py-2">
                  <Badge tone={c.status === "ACTIVE" ? "ok" : c.status === "RETIRED" ? "danger" : "neutral"}>
                    {STATUS_LABEL[c.status]}
                  </Badge>
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
                <td className="py-2 text-right">
                  <Link href={`/casts/${c.id}`} className="text-sm underline">
                    詳細
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
