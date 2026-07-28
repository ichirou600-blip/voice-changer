"use client";

import { useState, useTransition } from "react";

import { Alert, Button, Card, Input, Label, Select } from "@/components/ui";

import { issueLinkCodeAction, setCastTargetAction, unlinkLineAction, updateCastAction } from "../actions";

export function CastDetailForms({
  castId,
  castName,
  status,
  lineStatus,
  canManage,
  pendingLinkCode,
}: {
  castId: string;
  castName: string;
  status: "ACTIVE" | "INACTIVE" | "RETIRED";
  lineStatus: "NOT_LINKED" | "LINKED" | "BLOCKED";
  canManage: boolean;
  pendingLinkCode: string | null;
}) {
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [linkCode, setLinkCode] = useState<string | null>(pendingLinkCode);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, onOk?: (data: unknown) => void) => {
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error ?? "エラーが発生しました" });
        return;
      }
      onOk?.(result.data);
    });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {message ? (
        <div className="lg:col-span-2">
          <Alert kind={message.kind}>{message.text}</Alert>
        </div>
      ) : null}

      {canManage ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold">基本情報</h2>
          <form
            action={(formData) =>
              run(
                () => updateCastAction(formData),
                () => setMessage({ kind: "success", text: "更新しました" }),
              )
            }
            className="space-y-3"
          >
            <input type="hidden" name="castId" value={castId} />
            <div>
              <Label htmlFor="name">源氏名</Label>
              <Input id="name" name="name" defaultValue={castName} required maxLength={40} />
            </div>
            <div>
              <Label htmlFor="status">在籍状況</Label>
              <Select id="status" name="status" defaultValue={status}>
                <option value="ACTIVE">在籍</option>
                <option value="INACTIVE">休止</option>
                <option value="RETIRED">退店</option>
              </Select>
              <p className="mt-1 text-xs text-slate-500">
                退店にしても更新履歴は保持されます（削除はされません）。
              </p>
            </div>
            <Button type="submit" disabled={pending}>
              保存
            </Button>
          </form>
        </Card>
      ) : null}

      {canManage ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold">週次目標の変更</h2>
          <form
            action={(formData) =>
              run(
                () => setCastTargetAction(formData),
                (data) => {
                  const d = data as { effectiveFrom?: string } | undefined;
                  setMessage({
                    kind: "success",
                    text: `${d?.effectiveFrom ?? ""} 開始の週から適用されます`,
                  });
                },
              )
            }
            className="space-y-3"
          >
            <input type="hidden" name="castId" value={castId} />
            <div>
              <Label htmlFor="postsPerWeek">週の目標回数</Label>
              <Input id="postsPerWeek" name="postsPerWeek" type="number" min={0} max={50} required />
              <p className="mt-1 text-xs text-slate-500">
                変更は「次に始まる週」から適用され、進行中の週の判定は変わりません。
              </p>
            </div>
            <Button type="submit" disabled={pending}>
              目標を変更
            </Button>
          </form>
        </Card>
      ) : null}

      <Card className="lg:col-span-2">
        <h2 className="mb-3 text-sm font-semibold">LINE 連携</h2>
        {lineStatus === "LINKED" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-slate-600">このキャストは LINE と連携済みです。</p>
            {canManage ? (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  run(
                    () => unlinkLineAction(castId),
                    () => setMessage({ kind: "success", text: "連携を解除しました" }),
                  )
                }
              >
                連携を解除
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              連携コードを発行し、キャスト本人に公式アカウントへ送信してもらうと連携されます。
            </p>
            {linkCode ? (
              <div className="rounded-md border border-slate-300 bg-slate-50 p-4">
                <p className="text-xs text-slate-500">連携コード（24時間有効）</p>
                <p className="mt-1 font-mono text-2xl tracking-widest">{linkCode}</p>
              </div>
            ) : null}
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  () => issueLinkCodeAction(castId),
                  (data) => {
                    const d = data as { code?: string } | undefined;
                    if (d?.code) setLinkCode(d.code);
                    setMessage({ kind: "success", text: "連携コードを発行しました" });
                  },
                )
              }
            >
              連携コードを発行
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
