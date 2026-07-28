"use client";

import { useState, useTransition } from "react";

import { Alert, Button, Input, Label, Select } from "@/components/ui";

import { createPostAction } from "./actions";

export function PostCreateForm({ casts }: { casts: { id: string; name: string }[] }) {
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => {
        setMessage(null);
        startTransition(async () => {
          const result = await createPostAction(formData);
          setMessage(
            result.ok
              ? { kind: "success", text: "記録しました" }
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
      <div>
        <Label htmlFor="castId">キャスト</Label>
        <Select id="castId" name="castId" required>
          {casts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="businessDate">営業日（未入力なら本日）</Label>
        <Input id="businessDate" name="businessDate" type="date" />
      </div>
      <div>
        <Label htmlFor="title">タイトル（任意）</Label>
        <Input id="title" name="title" maxLength={120} />
      </div>
      <div>
        <Label htmlFor="url">URL（任意）</Label>
        <Input id="url" name="url" type="url" maxLength={500} />
      </div>
      <div className="flex items-end">
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "記録中..." : "記録する"}
        </Button>
      </div>
    </form>
  );
}
