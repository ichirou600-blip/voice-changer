import { Card, EmptyState, PageHeader } from "@/components/ui";
import { hasRole, requireUserOrRedirect } from "@/lib/auth/authorize";
import { listStores } from "@/lib/dal/stores";
import { getQuotaStatus } from "@/lib/quota";

import { ReminderPanel } from "./reminder-panel";
import { StoreForm, StoreCreateForm } from "./store-forms";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUserOrRedirect();
  const [stores, quota] = await Promise.all([listStores(user), getQuotaStatus()]);
  const canManage = hasRole(user, "MANAGER");

  return (
    <>
      <PageHeader
        title="設定"
        description="営業日の区切り時刻やリマインドの条件を店舗ごとに設定します。"
      />

      {canManage ? (
        <Card className="mb-6">
          <h2 className="mb-3 text-sm font-semibold">リマインド</h2>
          <ReminderPanel quota={quota} />
        </Card>
      ) : null}

      {hasRole(user, "ADMIN") ? (
        <Card className="mb-6">
          <h2 className="mb-3 text-sm font-semibold">店舗を追加</h2>
          <StoreCreateForm />
        </Card>
      ) : null}

      {stores.length === 0 ? (
        <EmptyState>店舗がありません。</EmptyState>
      ) : (
        <div className="space-y-4">
          {stores.map((s) => (
            <Card key={s.id}>
              <h2 className="mb-3 text-sm font-semibold">{s.name}</h2>
              {canManage ? (
                <StoreForm
                  store={{
                    id: s.id,
                    name: s.name,
                    businessDayStart: s.businessDayStart,
                    reminderHour: s.reminderHour,
                    daysStaleThreshold: s.daysStaleThreshold,
                  }}
                />
              ) : (
                <dl className="grid gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-slate-500">営業日の区切り</dt>
                    <dd>{s.businessDayStart}時</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">リマインド送信時刻</dt>
                    <dd>{s.reminderHour}時</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">未更新と判定する日数</dt>
                    <dd>{s.daysStaleThreshold}日</dd>
                  </div>
                </dl>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
