/**
 * 開発用のシードデータ。
 *
 * 注意: **本番の初期管理者はここでは作らない**。
 * 環境変数にパスワードを置くのを避けるため、本番は初回セットアップ画面
 * （/setup。ユーザーが0件のときだけ有効）から作成する。
 *
 * 実行: npm run db:seed
 */

import { PrismaClient } from "@prisma/client";
import { hash } from "@node-rs/argon2";

const prisma = new PrismaClient();

const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed は本番環境では実行しないでください");
  }

  const existing = await prisma.user.count();
  if (existing > 0) {
    console.log("既にデータがあるため seed をスキップします");
    return;
  }

  const store = await prisma.store.create({
    data: { name: "サンプル店", businessDayStart: 6, reminderHour: 17, daysStaleThreshold: 2 },
  });

  await prisma.user.create({
    data: {
      email: "admin@example.com",
      name: "開発用管理者",
      passwordHash: await hash("dev-password-1234", ARGON2_OPTIONS),
      role: "ADMIN",
      storeId: store.id,
    },
  });

  await prisma.cast.createMany({
    data: [
      { storeId: store.id, name: "あやか" },
      { storeId: store.id, name: "みゆ" },
      { storeId: store.id, name: "れいな" },
    ],
  });

  const casts = await prisma.cast.findMany({ where: { storeId: store.id } });
  await prisma.castTarget.createMany({
    data: casts.map((c) => ({ castId: c.id, postsPerWeek: 3, effectiveFrom: "2026-01-05" })),
  });

  console.log("seed 完了: admin@example.com / dev-password-1234（開発用）");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
