"use client";

import { useState, useTransition } from "react";

import { Alert, Button, Card, Input, Label, Select } from "@/components/ui";

import {
  issueLinkCodeAction,
  saveWritingProfileAction,
  setCastTargetAction,
  unlinkLineAction,
  updateCastAction,
} from "../actions";

export type WritingProfileValues = {
  firstPerson: string;
  toneNote: string;
  topics: string;
  emojiLevel: number;
  ngWords: string;
};

export function CastDetailForms({
  castId,
  castName,
  status,
  lineStatus,
  canManage,
  pendingLinkCode,
  writingProfile,
  draftEnabled,
}: {
  castId: string;
  castName: string;
  status: "ACTIVE" | "INACTIVE" | "RETIRED";
  lineStatus: "NOT_LINKED" | "LINKED" | "BLOCKED";
  canManage: boolean;
  pendingLinkCode: string | null;
  writingProfile: WritingProfileValues | null;
  draftEnabled: boolean;
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

      {canManage && draftEnabled ? (
        <Card className="lg:col-span-2">
          <h2 className="mb-1 text-sm font-semibold">話し方の設定（文面作成用）</h2>
          <p className="mb-3 text-xs leading-relaxed text-slate-500">
            キャストが文面をつくるときに使います。
            <span className="font-medium text-slate-700">
              空のままだと店舗内で似た文面が並びやすくなる
            </span>
            ため、一人称と話し方だけでも入れてください。
          </p>
          <form
            action={(formData) =>
              run(
                () => saveWritingProfileAction(formData),
                () => setMessage({ kind: "success", text: "話し方の設定を保存しました" }),
              )
            }
            className="grid gap-3 sm:grid-cols-2"
          >
            <input type="hidden" name="castId" value={castId} />
            <div>
              <Label htmlFor="firstPerson">一人称</Label>
              <Input
                id="firstPerson"
                name="firstPerson"
                maxLength={10}
                placeholder="例: わたし"
                defaultValue={writingProfile?.firstPerson ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="emojiLevel">絵文字の量</Label>
              <Select
                id="emojiLevel"
                name="emojiLevel"
                defaultValue={String(writingProfile?.emojiLevel ?? 1)}
              >
                <option value="0">少なめ（使わない）</option>
                <option value="1">ふつう</option>
                <option value="2">多め</option>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="toneNote">話し方の特徴</Label>
              <Input
                id="toneNote"
                name="toneNote"
                maxLength={200}
                placeholder="例: 「〜だよ」「〜なの」をよく使う。テンション高め。"
                defaultValue={writingProfile?.toneNote ?? ""}
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="topics">よく書く話題</Label>
              <Input
                id="topics"
                name="topics"
                maxLength={200}
                placeholder="例: カフェ巡り、猫、K-POP、ネイル"
                defaultValue={writingProfile?.topics ?? ""}
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="castNgWords">この人に書かせたくない表現（1行に1つ）</Label>
              <textarea
                id="castNgWords"
                name="ngWords"
                rows={2}
                maxLength={1000}
                defaultValue={writingProfile?.ngWords ?? ""}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={pending}>
                保存
              </Button>
            </div>
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
