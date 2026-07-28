import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  checkAttemptLimit,
  clearAttempts,
  linkCodeKey,
  MAX_LINK_CODE_ATTEMPTS,
  recordFailedAttempt,
} from "@/lib/auth/rate-limit";
import { generateLinkCode, normalizeLinkCode } from "@/lib/auth/tokens";
import { createPostFromLine } from "@/lib/dal/posts";
import { isAllowedMutation, isSameOrigin } from "@/lib/http/csrf";
import { verifyLineSignature } from "@/lib/line/signature";
import { prisma } from "@/lib/prisma";
import { getMonthlyLimit, startOfMonthJst } from "@/lib/quota";

import { resetDatabase } from "./helpers/db";

describe("LINE Webhook の署名検証", () => {
  const secret = "test-channel-secret";
  const body = JSON.stringify({ events: [] });
  const validSignature = createHmac("sha256", secret).update(body).digest("base64");

  it("正しい署名を受理する", () => {
    expect(verifyLineSignature(secret, body, validSignature)).toBe(true);
  });

  it("署名なし・空シークレットは拒否する", () => {
    expect(verifyLineSignature(secret, body, null)).toBe(false);
    expect(verifyLineSignature("", body, validSignature)).toBe(false);
  });

  it("ボディが改ざんされたら拒否する", () => {
    const tampered = JSON.stringify({ events: [{ type: "message" }] });
    expect(verifyLineSignature(secret, tampered, validSignature)).toBe(false);
  });

  it("別のシークレットで作られた署名は拒否する", () => {
    const forged = createHmac("sha256", "attacker-secret").update(body).digest("base64");
    expect(verifyLineSignature(secret, body, forged)).toBe(false);
  });

  it("長さの違う署名でも例外にならず false", () => {
    expect(verifyLineSignature(secret, body, "short")).toBe(false);
  });
});

describe("連携コードの正規化", () => {
  it("空白・小文字・ハイフン・全角を吸収する", () => {
    expect(normalizeLinkCode(" ab3d-7k9m ")).toBe("AB3D7K9M");
    expect(normalizeLinkCode("ＡＢ３Ｄ７Ｋ９Ｍ")).toBe("AB3D7K9M");
  });
});

describe("連携コードの強度と試行制限", () => {
  it("紛らわしい文字（0/O/1/I/L）を含まない", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateLinkCode()).not.toMatch(/[01OIL]/);
    }
  });

  it("既定は8桁で、毎回異なる", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateLinkCode()));
    expect(codes.size).toBeGreaterThan(190); // 衝突はほぼ起きない
    for (const c of codes) expect(c).toHaveLength(8);
  });

  it("LINE ユーザー単位で試行回数を制限できる", async () => {
    await resetDatabase();
    const key = linkCodeKey("U-attacker");

    for (let i = 0; i < MAX_LINK_CODE_ATTEMPTS; i++) {
      expect((await checkAttemptLimit(key, MAX_LINK_CODE_ATTEMPTS)).allowed).toBe(true);
      await recordFailedAttempt(key);
    }
    // 上限に達したら拒否される
    expect((await checkAttemptLimit(key, MAX_LINK_CODE_ATTEMPTS)).allowed).toBe(false);

    // 連携成功後は解除される
    await clearAttempts(key);
    expect((await checkAttemptLimit(key, MAX_LINK_CODE_ATTEMPTS)).allowed).toBe(true);
  });

  it("別の LINE ユーザーの試行には影響しない", async () => {
    await resetDatabase();
    const attacker = linkCodeKey("U-attacker");
    for (let i = 0; i < MAX_LINK_CODE_ATTEMPTS; i++) await recordFailedAttempt(attacker);

    expect((await checkAttemptLimit(attacker, MAX_LINK_CODE_ATTEMPTS)).allowed).toBe(false);
    expect(
      (await checkAttemptLimit(linkCodeKey("U-innocent"), MAX_LINK_CODE_ATTEMPTS)).allowed,
    ).toBe(true);
  });
});

describe("CSRF（Origin 照合）", () => {
  it("同一オリジンは許可", () => {
    expect(isSameOrigin("https://app.example.com", "app.example.com")).toBe(true);
  });

  it("別オリジンは拒否", () => {
    expect(isSameOrigin("https://evil.example.net", "app.example.com")).toBe(false);
  });

  it("APP_URL に一致すれば許可（プロキシ配下対策）", () => {
    expect(
      isSameOrigin("https://app.example.com", "internal-host", "https://app.example.com"),
    ).toBe(true);
  });

  it("GET は常に通す（状態を変えない前提）", () => {
    expect(
      isAllowedMutation({
        method: "GET",
        origin: "https://evil.example.net",
        host: "app.example.com",
        secFetchSite: "cross-site",
      }),
    ).toBe(true);
  });

  it("クロスオリジンの POST は拒否", () => {
    expect(
      isAllowedMutation({
        method: "POST",
        origin: "https://evil.example.net",
        host: "app.example.com",
        secFetchSite: "cross-site",
      }),
    ).toBe(false);
  });

  it("Origin が無くても Sec-Fetch-Site が same-origin なら許可", () => {
    expect(
      isAllowedMutation({
        method: "POST",
        origin: null,
        host: "app.example.com",
        secFetchSite: "same-origin",
      }),
    ).toBe(true);
  });

  it("Origin も Sec-Fetch-Site も無い POST は拒否（フェイルクローズ）", () => {
    expect(
      isAllowedMutation({
        method: "POST",
        origin: null,
        host: "app.example.com",
        secFetchSite: null,
      }),
    ).toBe(false);
  });
});

describe("月間送信数の集計基準", () => {
  it("JST の月初を UTC で正しく求める", () => {
    // JST 2026-08-01 00:00 = UTC 2026-07-31 15:00
    expect(startOfMonthJst(new Date("2026-08-15T00:00:00Z")).toISOString()).toBe(
      "2026-07-31T15:00:00.000Z",
    );
    // JST 2026-08-01 08:00（= UTC 7/31 23:00）はもう8月扱い
    expect(startOfMonthJst(new Date("2026-07-31T23:00:00Z")).toISOString()).toBe(
      "2026-07-31T15:00:00.000Z",
    );
  });

  it("環境変数が不正なら既定値にフォールバック", () => {
    process.env.LINE_MONTHLY_PUSH_LIMIT = "not-a-number";
    expect(getMonthlyLimit()).toBe(180);
    process.env.LINE_MONTHLY_PUSH_LIMIT = "50";
    expect(getMonthlyLimit()).toBe(50);
    delete process.env.LINE_MONTHLY_PUSH_LIMIT;
    expect(getMonthlyLimit()).toBe(180);
  });
});

describe("LINE 自己申告（連打・誤タップ対策）", () => {
  let castId: string;

  beforeEach(async () => {
    await resetDatabase();
    const store = await prisma.store.create({ data: { name: "テスト店", businessDayStart: 6 } });
    const cast = await prisma.cast.create({
      data: { storeId: store.id, name: "あやか", lineStatus: "LINKED", lineUserId: "U-1" },
    });
    castId = cast.id;
  });

  it("「今日の分」で当日の営業日に記録される", async () => {
    // JST 7/29 02:00（深夜）→ 営業日は 7/28
    const now = new Date("2026-07-28T17:00:00Z");
    const result = await createPostFromLine({
      castId,
      storeBusinessDayStart: 6,
      which: "today",
      now,
    });

    expect(result).toEqual({ created: true, businessDate: "2026-07-28" });
    const post = await prisma.blogPost.findFirst();
    expect(post?.businessDate).toBe("2026-07-28");
    expect(post?.businessWeekStart).toBe("2026-07-27");
    expect(post?.source).toBe("CAST_LINE");
  });

  it("「昨日の分」は前の営業日に記録される", async () => {
    const now = new Date("2026-07-28T17:00:00Z");
    const result = await createPostFromLine({
      castId,
      storeBusinessDayStart: 6,
      which: "yesterday",
      now,
    });
    expect(result.businessDate).toBe("2026-07-27");
  });

  it("10分以内の連打では二重に記録されない", async () => {
    const now = new Date("2026-07-28T17:00:00Z");
    const first = await createPostFromLine({ castId, storeBusinessDayStart: 6, which: "today", now });
    const second = await createPostFromLine({
      castId,
      storeBusinessDayStart: 6,
      which: "today",
      now: new Date(now.getTime() + 60_000),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await prisma.blogPost.count()).toBe(1);
  });

  it("「今日の分」の直後に「昨日の分」を入れられる（別営業日はガードしない）", async () => {
    // 実装レビューで「businessDate を条件に入れていないため、
    // 昨日の分が記録されないのに成功したように見える」と指摘された箇所の回帰テスト
    const now = new Date("2026-07-28T17:00:00Z");
    const today = await createPostFromLine({
      castId,
      storeBusinessDayStart: 6,
      which: "today",
      now,
    });
    const yesterday = await createPostFromLine({
      castId,
      storeBusinessDayStart: 6,
      which: "yesterday",
      now: new Date(now.getTime() + 30_000),
    });

    expect(today).toEqual({ created: true, businessDate: "2026-07-28" });
    expect(yesterday).toEqual({ created: true, businessDate: "2026-07-27" });
    expect(await prisma.blogPost.count()).toBe(2);
  });

  it("同じ営業日の連打は引き続きガードされる", async () => {
    const now = new Date("2026-07-28T17:00:00Z");
    await createPostFromLine({ castId, storeBusinessDayStart: 6, which: "yesterday", now });
    const again = await createPostFromLine({
      castId,
      storeBusinessDayStart: 6,
      which: "yesterday",
      now: new Date(now.getTime() + 30_000),
    });
    expect(again.created).toBe(false);
    expect(await prisma.blogPost.count()).toBe(1);
  });

  it("重複ウィンドウを過ぎれば1日複数回の記録は正当に受け付ける", async () => {
    const now = new Date("2026-07-28T17:00:00Z");
    await createPostFromLine({ castId, storeBusinessDayStart: 6, which: "today", now });
    const later = await createPostFromLine({
      castId,
      storeBusinessDayStart: 6,
      which: "today",
      now: new Date(now.getTime() + 20 * 60_000),
    });

    expect(later.created).toBe(true);
    expect(await prisma.blogPost.count()).toBe(2);
  });
});
