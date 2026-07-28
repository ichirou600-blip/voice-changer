/**
 * リマインド送信判定のポリシー（純粋関数）。
 *
 * 設計ルール（docs/DESIGN.md 決定2〜5）:
 * - tick は「キャッチアップ型」: 現在時刻が reminderHour に **到達済み** なら送る。
 *   スケジューラの遅延・スキップで丸1日分が消失するのを防ぐ
 * - 二重送信は LineMessageLog のユニーク制約 + 本ポリシーの二段構えで防ぐ
 * - 失敗は attemptCount 上限まで再試行できる（SENT のみ再送をブロック）
 *
 * DB アクセスを含まないため単体テストで全分岐を検証できる。
 */

import { jstHour, recentBusinessDates } from "./business-day";

/** 送信失敗時の最大試行回数 */
export const MAX_SEND_ATTEMPTS = 3;

/**
 * 店舗の送信時刻に到達しているか。
 * 「一致」ではなく「以上」で判定するのが要点（遅延しても取りこぼさない）。
 */
export function isReminderTimeReached(now: Date, reminderHour: number): boolean {
  if (!Number.isInteger(reminderHour) || reminderHour < 0 || reminderHour > 23) {
    throw new RangeError(`reminderHour は 0〜23 の整数で指定してください: ${reminderHour}`);
  }
  return jstHour(now) >= reminderHour;
}

/**
 * 直近 daysStaleThreshold 営業日に有効な更新が無いか（= リマインド対象か）。
 *
 * @param recentPostDates 有効な（無効化されていない）BlogPost の businessDate 集合
 */
export function isStale(
  today: string,
  daysStaleThreshold: number,
  recentPostDates: ReadonlySet<string>,
): boolean {
  const window = recentBusinessDates(today, daysStaleThreshold);
  return !window.some((d) => recentPostDates.has(d));
}

export type SendDecision =
  | { action: "SEND" }
  | { action: "SKIP"; reason: "ALREADY_SENT" | "MAX_ATTEMPTS" | "NOT_LINKED" | "BLOCKED" | "QUOTA" };

export type SendDecisionInput = {
  /** claim 済みログの現在の結果（未作成なら null） */
  existingResult:
    | "PENDING"
    | "SENT"
    | "FAILED"
    | "SKIPPED_QUOTA"
    | "SKIPPED_BLOCKED"
    | "SKIPPED_NOT_LINKED"
    | null;
  existingAttemptCount: number;
  lineStatus: "NOT_LINKED" | "LINKED" | "BLOCKED";
  /** 当月これまでの送信済み（SENT）件数 */
  monthlySentCount: number;
  /** 月間送信上限 */
  monthlyLimit: number;
};

/**
 * 1キャストについて、いま Push を送るべきかを判定する。
 *
 * 判定順序に意味がある:
 *   1. 送信済み → 二度と送らない（冪等性の要）
 *   2. 試行上限 → これ以上再試行しない
 *   3. 未連携/ブロック → 送信不能
 *   4. 月間上限 → コスト保護（SKIPPED_QUOTA として記録し、翌月に自然回復）
 */
export function decideSend(input: SendDecisionInput): SendDecision {
  const {
    existingResult,
    existingAttemptCount,
    lineStatus,
    monthlySentCount,
    monthlyLimit,
  } = input;

  if (existingResult === "SENT") {
    return { action: "SKIP", reason: "ALREADY_SENT" };
  }
  if (existingAttemptCount >= MAX_SEND_ATTEMPTS) {
    return { action: "SKIP", reason: "MAX_ATTEMPTS" };
  }
  if (lineStatus === "BLOCKED") {
    return { action: "SKIP", reason: "BLOCKED" };
  }
  if (lineStatus === "NOT_LINKED") {
    return { action: "SKIP", reason: "NOT_LINKED" };
  }
  if (monthlySentCount >= monthlyLimit) {
    return { action: "SKIP", reason: "QUOTA" };
  }
  return { action: "SEND" };
}
