import { notFound } from "next/navigation";

import { verifyCastToken } from "@/lib/draft/cast-link";
import { DRAFT_THEMES } from "@/lib/draft/prompt";
import { prisma } from "@/lib/prisma";

import { DraftComposer } from "./draft-composer";

/**
 * キャスト用の文面作成画面。
 *
 * 管理画面 (`(dashboard)`) とは別のレイアウトに置く。
 * キャストはログインしておらず、ナビゲーションを出す意味がないため。
 *
 * この画面から外部サイトへの投稿は行わない。
 * つくった文面はキャスト本人がコピーし、自分でブログに貼り付ける。
 *
 * 有効期限切れ・改ざん・退店などはすべて 404 に寄せる
 * （「このキャストは存在する」といった情報を返さない）。
 */

export const dynamic = "force-dynamic";

export default async function CastDraftPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let verdict;
  try {
    verdict = verifyCastToken(token);
  } catch {
    // CAST_LINK_SECRET 未設定など、設定不備で例外になる場合
    notFound();
  }

  if (!verdict.ok) {
    if (verdict.reason === "expired") return <ExpiredNotice />;
    notFound();
  }

  const cast = await prisma.cast.findUnique({
    where: { id: verdict.castId },
    include: { store: true, writingProfile: true },
  });

  if (!cast || cast.status !== "ACTIVE" || !cast.store.draftEnabled) notFound();

  return (
    <main className="mx-auto min-h-screen w-full max-w-md bg-slate-50 px-4 py-6">
      <header className="mb-5">
        <p className="text-xs text-slate-500">{cast.store.name}</p>
        <h1 className="text-lg font-bold text-slate-900">{cast.name}さんの文面づくり</h1>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          下書きをつくるだけの画面です。内容を確認して、コピーしてからブログに貼り付けてください。
        </p>
      </header>

      <DraftComposer
        token={token}
        themes={DRAFT_THEMES.map((t) => ({ key: t.key, label: t.label }))}
        hasProfile={Boolean(cast.writingProfile)}
      />

      <p className="mt-8 text-center text-[11px] leading-relaxed text-slate-400">
        このリンクは60分で切れます。切れたらLINEのメニューからもう一度開いてください。
      </p>
    </main>
  );
}

function ExpiredNotice() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-bold text-slate-900">リンクの有効期限が切れています</h1>
      <p className="text-sm leading-relaxed text-slate-600">
        LINEのメニューから「文面をつくる」をもう一度タップしてください。
      </p>
    </main>
  );
}
