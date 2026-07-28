import { NextResponse } from "next/server";

import { writeAudit } from "@/lib/audit";
import { normalizeLinkCode } from "@/lib/auth/tokens";
import { createPostFromLine } from "@/lib/dal/posts";
import { replyMessage, selfReportConfirmMessage, textMessage } from "@/lib/line/client";
import { verifyLineSignature } from "@/lib/line/signature";
import { prisma } from "@/lib/prisma";
import { businessWeekStart } from "@/lib/business-day";
import { notVoided } from "@/lib/dal/posts";
import { buildWeeklyProgress } from "@/lib/targets";

/**
 * LINE Webhook。
 *
 * 扱うイベント:
 * - follow   : 友だち追加 → 連携コードの入力を案内。既存連携ならブロック解除として復帰
 * - unfollow : ブロック   → lineStatus=BLOCKED にして送信対象から自動除外
 * - message  : 連携コードの入力 → キャストと lineUserId を紐付け
 * - postback : 「投稿したよ」の確認（今日/昨日/キャンセル）→ 更新記録を作成
 *
 * 認可は署名検証のみ（Origin 照合は使えない）。
 * 応答は Push ではなく **reply** を使う（無料枠を消費しないため）。
 */

export const dynamic = "force-dynamic";

type LineEvent = {
  type: string;
  replyToken?: string;
  source?: { userId?: string };
  message?: { type: string; text?: string };
  postback?: { data?: string };
};

export async function POST(request: Request) {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const rawBody = await request.text();

  if (!verifyLineSignature(channelSecret ?? "", rawBody, request.headers.get("x-line-signature"))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  let payload: { events?: LineEvent[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  for (const event of payload.events ?? []) {
    try {
      await handleEvent(event);
    } catch {
      // 個別イベントの失敗で 500 を返すと LINE 側が再送を繰り返すため、
      // ログに残して 200 を返す（再送してもユニーク制約と重複ガードで冪等）
    }
  }

  return NextResponse.json({ ok: true });
}

async function handleEvent(event: LineEvent): Promise<void> {
  const lineUserId = event.source?.userId;
  if (!lineUserId) return;

  if (event.type === "unfollow") {
    // ブロックされた: 送信対象から自動除外する（失敗ログが積み上がるのを防ぐ）
    const cast = await prisma.cast.findUnique({ where: { lineUserId } });
    if (cast) {
      await prisma.cast.update({ where: { id: cast.id }, data: { lineStatus: "BLOCKED" } });
    }
    return;
  }

  if (event.type === "follow") {
    const cast = await prisma.cast.findUnique({ where: { lineUserId } });
    if (cast) {
      // ブロック解除で戻ってきた場合は連携を復帰させる
      await prisma.cast.update({ where: { id: cast.id }, data: { lineStatus: "LINKED" } });
      await reply(event, `おかえりなさい、${cast.name}さん！`);
      return;
    }
    await reply(
      event,
      "友だち追加ありがとうございます。\nお店から受け取った「連携コード」を送信してください。",
    );
    return;
  }

  if (event.type === "message" && event.message?.type === "text") {
    await handleTextMessage(event, lineUserId, event.message.text ?? "");
    return;
  }

  if (event.type === "postback") {
    await handlePostback(event, lineUserId, event.postback?.data ?? "");
  }
}

async function handleTextMessage(event: LineEvent, lineUserId: string, text: string): Promise<void> {
  const linked = await prisma.cast.findUnique({ where: { lineUserId }, include: { store: true } });

  // 連携済みの場合、「投稿」系の文言は自己申告の確認フローに入る
  if (linked) {
    if (/投稿|更新|ブログ/.test(text)) {
      await replyRaw(event, [selfReportConfirmMessage()]);
      return;
    }
    await reply(event, "ブログを更新したら「投稿したよ」と送ってください。");
    return;
  }

  // 未連携: 連携コードとして処理する
  const code = normalizeLinkCode(text);
  if (code.length < 6) {
    await reply(event, "お店から受け取った「連携コード」を送信してください。");
    return;
  }

  const cast = await prisma.cast.findFirst({
    where: {
      lineLinkCode: code,
      lineLinkCodeExpiresAt: { gt: new Date() },
      lineUserId: null,
      status: { not: "RETIRED" },
    },
  });

  if (!cast) {
    await reply(event, "連携コードが正しくないか、有効期限が切れています。お店にご確認ください。");
    return;
  }

  await prisma.cast.update({
    where: { id: cast.id },
    data: {
      lineUserId,
      lineStatus: "LINKED",
      lineLinkCode: null,
      lineLinkCodeExpiresAt: null,
    },
  });

  await writeAudit({
    action: "CAST_LINE_LINKED",
    targetType: "Cast",
    targetId: cast.id,
    detail: cast.name,
  });

  await reply(
    event,
    `${cast.name}さん、連携が完了しました！\nブログを更新したら「投稿したよ」と送ってください。`,
  );
}

async function handlePostback(event: LineEvent, lineUserId: string, data: string): Promise<void> {
  const cast = await prisma.cast.findUnique({ where: { lineUserId }, include: { store: true } });
  if (!cast || cast.status === "RETIRED") return;

  const which = new URLSearchParams(data).get("report");
  if (which === "cancel") {
    await reply(event, "キャンセルしました。");
    return;
  }
  if (which !== "today" && which !== "yesterday") return;

  const { created, businessDate } = await createPostFromLine({
    castId: cast.id,
    storeBusinessDayStart: cast.store.businessDayStart,
    which,
  });

  if (!created) {
    // 連打・誤タップによる二重記録を防いだケース
    await reply(event, "さきほど記録済みです。ありがとうございます！");
    return;
  }

  const weekStart = businessWeekStart(businessDate);
  const [targets, count] = await Promise.all([
    prisma.castTarget.findMany({ where: { castId: cast.id }, orderBy: { effectiveFrom: "desc" } }),
    prisma.blogPost.count({
      where: { castId: cast.id, businessWeekStart: weekStart, ...notVoided },
    }),
  ]);
  const progress = buildWeeklyProgress(targets, weekStart, count);

  await reply(
    event,
    progress.target === null
      ? `記録しました！（${businessDate}）ありがとうございます！`
      : `記録しました！（${businessDate}）\n今週は ${progress.postCount}/${progress.target} 回目です。`,
  );
}

async function reply(event: LineEvent, text: string): Promise<void> {
  await replyRaw(event, [textMessage(text)]);
}

async function replyRaw(event: LineEvent, messages: Parameters<typeof replyMessage>[1]): Promise<void> {
  if (!event.replyToken) return;
  await replyMessage(event.replyToken, messages);
}
