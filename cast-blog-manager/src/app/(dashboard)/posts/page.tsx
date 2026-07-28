import { Badge, Button, Card, EmptyState, PageHeader, Table } from "@/components/ui";
import { Pagination } from "@/components/pagination";
import { hasRole, requireUserOrRedirect } from "@/lib/auth/authorize";
import { listCasts } from "@/lib/dal/casts";
import { listPostsPage } from "@/lib/dal/posts";

import { PostCreateForm } from "./post-create-form";
import { VoidPostButton } from "./void-post-button";

export const dynamic = "force-dynamic";

export default async function PostsPage({
  searchParams,
}: {
  searchParams?: { page?: string };
}) {
  const user = await requireUserOrRedirect();
  const page = Number.parseInt(searchParams?.page ?? "1", 10);
  const [casts, result] = await Promise.all([
    listCasts(user),
    listPostsPage(user, { includeVoided: true, page: Number.isFinite(page) ? page : 1 }),
  ]);
  const posts = result.items;
  const canVoid = hasRole(user, "MANAGER");

  return (
    <>
      <PageHeader
        title="更新記録"
        description="ブログ更新を記録します。外部サイトへの自動投稿は行いません（手動記録のみ）。"
        action={
          <a href="/api/export/posts?includeVoided=1" download>
            <Button variant="secondary" type="button">
              CSVで書き出す
            </Button>
          </a>
        }
      />

      <Card className="mb-6">
        <h2 className="mb-3 text-sm font-semibold">更新を記録</h2>
        {casts.length === 0 ? (
          <EmptyState>先にキャストを登録してください。</EmptyState>
        ) : (
          <PostCreateForm casts={casts.map((c) => ({ id: c.id, name: c.name }))} />
        )}
      </Card>

      <Card>
        {posts.length === 0 ? (
          <EmptyState>まだ記録がありません。</EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <th className="py-2">営業日</th>
                <th className="py-2">キャスト</th>
                <th className="py-2">タイトル</th>
                <th className="py-2">入力元</th>
                <th className="py-2">記録者</th>
                <th className="py-2">状態</th>
                {canVoid ? <th className="py-2"></th> : null}
              </tr>
            }
          >
            {posts.map((p) => (
              <tr key={p.id} className={p.voidedAt ? "text-slate-400" : ""}>
                <td className="py-2">{p.businessDate}</td>
                <td className="py-2 font-medium">{p.castName}</td>
                <td className="py-2">{p.title ?? "（タイトルなし）"}</td>
                <td className="py-2">{p.source === "CAST_LINE" ? "LINE自己申告" : "スタッフ入力"}</td>
                <td className="py-2">{p.recordedByName ?? "-"}</td>
                <td className="py-2">
                  {p.voidedAt ? (
                    <Badge tone="danger">無効化{p.voidReason ? `（${p.voidReason}）` : ""}</Badge>
                  ) : (
                    <Badge tone="ok">有効</Badge>
                  )}
                </td>
                {canVoid ? (
                  <td className="py-2 text-right">
                    {p.voidedAt ? null : <VoidPostButton postId={p.id} />}
                  </td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}
        <Pagination
          page={result.page}
          pageCount={result.pageCount}
          total={result.total}
          basePath="/posts"
        />
      </Card>
    </>
  );
}
