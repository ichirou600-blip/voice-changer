import { Badge, Card, PageHeader, Table } from "@/components/ui";
import { hasRole, requireUserOrRedirect } from "@/lib/auth/authorize";
import { listStores } from "@/lib/dal/stores";
import { listUsers } from "@/lib/dal/users";

import { InviteForm, UserRowActions } from "./user-forms";

export const dynamic = "force-dynamic";

const ROLE_LABEL = { ADMIN: "管理者", MANAGER: "店長", STAFF: "スタッフ" } as const;

export default async function UsersPage() {
  const user = await requireUserOrRedirect();
  const [users, stores] = await Promise.all([listUsers(user), listStores(user)]);
  const canManage = hasRole(user, "MANAGER");

  return (
    <>
      <PageHeader
        title="スタッフ管理"
        description="招待リンク・パスワード再設定リンクを発行して本人に手渡してください（メールは送信されません）。"
      />

      {canManage ? (
        <Card className="mb-6">
          <h2 className="mb-3 text-sm font-semibold">スタッフを招待</h2>
          <InviteForm
            stores={stores.map((s) => ({ id: s.id, name: s.name }))}
            canInviteAdmin={hasRole(user, "ADMIN")}
          />
        </Card>
      ) : null}

      <Card>
        <Table
          head={
            <tr>
              <th className="py-2">名前</th>
              <th className="py-2">メールアドレス</th>
              <th className="py-2">権限</th>
              <th className="py-2">店舗</th>
              <th className="py-2">状態</th>
              {canManage ? <th className="py-2"></th> : null}
            </tr>
          }
        >
          {users.map((u) => (
            <tr key={u.id} className={u.isActive ? "" : "text-slate-400"}>
              <td className="py-2 font-medium">{u.name}</td>
              <td className="py-2">{u.email}</td>
              <td className="py-2">{ROLE_LABEL[u.role]}</td>
              <td className="py-2">{u.store?.name ?? "-"}</td>
              <td className="py-2">
                {u.isActive ? <Badge tone="ok">有効</Badge> : <Badge tone="danger">無効</Badge>}
              </td>
              {canManage ? (
                <td className="py-2 text-right">
                  <UserRowActions
                    userId={u.id}
                    isActive={u.isActive}
                    isSelf={u.id === user.id}
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
