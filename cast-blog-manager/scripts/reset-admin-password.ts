/**
 * 緊急復旧スクリプト: 管理者パスワードの再設定。
 *
 * 設計レビューでの指摘:
 * 「メール基盤なし + 管理者が1人 → その1人がパスワードを忘れたら
 *   DB 直叩き以外に復旧手段がない」
 * → サーバー（またはローカルから本番 DB）にアクセスできる運用者向けの
 *   復旧経路を用意しておく。
 *
 * 実行例:
 *   npx tsx scripts/reset-admin-password.ts admin@example.com '新しいパスワード'
 *
 * 実行するとそのユーザーの全セッションも破棄される。
 */

import { PrismaClient } from "@prisma/client";
import { hash } from "@node-rs/argon2";

const prisma = new PrismaClient();
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const MIN_PASSWORD_LENGTH = 12;

async function main() {
  const [email, password] = process.argv.slice(2);

  if (!email || !password) {
    console.error("使い方: npx tsx scripts/reset-admin-password.ts <email> <新しいパスワード>");
    process.exitCode = 1;
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`パスワードは${MIN_PASSWORD_LENGTH}文字以上で指定してください`);
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    console.error(`ユーザーが見つかりません: ${email}`);
    process.exitCode = 1;
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hash(password, ARGON2_OPTIONS), isActive: true },
  });
  const { count } = await prisma.session.deleteMany({ where: { userId: user.id } });

  await prisma.auditLog.create({
    data: {
      action: "PASSWORD_RESET_COMPLETED",
      targetType: "User",
      targetId: user.id,
      detail: "復旧スクリプトによる再設定",
    },
  });

  console.log(`パスワードを再設定しました: ${user.email}（${count}件のセッションを失効）`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
