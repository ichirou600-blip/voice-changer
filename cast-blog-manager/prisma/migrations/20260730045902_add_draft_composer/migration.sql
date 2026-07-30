-- CreateEnum
CREATE TYPE "DraftResult" AS ENUM ('OK', 'BLOCKED_NG', 'FAILED', 'SKIPPED_LIMIT');

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "draftEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "draftGuideline" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "draftMonthlyLimit" INTEGER,
ADD COLUMN     "draftNgWords" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "CastWritingProfile" (
    "castId" TEXT NOT NULL,
    "firstPerson" TEXT NOT NULL DEFAULT '',
    "toneNote" TEXT NOT NULL DEFAULT '',
    "topics" TEXT NOT NULL DEFAULT '',
    "emojiLevel" INTEGER NOT NULL DEFAULT 1,
    "ngWords" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CastWritingProfile_pkey" PRIMARY KEY ("castId")
);

-- CreateTable
CREATE TABLE "DraftGeneration" (
    "id" TEXT NOT NULL,
    "castId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "drafts" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "result" "DraftResult" NOT NULL,
    "errorDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DraftGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DraftGeneration_storeId_createdAt_idx" ON "DraftGeneration"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "DraftGeneration_castId_createdAt_idx" ON "DraftGeneration"("castId", "createdAt");

-- AddForeignKey
ALTER TABLE "CastWritingProfile" ADD CONSTRAINT "CastWritingProfile_castId_fkey" FOREIGN KEY ("castId") REFERENCES "Cast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftGeneration" ADD CONSTRAINT "DraftGeneration_castId_fkey" FOREIGN KEY ("castId") REFERENCES "Cast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftGeneration" ADD CONSTRAINT "DraftGeneration_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
