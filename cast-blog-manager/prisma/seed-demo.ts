/**
 * 資料・デモ用のサンプル活動データ。
 *
 * `db:seed` が作るのは「空の状態」なので、そのまま画面を撮ると
 * 全員が「記録なし・未更新」になり、実運用の見え方が伝わらない。
 * このスクリプトは、達成／進行中／未更新が混在した現実的な状態を作る。
 *
 * **データを追加するだけで、既存の記録は消さない。**
 * 本番環境では実行しないこと（NODE_ENV=production で停止する）。
 *
 * 実行: npm run db:seed:demo
 */

import { PrismaClient } from "@prisma/client";

import { addDays, businessWeekStart, currentBusinessDate } from "../src/lib/business-day";

const prisma = new PrismaClient();

/** 各キャストの見せたい状態 */
const PROFILE = [
  {
    name: "あやか",
    postsThisWeek: 3, // 目標達成
    lineStatus: "LINKED" as const,
    writing: {
      firstPerson: "わたし",
      toneNote: "「〜だよ」をよく使う。テンション高め",
      topics: "カフェ巡り、猫、ネイル",
      emojiLevel: 1,
    },
  },
  {
    name: "みゆ",
    postsThisWeek: 2, // 進行中
    lineStatus: "LINKED" as const,
    writing: {
      firstPerson: "みゆ",
      toneNote: "ていねいめ。「〜です」「〜ですね」",
      topics: "お菓子作り、映画",
      emojiLevel: 0,
    },
  },
  {
    name: "れいな",
    postsThisWeek: 0, // 未更新（リマインド対象）
    lineStatus: "LINKED" as const,
    writing: {
      firstPerson: "うち",
      toneNote: "くだけた口調。「〜やん」",
      topics: "K-POP、カラオケ、旅行",
      emojiLevel: 2,
    },
  },
  {
    name: "さくら",
    postsThisWeek: 1, // 進行中
    lineStatus: "NOT_LINKED" as const,
    writing: {
      firstPerson: "さくら",
      toneNote: "おっとり。ゆっくりめの語り口",
      topics: "読書、紅茶",
      emojiLevel: 1,
    },
  },
];

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed-demo は本番環境では実行しないでください");
  }

  const store = await prisma.store.findFirst({ orderBy: { createdAt: "asc" } });
  if (!store) throw new Error("店舗がありません。先に npm run db:seed を実行してください。");

  const today = currentBusinessDate(store.businessDayStart);
  const weekStart = businessWeekStart(today);

  for (const spec of PROFILE) {
    const cast = await prisma.cast.upsert({
      where: { storeId_name: { storeId: store.id, name: spec.name } },
      create: {
        storeId: store.id,
        name: spec.name,
        lineStatus: spec.lineStatus,
        targets: { create: { postsPerWeek: 3, effectiveFrom: weekStart } },
      },
      update: { lineStatus: spec.lineStatus },
    });

    // 目標が無い場合だけ足す（既存の履歴は触らない）
    const hasTarget = await prisma.castTarget.count({ where: { castId: cast.id } });
    if (hasTarget === 0) {
      await prisma.castTarget.create({
        data: { castId: cast.id, postsPerWeek: 3, effectiveFrom: weekStart },
      });
    }

    await prisma.castWritingProfile.upsert({
      where: { castId: cast.id },
      create: { castId: cast.id, ...spec.writing, ngWords: "" },
      update: spec.writing,
    });

    // 今週の記録を作る（既に今週の記録があるならそのまま）
    const already = await prisma.blogPost.count({
      where: { castId: cast.id, businessWeekStart: weekStart, voidedAt: null },
    });
    for (let i = already; i < spec.postsThisWeek; i++) {
      const businessDate = addDays(today, -i);
      await prisma.blogPost.create({
        data: {
          castId: cast.id,
          postedAt: new Date(),
          businessDate,
          businessWeekStart: businessWeekStart(businessDate),
          source: i % 2 === 0 ? "CAST_LINE" : "STAFF_ENTRY",
          title: null,
        },
      });
    }

    // 未更新の人にも「以前は書いていた」履歴を残す（最終更新日を出すため）
    if (spec.postsThisWeek === 0) {
      const past = addDays(today, -6);
      const exists = await prisma.blogPost.count({
        where: { castId: cast.id, businessDate: past, voidedAt: null },
      });
      if (exists === 0) {
        await prisma.blogPost.create({
          data: {
            castId: cast.id,
            postedAt: new Date(),
            businessDate: past,
            businessWeekStart: businessWeekStart(past),
            source: "CAST_LINE",
          },
        });
      }
    }
  }

  console.log(`デモデータを投入しました（店舗: ${store.name} / 営業日: ${today}）`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
