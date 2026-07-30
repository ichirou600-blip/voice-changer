import { Card, EmptyState, PageHeader } from "@/components/ui";
import { hasRole, requireUserOrRedirect } from "@/lib/auth/authorize";
import { listStores } from "@/lib/dal/stores";
import { isDraftFeatureConfigured } from "@/lib/draft/cast-link";
import { getDraftUsage } from "@/lib/draft/limits";
import { getQuotaStatus } from "@/lib/quota";

import { DraftSettingsForm } from "./draft-settings-form";
import { ReminderPanel } from "./reminder-panel";
import { StoreForm, StoreCreateForm } from "./store-forms";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUserOrRedirect();
  const canManage = hasRole(user, "MANAGER");
  // 送信数は店舗横断の情報なので STAFF には出さない
  const [stores, quota] = await Promise.all([
    listStores(user),
    canManage ? getQuotaStatus() : Promise.resolve(null),
  ]);

  // 文面作成の利用状況は店舗ごとに出す（MANAGER 以上のみ）
  const draftConfigured = isDraftFeatureConfigured();
  const draftUsage = canManage
    ? new Map(
        await Promise.all(
          stores.map(
            async (s) => [s.id, await getDraftUsage(s.id, s.draftMonthlyLimit)] as const,
          ),
        ),
      )
    : null;

  return (
    <>
      <PageHeader
        title="設定"
        description="営業日の区切り時刻やリマインドの条件を店舗ごとに設定します。"
      />

      {canManage && quota ? (
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

              {canManage && draftUsage ? (
                <div className="mt-6 border-t border-slate-200 pt-5">
                  <h3 className="mb-1 text-sm font-semibold">文面作成</h3>
                  <p className="mb-3 text-xs leading-relaxed text-slate-500">
                    キャストがLINEから開いて、ブログの下書きをつくれる機能です。
                    投稿は行いません。キャスト本人がコピーして貼り付けます。
                  </p>
                  {draftConfigured ? null : (
                    <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      環境変数（ANTHROPIC_API_KEY / CAST_LINK_SECRET / APP_URL）が未設定のため、
                      有効にしてもキャストの画面は開けません。
                    </p>
                  )}
                  <DraftSettingsForm
                    store={{
                      id: s.id,
                      draftEnabled: s.draftEnabled,
                      draftMonthlyLimit: s.draftMonthlyLimit,
                      draftGuideline: s.draftGuideline,
                      draftNgWords: s.draftNgWords,
                    }}
                    usage={draftUsage.get(s.id) ?? { used: 0, inputTokens: 0, outputTokens: 0 }}
                  />
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
