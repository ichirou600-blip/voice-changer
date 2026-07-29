"use client";

import { useEffect } from "react";

/**
 * 予期せぬエラーの表示。
 *
 * 利用者には原因を出さず（内部情報の漏洩を防ぐ）、
 * 問い合わせに使える digest だけを見せる。
 * 詳細はサーバー側のログに記録される。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({ level: "error", event: "client.error_boundary", digest: error.digest }),
    );
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10 text-center">
      <h1 className="mb-2 text-2xl font-bold text-slate-900">エラーが発生しました</h1>
      <p className="mb-6 text-sm text-slate-600">
        時間をおいて再度お試しください。
        <br />
        繰り返し発生する場合は、サポートへ以下の番号をお伝えください。
      </p>
      {error.digest ? (
        <p className="mb-6 font-mono text-xs text-slate-500">エラー番号: {error.digest}</p>
      ) : null}
      <button
        onClick={reset}
        className="mx-auto rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        再試行する
      </button>
    </main>
  );
}
