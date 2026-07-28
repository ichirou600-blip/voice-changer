"use client";

import { useState, useTransition } from "react";

import { Button, Input } from "@/components/ui";

import { voidPostAction } from "./actions";

/**
 * 記録の無効化。
 * 物理削除はせず、理由の入力を必須にして監査可能にする。
 */
export function VoidPostButton({ postId }: { postId: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        無効化
      </Button>
    );
  }

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await voidPostAction(formData);
          if (result.ok) setOpen(false);
          else setError(result.error);
        });
      }}
      className="flex flex-wrap items-center justify-end gap-2"
    >
      <input type="hidden" name="postId" value={postId} />
      <Input name="reason" placeholder="無効化の理由" required maxLength={200} className="w-48" />
      <Button type="submit" variant="danger" disabled={pending}>
        確定
      </Button>
      <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
        取消
      </Button>
      {error ? <span className="text-xs text-rose-600">{error}</span> : null}
    </form>
  );
}
