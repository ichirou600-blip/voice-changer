import { notFound } from "next/navigation";

import { isSetupCompleted } from "@/lib/auth/setup";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";

import { SetupForm } from "./setup-form";

/**
 * 初回セットアップ画面。
 * ユーザーが 1 件でも存在すれば 404（誰でも管理者を作れる状態を残さない）。
 */
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isSetupCompleted()) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-xl font-bold">初期セットアップ</h1>
      <p className="mb-6 text-sm text-slate-600">
        最初の店舗と管理者アカウントを作成します。この画面は最初の1回だけ表示されます。
      </p>
      <SetupForm minPasswordLength={MIN_PASSWORD_LENGTH} />
    </main>
  );
}
