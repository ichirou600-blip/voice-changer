/**
 * 開発用: 指定ユーザーのセッションを発行して平文トークンを標準出力する。
 * 動作確認やデバッグで、ブラウザを使わずに認証状態を作るために使う。
 *
 * 実行: npx tsx scripts/dev-session.mts [email]
 */
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

if (process.env.NODE_ENV === "production") {
  throw new Error("このスクリプトは本番環境では実行できません");
}

const prisma = new PrismaClient();
const email = process.argv[2];

const user = email
  ? await prisma.user.findUniqueOrThrow({ where: { email: email.toLowerCase() } })
  : await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });

const token = randomBytes(32).toString("base64url");
await prisma.session.create({
  data: {
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: user.id,
    idleExpiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    absoluteExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  },
});

console.log(token);
await prisma.$disconnect();
