-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'STAFF');

-- CreateEnum
CREATE TYPE "CastStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "LineStatus" AS ENUM ('NOT_LINKED', 'LINKED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "InvitationPurpose" AS ENUM ('INVITE', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "PostSource" AS ENUM ('CAST_LINE', 'STAFF_ENTRY');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('REMINDER', 'LINK_CONFIRM', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageResult" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED_QUOTA', 'SKIPPED_BLOCKED');

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessDayStart" INTEGER NOT NULL DEFAULT 6,
    "reminderHour" INTEGER NOT NULL DEFAULT 17,
    "daysStaleThreshold" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STAFF',
    "storeId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "InvitationPurpose" NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STAFF',
    "storeId" TEXT,
    "issuedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cast" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CastStatus" NOT NULL DEFAULT 'ACTIVE',
    "lineStatus" "LineStatus" NOT NULL DEFAULT 'NOT_LINKED',
    "lineUserId" TEXT,
    "lineLinkCode" TEXT,
    "lineLinkCodeExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CastTarget" (
    "id" TEXT NOT NULL,
    "castId" TEXT NOT NULL,
    "postsPerWeek" INTEGER NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CastTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlogPost" (
    "id" TEXT NOT NULL,
    "castId" TEXT NOT NULL,
    "title" TEXT,
    "url" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "businessDate" TEXT NOT NULL,
    "businessWeekStart" TEXT NOT NULL,
    "source" "PostSource" NOT NULL,
    "recordedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlogPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineMessageLog" (
    "id" TEXT NOT NULL,
    "castId" TEXT NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "businessDate" TEXT NOT NULL,
    "result" "MessageResult" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorDetail" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LineMessageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Cast_lineUserId_key" ON "Cast"("lineUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Cast_lineLinkCode_key" ON "Cast"("lineLinkCode");

-- CreateIndex
CREATE UNIQUE INDEX "Cast_storeId_name_key" ON "Cast"("storeId", "name");

-- CreateIndex
CREATE INDEX "CastTarget_castId_effectiveFrom_idx" ON "CastTarget"("castId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "BlogPost_castId_businessDate_idx" ON "BlogPost"("castId", "businessDate");

-- CreateIndex
CREATE INDEX "BlogPost_castId_businessWeekStart_idx" ON "BlogPost"("castId", "businessWeekStart");

-- CreateIndex
CREATE INDEX "LineMessageLog_sentAt_idx" ON "LineMessageLog"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "LineMessageLog_castId_kind_businessDate_key" ON "LineMessageLog"("castId", "kind", "businessDate");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cast" ADD CONSTRAINT "Cast_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CastTarget" ADD CONSTRAINT "CastTarget_castId_fkey" FOREIGN KEY ("castId") REFERENCES "Cast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_castId_fkey" FOREIGN KEY ("castId") REFERENCES "Cast"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineMessageLog" ADD CONSTRAINT "LineMessageLog_castId_fkey" FOREIGN KEY ("castId") REFERENCES "Cast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

