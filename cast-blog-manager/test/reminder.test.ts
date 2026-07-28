import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { runReminders } from "@/lib/reminder-runner";
import { decideSend, isReminderTimeReached, isStale, MAX_SEND_ATTEMPTS } from "@/lib/reminder-policy";

import { resetDatabase } from "./helpers/db";

/**
 * リマインド実行の統合テスト。
 *
 * 設計レビューで確定した以下の性質を実 DB で検証する:
 * - キャッチアップ型（遅延しても取りこぼさない）
 * - claim → 結果更新方式（二重送信しないが、失敗は再試行できる）
 * - 月間送信上限による打ち止め
 */

const pushMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/line/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/line/client")>();
  return { ...actual, pushMessage: pushMock };
});

let castId: string;
const NOW = new Date("2026-07-28T09:00:00Z"); // JST 7/28 18:00（reminderHour=17 を超過）

beforeEach(async () => {
  await resetDatabase();
  pushMock.mockReset();
  pushMock.mockResolvedValue(undefined);
  process.env.LINE_MONTHLY_PUSH_LIMIT = "180";
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "dummy-token";

  const store = await prisma.store.create({
    data: { name: "テスト店", businessDayStart: 6, reminderHour: 17, daysStaleThreshold: 2 },
  });
  const cast = await prisma.cast.create({
    data: {
      storeId: store.id,
      name: "あやか",
      lineStatus: "LINKED",
      lineUserId: "U-line-user-1",
      targets: { create: { postsPerWeek: 3, effectiveFrom: "2026-07-27" } },
    },
  });
  castId = cast.id;
});

afterEach(() => {
  delete process.env.LINE_MONTHLY_PUSH_LIMIT;
});

describe("純粋な判定ロジック", () => {
  it("キャッチアップ型: 送信時刻を過ぎていれば何時でも対象", () => {
    // JST 17:00 ちょうど
    expect(isReminderTimeReached(new Date("2026-07-28T08:00:00Z"), 17, 6)).toBe(true);
    // JST 23:00（大幅に遅延して実行された場合）→ それでも送る
    expect(isReminderTimeReached(new Date("2026-07-28T14:00:00Z"), 17, 6)).toBe(true);
    // JST 16:59 → まだ送らない
    expect(isReminderTimeReached(new Date("2026-07-28T07:59:00Z"), 17, 6)).toBe(false);
  });

  it("送信時刻が営業日の区切りより前でも正しく扱える（深夜リマインド）", () => {
    // 区切り6時・リマインド3時 = 営業日の終盤（翌カレンダー日の深夜3時）
    // JST 7/28 06:00（営業日の開始直後）→ まだ送らない
    expect(isReminderTimeReached(new Date("2026-07-27T21:00:00Z"), 3, 6)).toBe(false);
    // JST 7/28 23:00 → まだ送らない
    expect(isReminderTimeReached(new Date("2026-07-28T14:00:00Z"), 3, 6)).toBe(false);
    // JST 7/29 03:00（営業日の21時間後）→ 送る
    expect(isReminderTimeReached(new Date("2026-07-28T18:00:00Z"), 3, 6)).toBe(true);
    // JST 7/29 05:00 → まだ同じ営業日なので送る（キャッチアップ）
    expect(isReminderTimeReached(new Date("2026-07-28T20:00:00Z"), 3, 6)).toBe(true);
  });

  it("区切り0時ならカレンダー時刻と一致する", () => {
    expect(isReminderTimeReached(new Date("2026-07-28T07:59:00Z"), 17, 0)).toBe(false); // JST16:59
    expect(isReminderTimeReached(new Date("2026-07-28T08:00:00Z"), 17, 0)).toBe(true); // JST17:00
  });

  it("直近しきい値日数に更新があればリマインドしない", () => {
    expect(isStale("2026-07-28", 2, new Set(["2026-07-27"]))).toBe(false);
    expect(isStale("2026-07-28", 2, new Set(["2026-07-26"]))).toBe(true);
    expect(isStale("2026-07-28", 2, new Set())).toBe(true);
  });

  it("decideSend の優先順位", () => {
    const base = {
      existingAttemptCount: 0,
      lineStatus: "LINKED" as const,
      monthlySentCount: 0,
      monthlyLimit: 180,
    };
    expect(decideSend({ ...base, existingResult: "SENT" })).toEqual({
      action: "SKIP",
      reason: "ALREADY_SENT",
    });
    expect(
      decideSend({ ...base, existingResult: "FAILED", existingAttemptCount: MAX_SEND_ATTEMPTS }),
    ).toEqual({ action: "SKIP", reason: "MAX_ATTEMPTS" });
    expect(decideSend({ ...base, existingResult: null, lineStatus: "BLOCKED" })).toEqual({
      action: "SKIP",
      reason: "BLOCKED",
    });
    expect(decideSend({ ...base, existingResult: null, monthlySentCount: 180 })).toEqual({
      action: "SKIP",
      reason: "QUOTA",
    });
    expect(decideSend({ ...base, existingResult: null })).toEqual({ action: "SEND" });
    // 他インスタンスが処理中（SENDING かつ猶予内）はスキップ
    expect(
      decideSend({ ...base, existingResult: "SENDING", sendingIsFresh: true }),
    ).toEqual({ action: "SKIP", reason: "IN_PROGRESS" });
    // 猶予を過ぎた SENDING は回収して再送できる
    expect(
      decideSend({ ...base, existingResult: "SENDING", sendingIsFresh: false }),
    ).toEqual({ action: "SEND" });
    // 失敗後（上限未満）は再試行できる
    expect(
      decideSend({ ...base, existingResult: "FAILED", existingAttemptCount: 1 }),
    ).toEqual({ action: "SEND" });
  });
});

describe("runReminders", () => {
  it("未更新のキャストに1通送る", async () => {
    const result = await runReminders(NOW);
    expect(result.targeted).toBe(1);
    expect(result.sent).toBe(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0]).toBe("U-line-user-1");

    const log = await prisma.lineMessageLog.findFirst();
    expect(log?.result).toBe("SENT");
    expect(log?.businessDate).toBe("2026-07-28");
    expect(log?.sentAt).not.toBeNull();
  });

  it("同じ営業日に何度実行しても二重送信しない（冪等）", async () => {
    await runReminders(NOW);
    const second = await runReminders(NOW);
    const third = await runReminders(new Date("2026-07-28T13:00:00Z")); // 同営業日の別時刻

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(second.sent).toBe(0);
    expect(third.sent).toBe(0);
    expect(second.skipped.ALREADY_SENT).toBe(1);
    expect(await prisma.lineMessageLog.count()).toBe(1);
  });

  it("同時に複数インスタンスが走っても二重送信しない（CAS）", async () => {
    // 実装レビューで「upsert しただけでは行ロックにならず、
    // 2プロセスが同じ PENDING を読んで両方送信する」と指摘された箇所の回帰テスト
    const [a, b, c] = await Promise.all([
      runReminders(NOW),
      runReminders(NOW),
      runReminders(NOW),
    ]);

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(a.sent + b.sent + c.sent).toBe(1);
    expect(await prisma.lineMessageLog.count()).toBe(1);
    expect((await prisma.lineMessageLog.findFirst())?.result).toBe("SENT");
  });

  it("店舗を限定して実行できる（他店舗の枠を消費しない）", async () => {
    const otherStore = await prisma.store.create({
      data: { name: "別店", businessDayStart: 6, reminderHour: 17, daysStaleThreshold: 2 },
    });
    await prisma.cast.create({
      data: {
        storeId: otherStore.id,
        name: "べつこ",
        lineStatus: "LINKED",
        lineUserId: "U-other",
      },
    });

    const result = await runReminders(NOW, { storeIds: [otherStore.id] });
    expect(result.checkedStores).toBe(1);
    expect(result.sent).toBe(1);
    expect(pushMock.mock.calls[0][0]).toBe("U-other");
  });

  it("送信時刻前は何もしない", async () => {
    const result = await runReminders(new Date("2026-07-28T07:00:00Z")); // JST 16:00
    expect(result.targeted).toBe(0);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("直近に更新があるキャストは対象外", async () => {
    await prisma.blogPost.create({
      data: {
        castId,
        postedAt: NOW,
        businessDate: "2026-07-27",
        businessWeekStart: "2026-07-27",
        source: "STAFF_ENTRY",
      },
    });
    const result = await runReminders(NOW);
    expect(result.targeted).toBe(0);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("無効化された記録は「更新した」とみなさない", async () => {
    await prisma.blogPost.create({
      data: {
        castId,
        postedAt: NOW,
        businessDate: "2026-07-27",
        businessWeekStart: "2026-07-27",
        source: "STAFF_ENTRY",
        voidedAt: new Date(),
        voidReason: "誤記録",
      },
    });
    const result = await runReminders(NOW);
    expect(result.targeted).toBe(1);
    expect(result.sent).toBe(1);
  });

  it("送信失敗は FAILED として記録され、次回リトライされる", async () => {
    pushMock.mockRejectedValueOnce(new Error("LINE API error 500"));

    const first = await runReminders(NOW);
    expect(first.failed).toBe(1);
    const failedLog = await prisma.lineMessageLog.findFirst();
    expect(failedLog?.result).toBe("FAILED");
    expect(failedLog?.attemptCount).toBe(1);

    // 次の tick で再試行され、今度は成功する
    pushMock.mockResolvedValue(undefined);
    const second = await runReminders(NOW);
    expect(second.sent).toBe(1);

    const finalLog = await prisma.lineMessageLog.findFirst();
    expect(finalLog?.result).toBe("SENT");
    expect(finalLog?.attemptCount).toBe(2);
    // 行は増えていない（ユニーク制約により1営業日1行）
    expect(await prisma.lineMessageLog.count()).toBe(1);
  });

  it("試行上限に達したら再試行しない", async () => {
    pushMock.mockRejectedValue(new Error("permanent failure"));

    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
      await runReminders(NOW);
    }
    expect(pushMock).toHaveBeenCalledTimes(MAX_SEND_ATTEMPTS);

    const extra = await runReminders(NOW);
    expect(extra.skipped.MAX_ATTEMPTS).toBe(1);
    expect(pushMock).toHaveBeenCalledTimes(MAX_SEND_ATTEMPTS); // 増えない
  });

  it("月間上限に達したら送信せず SKIPPED_QUOTA を記録する", async () => {
    process.env.LINE_MONTHLY_PUSH_LIMIT = "0";
    const result = await runReminders(NOW);

    expect(result.sent).toBe(0);
    expect(result.skipped.QUOTA).toBe(1);
    expect(pushMock).not.toHaveBeenCalled();

    const log = await prisma.lineMessageLog.findFirst();
    expect(log?.result).toBe("SKIPPED_QUOTA");
  });

  it("ブロック中のキャストには送らず SKIPPED_BLOCKED を記録する", async () => {
    await prisma.cast.update({ where: { id: castId }, data: { lineStatus: "BLOCKED" } });
    const result = await runReminders(NOW);
    expect(result.sent).toBe(0);
    expect(result.skipped.BLOCKED).toBe(1);
    expect(pushMock).not.toHaveBeenCalled();
    expect((await prisma.lineMessageLog.findFirst())?.result).toBe("SKIPPED_BLOCKED");
  });

  it("未連携のキャストは SKIPPED_NOT_LINKED として記録される", async () => {
    await prisma.cast.update({
      where: { id: castId },
      data: { lineStatus: "NOT_LINKED", lineUserId: null },
    });
    const result = await runReminders(NOW);
    expect(result.sent).toBe(0);
    expect(result.skipped.NOT_LINKED).toBe(1);
    expect((await prisma.lineMessageLog.findFirst())?.result).toBe("SKIPPED_NOT_LINKED");
  });

  it("未連携だったキャストが同じ日に連携したら送信される（回復性）", async () => {
    await prisma.cast.update({
      where: { id: castId },
      data: { lineStatus: "NOT_LINKED", lineUserId: null },
    });
    await runReminders(NOW);
    expect(pushMock).not.toHaveBeenCalled();

    // 連携が完了した後の tick では送信される
    await prisma.cast.update({
      where: { id: castId },
      data: { lineStatus: "LINKED", lineUserId: "U-line-user-1" },
    });
    const second = await runReminders(NOW);
    expect(second.sent).toBe(1);
    expect(await prisma.lineMessageLog.count()).toBe(1);
  });

  it("退店したキャストは対象外", async () => {
    await prisma.cast.update({ where: { id: castId }, data: { status: "RETIRED" } });
    const result = await runReminders(NOW);
    expect(result.targeted).toBe(0);
  });

  it("文面に今週の進捗が入る", async () => {
    await runReminders(NOW);
    const [, messages] = pushMock.mock.calls[0];
    expect(messages[0].text).toContain("あやか");
    expect(messages[0].text).toContain("0/3");
  });
});
