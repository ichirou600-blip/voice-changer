"use client";

import { useState, useTransition } from "react";

import { Alert, Button } from "@/components/ui";

import { runRemindersNowAction } from "./reminder-actions";

export function ReminderPanel({ quota }: { quota: { sent: number; limit: number; remaining: number } }) {
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-3">
      {message ? <Alert kind={message.kind}>{message.text}</Alert> : null}

      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
        <p className="font-medium">今月の LINE 送信数</p>
        <p className="mt-1 text-slate-700">
          {quota.sent} / {quota.limit} 通（残り {quota.remaining} 通）
        </p>
        <p className="mt-1 text-xs text-slate-500">
          LINE 無料プランの上限（月200通）を超えないよう、既定では180通で打ち止めになります。
        </p>
      </div>

      <Button
        disabled={pending}
        onClick={() => {
          setMessage(null);
          startTransition(async () => {
            const result = await runRemindersNowAction(undefined);
            setMessage(
              result.ok
                ? {
                    kind: "success",
                    text: `実行しました（対象 ${result.data.targeted}件 / 送信 ${result.data.sent}件 / 失敗 ${result.data.failed}件）`,
                  }
                : { kind: "error", text: result.error },
            );
          });
        }}
      >
        {pending ? "実行中..." : "今すぐリマインドを実行"}
      </Button>
      <p className="text-xs text-slate-500">
        同じ営業日に何度実行しても、1キャストにつき1通しか送信されません（冪等）。
      </p>
    </div>
  );
}
