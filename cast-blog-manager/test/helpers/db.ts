import { prisma } from "@/lib/prisma";

/**
 * テスト用の全消去。
 * 外部キー制約があるため、依存関係の子から順に削除する。
 */
export async function resetDatabase(): Promise<void> {
  await prisma.lineMessageLog.deleteMany();
  await prisma.draftGeneration.deleteMany();
  await prisma.castWritingProfile.deleteMany();
  await prisma.blogPost.deleteMany();
  await prisma.castTarget.deleteMany();
  await prisma.cast.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.invitation.deleteMany();
  await prisma.session.deleteMany();
  await prisma.loginAttempt.deleteMany();
  await prisma.user.deleteMany();
  await prisma.store.deleteMany();
}
