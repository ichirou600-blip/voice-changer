"use client";

import { useFormState, useFormStatus } from "react-dom";

import { Alert, Button, Card, Input, Label } from "@/components/ui";

import { setupAction, type SetupState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "作成中..." : "管理者アカウントを作成"}
    </Button>
  );
}

export function SetupForm({ minPasswordLength }: { minPasswordLength: number }) {
  const [state, formAction] = useFormState<SetupState, FormData>(setupAction, {});

  return (
    <Card>
      {state.error ? <Alert>{state.error}</Alert> : null}
      <form action={formAction} className="space-y-4">
        <div>
          <Label htmlFor="storeName">店舗名</Label>
          <Input id="storeName" name="storeName" required maxLength={60} autoComplete="off" />
        </div>
        <div>
          <Label htmlFor="name">お名前</Label>
          <Input id="name" name="name" required maxLength={60} autoComplete="name" />
        </div>
        <div>
          <Label htmlFor="email">メールアドレス</Label>
          <Input id="email" name="email" type="email" required autoComplete="username" />
        </div>
        <div>
          <Label htmlFor="password">パスワード</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={minPasswordLength}
            autoComplete="new-password"
          />
          <p className="mt-1 text-xs text-slate-500">{minPasswordLength}文字以上で設定してください</p>
        </div>
        <SubmitButton />
      </form>
    </Card>
  );
}
