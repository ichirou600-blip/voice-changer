import Link from "next/link";

/** 404 ページ。既定の Next.js 画面は商用製品として不適切なため差し替える */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10 text-center">
      <h1 className="mb-2 text-2xl font-bold text-slate-900">ページが見つかりません</h1>
      <p className="mb-6 text-sm text-slate-600">
        URL が変更されたか、アクセス権限のないページの可能性があります。
      </p>
      <Link
        href="/dashboard"
        className="mx-auto rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        ダッシュボードへ戻る
      </Link>
    </main>
  );
}
