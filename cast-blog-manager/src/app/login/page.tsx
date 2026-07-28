import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth/session";
import { isSetupCompleted } from "@/lib/auth/setup";

import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // 未セットアップならセットアップ画面へ誘導する
  if (!(await isSetupCompleted())) redirect("/setup");
  if (await getSessionUser()) redirect("/dashboard");

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-xl font-bold">キャストブログ更新管理</h1>
      <p className="mb-6 text-sm text-slate-600">スタッフ用の管理画面です。</p>
      <LoginForm />
    </main>
  );
}
