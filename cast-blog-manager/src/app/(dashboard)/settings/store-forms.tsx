"use client";

import { useState, useTransition } from "react";

import { Alert, Button, Input, Label } from "@/components/ui";

import { createStoreAction, updateStoreAction } from "./actions";

export function StoreForm({
  store,
}: {
  store: {
    id: string;
    name: string;
    businessDayStart: number;
    reminderHour: number;
    daysStaleThreshold: number;
  };
}) {
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => {
        setMessage(null);
        startTransition(async () => {
          const result = await updateStoreAction(formData);
          setMessage(
            result.ok
              ? { kind: "success", text: "保存しました" }
              : { kind: "error", text: result.error },
          );
        });
      }}
      className="grid gap-3 sm:grid-cols-5"
    >
      {message ? (
        <div className="sm:col-span-5">
          <Alert kind={message.kind}>{message.text}</Alert>
        </div>
      ) : null}
      <input type="hidden" name="storeId" value={store.id} />
      <div className="sm:col-span-2">
        <Label htmlFor={`name-${store.id}`}>店舗名</Label>
        <Input id={`name-${store.id}`} name="name" defaultValue={store.name} required maxLength={60} />
      </div>
      <div>
        <Label htmlFor={`bds-${store.id}`}>営業日の区切り（時）</Label>
        <Input
          id={`bds-${store.id}`}
          name="businessDayStart"
          type="number"
          min={0}
          max={23}
          defaultValue={store.businessDayStart}
          required
        />
        <p className="mt-1 text-xs text-slate-500">深夜営業のため既定は6時</p>
      </div>
      <div>
        <Label htmlFor={`rh-${store.id}`}>リマインド時刻（時）</Label>
        <Input
          id={`rh-${store.id}`}
          name="reminderHour"
          type="number"
          min={0}
          max={23}
          defaultValue={store.reminderHour}
          required
        />
      </div>
      <div>
        <Label htmlFor={`dst-${store.id}`}>未更新と判定する日数</Label>
        <Input
          id={`dst-${store.id}`}
          name="daysStaleThreshold"
          type="number"
          min={1}
          max={30}
          defaultValue={store.daysStaleThreshold}
          required
        />
      </div>
      <div className="sm:col-span-5">
        <Button type="submit" disabled={pending}>
          保存
        </Button>
      </div>
    </form>
  );
}

export function StoreCreateForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await createStoreAction(formData);
          if (!result.ok) setError(result.error);
        });
      }}
      className="flex flex-wrap items-end gap-3"
    >
      {error ? (
        <div className="w-full">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      <div className="grow">
        <Label htmlFor="new-store-name">店舗名</Label>
        <Input id="new-store-name" name="name" required maxLength={60} />
      </div>
      <Button type="submit" disabled={pending}>
        追加
      </Button>
    </form>
  );
}
