import Link from "next/link";

import { Button } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/authorize";

import { logoutAction } from "../login/actions";

/**
 * 管理画面の共通レイアウト。
 *
 * 認証はここだけに頼らず、各ページ・各 Server Action でも再検証する
 * （レイアウトの認証は「表示のため」であって認可の担保ではない）。
 */
export const dynamic = "force-dynamic";

const NAV = [
  { href: "/dashboard", label: "ダッシュボード" },
  { href: "/casts", label: "キャスト" },
  { href: "/posts", label: "更新記録" },
  { href: "/users", label: "スタッフ" },
  { href: "/settings", label: "設定" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUserOrRedirect();

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-bold">キャストブログ更新管理</span>
            <nav className="flex flex-wrap gap-3 text-sm">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="text-slate-600 hover:text-slate-900">
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              {user.name}（{user.role}）
            </span>
            <form action={logoutAction}>
              <Button type="submit" variant="secondary">
                ログアウト
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
