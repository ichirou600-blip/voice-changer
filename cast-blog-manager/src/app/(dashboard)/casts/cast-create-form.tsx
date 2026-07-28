"use client";

import { useState, useTransition } from "react";

import { Alert, Button, Input, Label, Select } from "@/components/ui";

import { createCastAction } from "./actions";

export function CastCreateForm({ stores }: { stores: { id: string; name: string }[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await createCastAction(formData);
          if (!result.ok) setError(result.error);
        });
      }}
      className="grid gap-3 sm:grid-cols-4"
    >
      {error ? (
        <div className="sm:col-span-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      <div className="sm:col-span-1">
        <Label htmlFor="storeId">店舗</Label>
        <Select id="storeId" name="storeId" required>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="sm:col-span-1">
        <Label htmlFor="name">源氏名</Label>
        <Input id="name" name="name" required maxLength={40} />
      </div>
      <div className="sm:col-span-1">
        <Label htmlFor="postsPerWeek">週の目標回数</Label>
        <Input id="postsPerWeek" name="postsPerWeek" type="number" min={0} max={50} defaultValue={3} required />
      </div>
      <div className="flex items-end sm:col-span-1">
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "追加中..." : "追加"}
        </Button>
      </div>
    </form>
  );
}
