"use client";

import { useState, useTransition } from "react";

import { Alert, Button, Input, Label } from "@/components/ui";

import { updateDraftSettingsAction } from "./actions";

/**
 * 店舗ごとの文面作成設定。
 *
 * 月間上限は既定で「無制限」。空欄が無制限を意味することを画面上で明示する
 * （0 と空欄を取り違えると、意図せず1件も作れなくなるため）。
 */
export function DraftSettingsForm({
  store,
  usage,
}: {
  store: {
    id: string;
    draftEnabled: boolean;
    draftMonthlyLimit: number | null;
    draftGuideline: string;
    draftNgWords: string;
  };
  usage: { used: number; inputTokens: number; outputTokens: number };
}) {
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => {
        setMessage(null);
        startTransition(async () => {
          const result = await updateDraftSettingsAction(formData);
          setMessage(
            result.ok
              ? { kind: "success", text: "保存しました" }
              : { kind: "error", text: result.error },
          );
        });
      }}
      className="grid gap-3"
    >
      {message ? <Alert kind={message.kind}>{message.text}</Alert> : null}
      <input type="hidden" name="storeId" value={store.id} />

      <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
        今月の作成回数: <span className="font-semibold text-slate-900">{usage.used}回</span>
        <span className="ml-3 text-slate-500">
          （入力 {usage.inputTokens.toLocaleString()} / 出力{" "}
          {usage.outputTokens.toLocaleString()} トークン）
        </span>
      </p>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          name="draftEnabled"
          defaultChecked={store.draftEnabled}
          className="h-4 w-4 rounded border-slate-300"
        />
        この店舗で文面作成を使えるようにする
      </label>

      <div className="sm:max-w-xs">
        <Label htmlFor={`dml-${store.id}`}>月間の作成回数の上限</Label>
        <Input
          id={`dml-${store.id}`}
          name="draftMonthlyLimit"
          type="number"
          min={0}
          max={999999}
          placeholder="空欄 = 無制限"
          defaultValue={store.draftMonthlyLimit ?? ""}
        />
        <p className="mt-1 text-xs text-slate-500">
          空欄なら無制限（既定）。0 を入れると1件も作成できなくなります。
        </p>
      </div>

      <div>
        <Label htmlFor={`dg-${store.id}`}>お店としての文面の方針（任意）</Label>
        <textarea
          id={`dg-${store.id}`}
          name="draftGuideline"
          rows={2}
          maxLength={1000}
          defaultValue={store.draftGuideline}
          placeholder="例: 敬語は使わず親しみやすく。来店のお誘いは最後に一言だけ。"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div>
        <Label htmlFor={`dng-${store.id}`}>書かせたくない表現（1行に1つ）</Label>
        <textarea
          id={`dng-${store.id}`}
          name="draftNgWords"
          rows={3}
          maxLength={2000}
          defaultValue={store.draftNgWords}
          placeholder={"例:\n他店の名前\nアフター\n源氏名以外の本名"}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
        />
        <p className="mt-1 text-xs text-slate-500">
          連絡先・料金・他店比較・年齢に関する表現は、この設定に関わらず常に禁止されます。
        </p>
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          保存
        </Button>
      </div>
    </form>
  );
}
