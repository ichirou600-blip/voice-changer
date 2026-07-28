"use client";

import { useFormState, useFormStatus } from "react-dom";

import { Alert, Button, Card, Input, Label } from "@/components/ui";

import { acceptAction, type AcceptState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "設定中..." : "パスワードを設定"}
    </Button>
  );
}

export function AcceptForm({
  token,
  minPasswordLength,
}: {
  token: string;
  minPasswordLength: number;
}) {
  const [state, formAction] = useFormState<AcceptState, FormData>(acceptAction, {});

  return (
    <Card>
      {state.error ? <Alert>{state.error}</Alert> : null}
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <div>
          <Label htmlFor="password">新しいパスワード</Label>
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
