/**
 * リマインド送信判定のポリシー（純粋関数）。
 *
 * 設計ルール（docs/DESIGN.md 決定2〜5）:
 * - tick は「キャッチアップ型」: 送信時刻に **到達済み** なら送る。
 *   スケジューラの遅延・スキップで丸1日分が消失するのを防ぐ
 * - 二重送信は LineMessageLog の条件付き更新（CAS）で防ぐ。
 *   ユニーク制約だけでは「行の重複」しか防げず、
 *   複数インスタンスが同時に走ると同じ行を見て二重送信しうる
 * - 失敗は attemptCount 上限まで再試行できる（SENT のみ再送をブロック）
 *
 * DB アクセスを含まないため単体テストで全分岐を検証できる。
 */

import { jstHour, recentBusinessDates } from "./business-day";

/** 送信失敗時の最大試行回数 */
export const MAX_SEND_ATTEMPTS = 3;

/**
 * 店舗の送信時刻に到達しているか。
 *
 * 重要: 判定は **カレンダー時刻ではなく営業日内の経過時間** で行う。
 * 重複排除のキーが営業日（businessDate）である一方、
 * カレンダー時刻で `jstHour >= reminderHour` と判定すると、
 * `reminderHour < businessDayStart` のときに設定時刻へ永久に到達しない
 * （例: 区切り6時・リマインド3時 → 実際には毎朝6時に送信されてしまう）。
 *
 * 営業日の開始からの経過時間で比較すれば、深夜帯の送信時刻も正しく扱える。
 */
export function isReminderTimeReached(
  now: Date,
  reminderHour: number,
  businessDayStart: number,
): boolean {
  assertHour(reminderHour, "reminderHour");
  assertHour(businessDayStart, "businessDayStart");

  const elapsed = (jstHour(now) - businessDayStart + 24) % 24;
  const target = (reminderHour - businessDayStart + 24) % 24;
  return elapsed >= target;
}

function assertHour(hour: number, label: string): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`${label} は 0〜23 の整数で指定してください: ${hour}`);
  }
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
  | {
      action: "SKIP";
      reason: "ALREADY_SENT" | "MAX_ATTEMPTS" | "NOT_LINKED" | "BLOCKED" | "QUOTA" | "IN_PROGRESS";
    };

export type MessageResultValue =
  | "PENDING"
  | "SENDING"
  | "SENT"
  | "FAILED"
  | "SKIPPED_QUOTA"
  | "SKIPPED_BLOCKED"
  | "SKIPPED_NOT_LINKED";

export type SendDecisionInput = {
  /** ログ行の現在の結果（未作成なら null） */
  existingResult: MessageResultValue | null;
  existingAttemptCount: number;
  lineStatus: "NOT_LINKED" | "LINKED" | "BLOCKED";
  /** 当月これまでの送信済み（SENT）件数 */
  monthlySentCount: number;
  /** 月間送信上限 */
  monthlyLimit: number;
  /** SENDING 状態が「他インスタンスが処理中」とみなせるか（回収猶予内か） */
  sendingIsFresh?: boolean;
};

/**
 * 1キャストについて、いま Push を送るべきかを判定する。
 *
 * 判定順序に意味がある:
 *   1. 送信済み   → 二度と送らない（冪等性の要）
 *   2. 処理中     → 他インスタンスに任せる
 *   3. 試行上限   → これ以上再試行しない
 *   4. ブロック   → 送信不能
 *   5. 未連携     → 送信先が無い
 *   6. 月間上限   → コスト保護（SKIPPED_QUOTA として記録し、翌月に自然回復）
 */
export function decideSend(input: SendDecisionInput): SendDecision {
  const {
    existingResult,
    existingAttemptCount,
    lineStatus,
    monthlySentCount,
    monthlyLimit,
    sendingIsFresh = false,
  } = input;

  if (existingResult === "SENT") {
    return { action: "SKIP", reason: "ALREADY_SENT" };
  }
  if (existingResult === "SENDING" && sendingIsFresh) {
    return { action: "SKIP", reason: "IN_PROGRESS" };
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
