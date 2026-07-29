import { Alert, Card } from "@/components/ui";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";
import { peekInvitation } from "@/lib/dal/users";

import { AcceptForm } from "./accept-form";

export const dynamic = "force-dynamic";

/**
 * 招待 / パスワード再設定の受け口。
 *
 * 設計上の注意:
 * - この画面は URL にトークンを含むため、**外部リソースを一切読み込まない**
 *   （Referer 経由でトークンが外部に漏れるのを防ぐ）
 * - GET ではトークンを消費しない（プレビュー bot 対策）
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await peekInvitation(token);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      {!invitation ? (
        <Card>
          <Alert>このリンクは無効か、有効期限が切れています。管理者に再発行を依頼してください。</Alert>
        </Card>
      ) : (
        <>
          <h1 className="mb-1 text-xl font-bold">
            {invitation.purpose === "INVITE" ? "アカウントの作成" : "パスワードの再設定"}
          </h1>
          <p className="mb-6 text-sm text-slate-600">
            {invitation.email} のパスワードを設定してください。
          </p>
          <AcceptForm token={token} minPasswordLength={MIN_PASSWORD_LENGTH} />
        </>
      )}
    </main>
  );
}
