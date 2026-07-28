import { beforeEach, describe, expect, it } from "vitest";

import { AuthorizationError, assertCanManageUser } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { createSession } from "@/lib/auth/session";
import { listSessionsForUser, revokeSessions, setUserActive } from "@/lib/dal/users";
import { getDashboard } from "@/lib/dal/dashboard";
import { createPostByStaff, BACKDATE_LIMIT_DAYS, MAX_POSTS_PER_BUSINESS_DAY } from "@/lib/dal/posts";
import { updateCast } from "@/lib/dal/casts";
import { addDays, currentBusinessDate } from "@/lib/business-day";
import { prisma } from "@/lib/prisma";

import { resetDatabase } from "./helpers/db";

/**
 * 実装レビューで指摘された欠陥の回帰テスト。
 */

let storeA: string;
let admin: SessionUser;
let managerA: SessionUser;
let staffA: SessionUser;
let adminId: string;

beforeEach(async () => {
  await resetDatabase();
  const a = await prisma.store.create({ data: { name: "A店", businessDayStart: 6 } });
  storeA = a.id;

  const uAdmin = await prisma.user.create({
    data: { email: "admin@example.com", name: "管理者", passwordHash: "x", role: "ADMIN", storeId: storeA },
  });
  const uManager = await prisma.user.create({
    data: { email: "m@example.com", name: "店長", passwordHash: "x", role: "MANAGER", storeId: storeA },
  });
  const uStaff = await prisma.user.create({
    data: { email: "s@example.com", name: "スタッフ", passwordHash: "x", role: "STAFF", storeId: storeA },
  });
  adminId = uAdmin.id;
  admin = { id: uAdmin.id, email: uAdmin.email, name: uAdmin.name, role: "ADMIN", storeId: storeA };
  managerA = { id: uManager.id, email: uManager.email, name: uManager.name, role: "MANAGER", storeId: storeA };
  staffA = { id: uStaff.id, email: uStaff.email, name: uStaff.name, role: "STAFF", storeId: storeA };
});

describe("上位ロールへの操作の禁止", () => {
  it("assertCanManageUser は同格以上を拒否する", () => {
    expect(() => assertCanManageUser(managerA, { id: adminId, role: "ADMIN" })).toThrow(
      AuthorizationError,
    );
    expect(() => assertCanManageUser(managerA, { id: "x", role: "MANAGER" })).toThrow(
      AuthorizationError,
    );
    expect(() => assertCanManageUser(managerA, { id: "x", role: "STAFF" })).not.toThrow();
    expect(() => assertCanManageUser(admin, { id: "x", role: "MANAGER" })).not.toThrow();
  });

  it("MANAGER は同店舗の ADMIN を強制ログアウトできない（締め出し防止）", async () => {
    await createSession(adminId);
    await expect(revokeSessions(managerA, adminId)).rejects.toThrow(AuthorizationError);
    // ADMIN のセッションは生きている
    expect(await prisma.session.count({ where: { userId: adminId } })).toBe(1);
  });

  it("MANAGER は ADMIN のセッション情報（IP/UA）を読めない", async () => {
    await createSession(adminId, { ip: "203.0.113.9", userAgent: "secret-agent" });
    await expect(listSessionsForUser(managerA, adminId)).rejects.toThrow(AuthorizationError);
  });

  it("MANAGER は ADMIN を無効化できない", async () => {
    await expect(setUserActive(managerA, adminId, false)).rejects.toThrow(AuthorizationError);
  });

  it("ADMIN は MANAGER を強制ログアウトできる", async () => {
    await createSession(managerA.id);
    expect(await revokeSessions(admin, managerA.id)).toBe(1);
  });
});

describe("ダッシュボードの複数店舗集計", () => {
  it("区切り時刻が異なる店舗でも、それぞれの週で正しく集計する", async () => {
    // A店: 区切り6時 / B店: 区切り20時
    const storeB = (await prisma.store.create({ data: { name: "B店", businessDayStart: 20 } })).id;

    const castA = await prisma.cast.create({
      data: {
        storeId: storeA,
        name: "あやか",
        targets: { create: { postsPerWeek: 3, effectiveFrom: "2026-01-05" } },
      },
    });
    const castB = await prisma.cast.create({
      data: {
        storeId: storeB,
        name: "びより",
        targets: { create: { postsPerWeek: 3, effectiveFrom: "2026-01-05" } },
      },
    });

    // 2026-07-27（月）10:00 JST = 2026-07-27T01:00Z
    // A店(6時区切り): 営業日 07-27 / 週 07-27
    // B店(20時区切り): 営業日 07-26 / 週 07-20
    const now = new Date("2026-07-27T01:00:00Z");

    await prisma.blogPost.create({
      data: {
        castId: castB.id,
        postedAt: now,
        businessDate: "2026-07-26",
        businessWeekStart: "2026-07-20",
        source: "STAFF_ENTRY",
      },
    });

    const data = await getDashboard(admin, now);
    const b = data.casts.find((c) => c.castId === castB.id)!;
    const a = data.casts.find((c) => c.castId === castA.id)!;

    // B店のキャストは自店の週（07-20）で数えられ、1件が反映される
    expect(b.progress.weekStart).toBe("2026-07-20");
    expect(b.progress.postCount).toBe(1);
    // 直近に更新があるので未更新扱いにならない
    expect(b.stale).toBe(false);
    expect(b.lastPostBusinessDate).toBe("2026-07-26");

    // A店のキャストは自店の週（07-27）で 0 件
    expect(a.progress.weekStart).toBe("2026-07-27");
    expect(a.progress.postCount).toBe(0);
    expect(a.stale).toBe(true);

    expect(data.mixedBusinessDays).toBe(true);
  });

  it("キャストの並び順で他店舗の集計結果が変わらない", async () => {
    const storeB = (await prisma.store.create({ data: { name: "B店", businessDayStart: 20 } })).id;
    // A店に「あ」より前に並ぶ名前を足しても B 店の週は変わらないこと
    await prisma.cast.create({ data: { storeId: storeA, name: "ああ" } });
    const castB = await prisma.cast.create({ data: { storeId: storeB, name: "びより" } });

    const now = new Date("2026-07-27T01:00:00Z");
    const data = await getDashboard(admin, now);
    expect(data.casts.find((c) => c.castId === castB.id)!.progress.weekStart).toBe("2026-07-20");
  });
});

describe("更新記録の入力制限", () => {
  let castId: string;

  beforeEach(async () => {
    const cast = await prisma.cast.create({ data: { storeId: storeA, name: "あやか" } });
    castId = cast.id;
  });

  it("休止中のキャストには記録できない", async () => {
    await prisma.cast.update({ where: { id: castId }, data: { status: "INACTIVE" } });
    await expect(createPostByStaff(staffA, { castId })).rejects.toThrow();
  });

  it("上限を超える遡及入力は拒否する", async () => {
    const today = currentBusinessDate(6);
    const tooOld = addDays(today, -(BACKDATE_LIMIT_DAYS + 1));
    await expect(
      createPostByStaff(staffA, { castId, businessDate: tooOld }),
    ).rejects.toThrow();

    // 上限内なら通る
    const ok = addDays(today, -(BACKDATE_LIMIT_DAYS - 1));
    await expect(createPostByStaff(staffA, { castId, businessDate: ok })).resolves.toBeTruthy();
  });

  it("1営業日あたりの件数に上限がある（実績の水増し防止）", async () => {
    for (let i = 0; i < MAX_POSTS_PER_BUSINESS_DAY; i++) {
      await createPostByStaff(staffA, { castId });
    }
    await expect(createPostByStaff(staffA, { castId })).rejects.toThrow();
    expect(await prisma.blogPost.count()).toBe(MAX_POSTS_PER_BUSINESS_DAY);
  });
});

describe("退店時の LINE 連携解除", () => {
  it("退店にすると lineUserId と連携状態が消える", async () => {
    const cast = await prisma.cast.create({
      data: {
        storeId: storeA,
        name: "あやか",
        lineStatus: "LINKED",
        lineUserId: "U-retire",
        lineLinkCode: "ABCD2345",
      },
    });

    await updateCast(managerA, { castId: cast.id, name: "あやか", status: "RETIRED" });

    const after = await prisma.cast.findUnique({ where: { id: cast.id } });
    expect(after?.status).toBe("RETIRED");
    expect(after?.lineUserId).toBeNull();
    expect(after?.lineStatus).toBe("NOT_LINKED");
    expect(after?.lineLinkCode).toBeNull();
  });
});
