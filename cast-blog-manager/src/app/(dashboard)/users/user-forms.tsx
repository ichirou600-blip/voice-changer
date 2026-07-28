"use client";

import { useState, useTransition } from "react";

import { Alert, Button, Input, Label, Select } from "@/components/ui";

import {
  inviteUserAction,
  issueResetAction,
  revokeSessionsAction,
  setUserActiveAction,
} from "./actions";

/**
 * 発行したリンクの表示。
 * 平文トークンはここでしか表示されない（DB にはハッシュのみ保存）。
 */
function IssuedLink({ link, note }: { link: string; note: string }) {
  return (
    <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm">
      <p className="mb-1 font-medium text-sky-900">{note}</p>
      <p className="break-all font-mono text-xs text-sky-900">{link}</p>
      <p className="mt-2 text-xs text-sky-800">
        このリンクは一度しか表示されません。本人に直接手渡してください。
      </p>
    </div>
  );
}

export function InviteForm({
  stores,
  canInviteAdmin,
}: {
  stores: { id: string; name: string }[];
  canInviteAdmin: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <form
        action={(formData) => {
          setError(null);
          setIssued(null);
          startTransition(async () => {
            const result = await inviteUserAction(formData);
            if (result.ok) setIssued(result.data.link);
            else setError(result.error);
          });
        }}
        className="grid gap-3 sm:grid-cols-5"
      >
        {error ? (
          <div className="sm:col-span-5">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        <div>
          <Label htmlFor="invite-name">名前</Label>
          <Input id="invite-name" name="name" required maxLength={60} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="invite-email">メールアドレス</Label>
          <Input id="invite-email" name="email" type="email" required />
        </div>
        <div>
          <Label htmlFor="invite-role">権限</Label>
          <Select id="invite-role" name="role" defaultValue="STAFF">
            <option value="STAFF">スタッフ</option>
            <option value="MANAGER">店長</option>
            {canInviteAdmin ? <option value="ADMIN">管理者</option> : null}
          </Select>
        </div>
        <div>
          <Label htmlFor="invite-store">店舗</Label>
          <Select id="invite-store" name="storeId">
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="sm:col-span-5">
          <Button type="submit" disabled={pending}>
            {pending ? "発行中..." : "招待リンクを発行"}
          </Button>
        </div>
      </form>
      {issued ? <IssuedLink link={issued} note="招待リンク（72時間有効）" /> : null}
    </>
  );
}

export function UserRowActions({
  userId,
  isActive,
  isSelf,
}: {
  userId: string;
  isActive: boolean;
  isSelf: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          disabled={pending || !isActive}
          onClick={() => {
            setMessage(null);
            setResetLink(null);
            startTransition(async () => {
              const result = await issueResetAction(userId);
              if (result.ok) setResetLink(result.data.link);
              else setMessage(result.error);
            });
          }}
        >
          再設定リンク
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setMessage(null);
            startTransition(async () => {
              const result = await revokeSessionsAction(userId);
              setMessage(
                result.ok ? `${result.data.count}件のセッションを失効しました` : result.error,
              );
            });
          }}
        >
          強制ログアウト
        </Button>
        {isSelf ? null : (
          <Button
            variant={isActive ? "danger" : "secondary"}
            disabled={pending}
            onClick={() => {
              setMessage(null);
              startTransition(async () => {
                const result = await setUserActiveAction({ userId, isActive: !isActive });
                if (!result.ok) setMessage(result.error);
              });
            }}
          >
            {isActive ? "無効化" : "再有効化"}
          </Button>
        )}
      </div>
      {message ? <span className="text-xs text-slate-600">{message}</span> : null}
      {resetLink ? (
        <div className="w-72">
          <IssuedLink link={resetLink} note="パスワード再設定リンク（30分有効）" />
        </div>
      ) : null}
    </div>
  );
}
