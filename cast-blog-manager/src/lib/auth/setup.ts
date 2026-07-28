import "server-only";

import { prisma } from "@/lib/prisma";

import { hashPassword } from "./password";

/**
 * 初回セットアップ。
 *
 * 設計レビューでの指摘:
 * - 初期管理者のパスワードを環境変数に置くのはアンチパターン
 *   （Vercel の env に平文で残留し続け、seed 再実行の事故要因にもなる）
 *   → **User が 0 件のときだけ有効になるセットアップ画面**から作成する
 *
 * セットアップ完了後は `isSetupCompleted()` が true になり、
 * /setup は 404 になる（誰でも管理者を作れる状態を残さない）。
 */

export async function isSetupCompleted(): Promise<boolean> {
  const count = await prisma.user.count();
  return count > 0;
}

export type SetupResult = { userId: string; storeId: string };

/**
 * 最初の店舗と管理者を作成する。
 * 競合状態で二重に管理者が作られないよう、トランザクション内で件数を再確認する。
 */
export async function completeSetup(input: {
  storeName: string;
  name: string;
  email: string;
  password: string;
}): Promise<SetupResult> {
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.user.count();
    if (existing > 0) {
      throw new Error("初期セットアップは既に完了しています");
    }

    const store = await tx.store.create({ data: { name: input.storeName } });
    const user = await tx.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash,
        role: "ADMIN",
        storeId: store.id,
      },
    });

    return { userId: user.id, storeId: store.id };
  });
}
