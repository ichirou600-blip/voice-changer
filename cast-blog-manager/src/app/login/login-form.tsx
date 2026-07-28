"use client";

import { useFormState, useFormStatus } from "react-dom";

import { Alert, Button, Card, Input, Label } from "@/components/ui";

import { loginAction, type LoginState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "確認中..." : "ログイン"}
    </Button>
  );
}

export function LoginForm() {
  const [state, formAction] = useFormState<LoginState, FormData>(loginAction, {});

  return (
    <Card>
      {state.error ? <Alert>{state.error}</Alert> : null}
      <form action={formAction} className="space-y-4">
        <div>
          <Label htmlFor="email">メールアドレス</Label>
          <Input id="email" name="email" type="email" required autoComplete="username" />
        </div>
        <div>
          <Label htmlFor="password">パスワード</Label>
          <Input id="password" name="password" type="password" required autoComplete="current-password" />
        </div>
        <SubmitButton />
      </form>
      <p className="mt-4 text-xs text-slate-500">
        パスワードを忘れた場合は、管理者に再設定リンクの発行を依頼してください。
      </p>
    </Card>
  );
}
