import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SessionUser } from "@/lib/auth/session";
import { AuthorizationError, assertStoreAccess, storeScope } from "@/lib/auth/authorize";
import { getCast, listCasts, updateCast } from "@/lib/dal/casts";
import { createPostByStaff, listPosts, voidPost } from "@/lib/dal/posts";
import { prisma } from "@/lib/prisma";

import { resetDatabase } from "./helpers/db";

/**
 * 認可（店舗境界 / IDOR）の統合テスト。
 *
 * 設計レビューで最重要とされた「MANAGER が他店舗の ID を指定すると
 * 読み書きできてしまう」問題が、実際に塞がれていることを実 DB で検証する。
 */

let storeA: string;
let storeB: string;
let castA: string;
let castB: string;
let managerA: SessionUser;
let managerB: SessionUser;
let admin: SessionUser;
let staffA: SessionUser;

const reset = resetDatabase;

beforeAll(async () => {
  await reset();
});

beforeEach(async () => {
  await reset();

  const a = await prisma.store.create({ data: { name: "A店" } });
  const b = await prisma.store.create({ data: { name: "B店" } });
  storeA = a.id;
  storeB = b.id;

  const cA = await prisma.cast.create({
    data: {
      storeId: storeA,
      name: "あやか",
      targets: { create: { postsPerWeek: 3, effectiveFrom: "2026-01-05" } },
    },
  });
  const cB = await prisma.cast.create({
    data: {
      storeId: storeB,
      name: "びより",
      targets: { create: { postsPerWeek: 3, effectiveFrom: "2026-01-05" } },
    },
  });
  castA = cA.id;
  castB = cB.id;

  const uA = await prisma.user.create({
    data: { email: "a@example.com", name: "店長A", passwordHash: "x", role: "MANAGER", storeId: storeA },
  });
  const uB = await prisma.user.create({
    data: { email: "b@example.com", name: "店長B", passwordHash: "x", role: "MANAGER", storeId: storeB },
  });
  const uAdmin = await prisma.user.create({
    data: { email: "admin@example.com", name: "管理者", passwordHash: "x", role: "ADMIN", storeId: storeA },
  });
  const uStaff = await prisma.user.create({
    data: { email: "s@example.com", name: "スタッフA", passwordHash: "x", role: "STAFF", storeId: storeA },
  });

  managerA = { id: uA.id, email: uA.email, name: uA.name, role: "MANAGER", storeId: storeA };
  managerB = { id: uB.id, email: uB.email, name: uB.name, role: "MANAGER", storeId: storeB };
  admin = { id: uAdmin.id, email: uAdmin.email, name: uAdmin.name, role: "ADMIN", storeId: storeA };
  staffA = { id: uStaff.id, email: uStaff.email, name: uStaff.name, role: "STAFF", storeId: storeA };
});

describe("storeScope（店舗スコープの where 条件）", () => {
  it("ADMIN は無条件（全店舗）", () => {
    expect(storeScope(admin)).toEqual({});
  });

  it("MANAGER/STAFF は自店舗に限定される", () => {
    expect(storeScope(managerA)).toEqual({ storeId: storeA });
    expect(storeScope(staffA)).toEqual({ storeId: storeA });
  });

  it("所属店舗が無い非ADMINは何も見えない（フェイルクローズ）", () => {
    const orphan: SessionUser = { ...staffA, storeId: null };
    expect(storeScope(orphan).storeId).toBe("__no_store__");
  });
});

describe("assertStoreAccess", () => {
  it("他店舗を指定すると例外", () => {
    expect(() => assertStoreAccess(managerA, storeB)).toThrow(AuthorizationError);
    expect(() => assertStoreAccess(managerA, null)).toThrow(AuthorizationError);
  });

  it("自店舗と ADMIN は通る", () => {
    expect(() => assertStoreAccess(managerA, storeA)).not.toThrow();
    expect(() => assertStoreAccess(admin, storeB)).not.toThrow();
  });
});

describe("キャストの店舗境界（IDOR 防止）", () => {
  it("一覧には自店舗のキャストしか出ない", async () => {
    const listA = await listCasts(managerA);
    expect(listA.map((c) => c.name)).toEqual(["あやか"]);

    const listB = await listCasts(managerB);
    expect(listB.map((c) => c.name)).toEqual(["びより"]);
  });

  it("ADMIN は全店舗を横断して見える", async () => {
    const all = await listCasts(admin);
    expect(all.map((c) => c.name).sort()).toEqual(["あやか", "びより"]);
  });

  it("他店舗のキャストを ID 直指定しても取得できない", async () => {
    expect(await getCast(managerA, castB)).toBeNull();
    expect(await getCast(managerB, castA)).toBeNull();
  });

  it("他店舗のキャストは ID 直指定でも更新できない", async () => {
    await expect(
      updateCast(managerA, { castId: castB, name: "改ざん", status: "RETIRED" }),
    ).rejects.toThrow();

    const untouched = await prisma.cast.findUnique({ where: { id: castB } });
    expect(untouched?.name).toBe("びより");
    expect(untouched?.status).toBe("ACTIVE");
  });
});

describe("更新記録の店舗境界", () => {
  it("他店舗のキャストには記録できない", async () => {
    await expect(createPostByStaff(managerA, { castId: castB })).rejects.toThrow();
    expect(await prisma.blogPost.count()).toBe(0);
  });

  it("他店舗の記録は一覧に出ず、無効化もできない", async () => {
    const post = await createPostByStaff(managerB, { castId: castB });

    const listedByA = await listPosts(managerA, { includeVoided: true });
    expect(listedByA).toHaveLength(0);

    await expect(voidPost(managerA, { postId: post.id, reason: "改ざん" })).rejects.toThrow();

    const still = await prisma.blogPost.findUnique({ where: { id: post.id } });
    expect(still?.voidedAt).toBeNull();
  });

  it("無効化は物理削除ではなく理由と実行者が残る", async () => {
    const post = await createPostByStaff(managerA, { castId: castA });
    await voidPost(managerA, { postId: post.id, reason: "重複のため" });

    const voided = await prisma.blogPost.findUnique({ where: { id: post.id } });
    expect(voided).not.toBeNull();
    expect(voided?.voidedAt).not.toBeNull();
    expect(voided?.voidedById).toBe(managerA.id);
    expect(voided?.voidReason).toBe("重複のため");

    // 有効な記録としては数えられない
    const active = await listPosts(managerA);
    expect(active).toHaveLength(0);
  });

  it("未来の営業日には記録できない", async () => {
    await expect(
      createPostByStaff(managerA, { castId: castA, businessDate: "2099-01-01" }),
    ).rejects.toThrow();
  });
});
