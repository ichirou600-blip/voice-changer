import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateDrafts } from "@/lib/dal/drafts";
import { BURST_WINDOW_MS, MAX_BURST_PER_CAST, getDraftUsage } from "@/lib/draft/limits";
import { prisma } from "@/lib/prisma";

import { resetDatabase } from "./helpers/db";

/**
 * 文面生成の統合テスト（実 DB・API はモック）。
 *
 * 実際に金銭とレピュテーションに直結する経路なので、
 * 次を実 DB で確かめる。
 * - 生成しただけでは**更新実績（BlogPost）ができない**（実績の水増し防止）
 * - NG 表現を含む案が画面に出ない
 * - 連打で API を叩き続けられない
 * - 月間上限（設定された場合のみ）で止まる
 * - 失敗・スキップも記録として残る
 */

const completeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/draft/anthropic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/draft/anthropic")>();
  return { ...actual, complete: completeMock };
});

let storeId: string;
let castId: string;

function reply(text: string) {
  return { text, model: "claude-haiku-4-5-20251001", inputTokens: 600, outputTokens: 450 };
}

beforeEach(async () => {
  await resetDatabase();
  completeMock.mockReset();
  completeMock.mockResolvedValue(reply("案A\n---\n案B\n---\n案C"));

  const store = await prisma.store.create({
    data: { name: "テスト店", businessDayStart: 6, reminderHour: 17, daysStaleThreshold: 2 },
  });
  storeId = store.id;

  const cast = await prisma.cast.create({
    data: { storeId: store.id, name: "あやか", status: "ACTIVE" },
  });
  castId = cast.id;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("基本の生成", () => {
  it("3案を返し、実行ログを残す", async () => {
    const result = await generateDrafts({ castId, themeKey: "free", keywords: "猫" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.drafts).toEqual(["案A", "案B", "案C"]);

    const log = await prisma.draftGeneration.findFirst();
    expect(log?.result).toBe("OK");
    expect(log?.inputTokens).toBe(600);
    expect(log?.outputTokens).toBe(450);
  });

  it("生成しても更新実績は作られない（実績の水増しにしない）", async () => {
    await generateDrafts({ castId, themeKey: "free", keywords: "猫" });
    expect(await prisma.blogPost.count()).toBe(0);
  });

  it("キャストの話し方が指示に渡る", async () => {
    await prisma.castWritingProfile.create({
      data: { castId, firstPerson: "うち", toneNote: "語尾に「やで」", topics: "", emojiLevel: 2 },
    });
    await generateDrafts({ castId, themeKey: "free", keywords: "" });

    const prompt = completeMock.mock.calls[0][0].user as string;
    expect(prompt).toContain("「うち」");
    expect(prompt).toContain("語尾に「やで」");
  });

  it("同じ店舗の直近の文面が次の指示に渡る（似た文面の反復を防ぐ）", async () => {
    await generateDrafts({ castId, themeKey: "free", keywords: "1回目" });
    await generateDrafts({ castId, themeKey: "free", keywords: "2回目" });

    const second = completeMock.mock.calls[1][0].user as string;
    expect(second).toContain("すでに使われている文面");
    expect(second).toContain("案A");
  });
});

describe("NG 表現の除去", () => {
  it("NG を含む案だけを落とし、残りは見せる", async () => {
    await prisma.store.update({ where: { id: storeId }, data: { draftNgWords: "アフター" } });
    completeMock.mockResolvedValue(reply("普通の文\n---\nあふたー行こう\n---\nもう一つ"));

    const result = await generateDrafts({ castId, themeKey: "free", keywords: "" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.drafts).toEqual(["普通の文", "もう一つ"]);
      expect(result.warnings[0]).toContain("アフター");
    }
  });

  it("全案が NG なら表示しない", async () => {
    await prisma.store.update({ where: { id: storeId }, data: { draftNgWords: "アフター" } });
    completeMock.mockResolvedValue(reply("アフター1\n---\nアフター2\n---\nアフター3"));

    const result = await generateDrafts({ castId, themeKey: "free", keywords: "" });
    expect(result.ok).toBe(false);
    expect((await prisma.draftGeneration.findFirst())?.result).toBe("BLOCKED_NG");
  });

  it("店舗が NG を設定していなくても、連絡先の記載は落とされる", async () => {
    completeMock.mockResolvedValue(reply("普通の文\n---\n090-1234-5678 に連絡してね\n---\n三つ目"));

    const result = await generateDrafts({ castId, themeKey: "free", keywords: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.drafts).toEqual(["普通の文", "三つ目"]);
  });
});

describe("実行の制限", () => {
  it("連打すると止まり、API を叩かない", async () => {
    for (let i = 0; i < MAX_BURST_PER_CAST; i++) {
      expect((await generateDrafts({ castId, themeKey: "free", keywords: "" })).ok).toBe(true);
    }
    completeMock.mockClear();

    const blocked = await generateDrafts({ castId, themeKey: "free", keywords: "" });
    expect(blocked.ok).toBe(false);
    expect(completeMock).not.toHaveBeenCalled();
    expect((await prisma.draftGeneration.findFirst({ orderBy: { createdAt: "desc" } }))?.result).toBe(
      "SKIPPED_LIMIT",
    );
  });

  it("時間が経てば再び実行できる", async () => {
    for (let i = 0; i < MAX_BURST_PER_CAST; i++) {
      await generateDrafts({ castId, themeKey: "free", keywords: "" });
    }
    // 判定窓より前に実行されたことにする
    await prisma.draftGeneration.updateMany({
      data: { createdAt: new Date(Date.now() - BURST_WINDOW_MS - 1000) },
    });

    expect((await generateDrafts({ castId, themeKey: "free", keywords: "" })).ok).toBe(true);
  });

  it("既定では月間の上限がない（無制限）", async () => {
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    expect(store?.draftMonthlyLimit).toBeNull();
  });

  it("月間上限を設定するとその回数で止まる", async () => {
    await prisma.store.update({ where: { id: storeId }, data: { draftMonthlyLimit: 2 } });

    expect((await generateDrafts({ castId, themeKey: "free", keywords: "" })).ok).toBe(true);
    expect((await generateDrafts({ castId, themeKey: "free", keywords: "" })).ok).toBe(true);

    const third = await generateDrafts({ castId, themeKey: "free", keywords: "" });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error).toContain("上限");
  });

  it("上限で止めた分は消費に数えない（数えると翌回以降も永久に止まる）", async () => {
    await prisma.store.update({ where: { id: storeId }, data: { draftMonthlyLimit: 1 } });
    await generateDrafts({ castId, themeKey: "free", keywords: "" });
    await generateDrafts({ castId, themeKey: "free", keywords: "" });

    const usage = await getDraftUsage(storeId, 1);
    expect(usage.used).toBe(1);
  });
});

describe("使えない状態の扱い", () => {
  it("店舗設定でオフなら API を叩かない", async () => {
    await prisma.store.update({ where: { id: storeId }, data: { draftEnabled: false } });
    const result = await generateDrafts({ castId, themeKey: "free", keywords: "" });

    expect(result.ok).toBe(false);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("退店したキャストは使えない", async () => {
    await prisma.cast.update({ where: { id: castId }, data: { status: "RETIRED" } });
    expect((await generateDrafts({ castId, themeKey: "free", keywords: "" })).ok).toBe(false);
  });

  it("存在しないキャストでも落ちない", async () => {
    const result = await generateDrafts({ castId: "no-such-cast", themeKey: "free", keywords: "" });
    expect(result.ok).toBe(false);
  });

  it("API が失敗したら FAILED として記録し、再試行を促す", async () => {
    completeMock.mockRejectedValue(new Error("boom"));
    const result = await generateDrafts({ castId, themeKey: "free", keywords: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
    expect((await prisma.draftGeneration.findFirst())?.result).toBe("FAILED");
  });

  it("応答が空なら失敗として扱う", async () => {
    completeMock.mockResolvedValue(reply("   "));
    expect((await generateDrafts({ castId, themeKey: "free", keywords: "" })).ok).toBe(false);
  });
});

describe("利用状況の集計", () => {
  it("当月の回数とトークン数を返す", async () => {
    await generateDrafts({ castId, themeKey: "free", keywords: "" });
    await generateDrafts({ castId, themeKey: "free", keywords: "" });

    const usage = await getDraftUsage(storeId, null);
    expect(usage.used).toBe(2);
    expect(usage.inputTokens).toBe(1200);
    expect(usage.outputTokens).toBe(900);
    expect(usage.limit).toBeNull();
  });

  it("他店舗の実行を数えない", async () => {
    const other = await prisma.store.create({ data: { name: "別店" } });
    const otherCast = await prisma.cast.create({ data: { storeId: other.id, name: "べつこ" } });
    await generateDrafts({ castId: otherCast.id, themeKey: "free", keywords: "" });

    expect((await getDraftUsage(storeId, null)).used).toBe(0);
    expect((await getDraftUsage(other.id, null)).used).toBe(1);
  });
});
