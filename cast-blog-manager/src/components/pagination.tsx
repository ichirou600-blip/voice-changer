import Link from "next/link";

/** ページ送り（Server Component。クエリパラメータで遷移する） */
export function Pagination({
  page,
  pageCount,
  total,
  basePath,
}: {
  page: number;
  pageCount: number;
  total: number;
  basePath: string;
}) {
  if (pageCount <= 1) {
    return <p className="mt-3 text-xs text-slate-500">全 {total} 件</p>;
  }

  const href = (p: number) => `${basePath}?page=${p}`;

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className="text-xs text-slate-500">
        全 {total} 件 / {page} ページ目（全 {pageCount} ページ）
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={href(page - 1)}
            className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50"
          >
            前へ
          </Link>
        ) : null}
        {page < pageCount ? (
          <Link
            href={href(page + 1)}
            className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50"
          >
            次へ
          </Link>
        ) : null}
      </div>
    </div>
  );
}
