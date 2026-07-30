/**
 * LINE リマインドの月間送信数を試算する。
 *
 * 資料に載せる通数はここで算出する。**手計算で出さないこと。**
 * （実際に、等間隔の更新を仮定して出した数値を資料に載せてしまい、
 *   曜日が偏る現実の更新パターンでは3倍ずれることが後から判明した）
 *
 * 判定には実装の `isStale` をそのまま使うため、
 * リマインドの仕様を変えるとこの数値も自動的に追従する。
 *
 * 実行: npm run docs:simulate
 */

import { addDays, recentBusinessDates } from "../src/lib/business-day";
import { isStale } from "../src/lib/reminder-policy";

/** 試算する日数（1年 = 52週ちょうど） */
const DAYS = 364;
/** 開始日（月曜） */
const START = "2026-01-05";

/**
 * 更新パターンは**曜日の集合**で表す。
 * 実際の更新は曜日に偏るため、等間隔を仮定すると通数を過小に見積もる。
 * （0=日曜 … 6=土曜）
 */
const PATTERNS: { label: string; days: number[] }[] = [
  { label: "週5回（月〜金）", days: [1, 2, 3, 4, 5] },
  { label: "週3回・曜日を分散（月水金）", days: [1, 3, 5] },
  { label: "週3回・週末に集中（金土日）", days: [5, 6, 0] },
  { label: "週2回（金土）", days: [5, 6] },
  { label: "週1回（土のみ）", days: [6] },
  { label: "まったく更新しない", days: [] },
];

const THRESHOLDS = [2, 3];
/** 月間の送信上限（既定値） */
const MONTHLY_LIMIT = 180;

function simulate(postDays: number[], threshold: number): number {
  let day = START;
  const posted = new Set<string>();
  let sent = 0;

  for (let i = 0; i < DAYS; i++) {
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (postDays.includes(dow)) posted.add(day);

    const window = recentBusinessDates(day, threshold);
    const inWindow = new Set([...posted].filter((d) => window.includes(d)));
    if (isStale(day, threshold, inWindow)) sent += 1;

    day = addDays(day, 1);
  }

  return sent / 12; // 月あたり
}

for (const threshold of THRESHOLDS) {
  console.log(`\n=== 未更新と判定する日数: ${threshold}営業日 ===`);
  console.log("更新パターン".padEnd(30) + "月間送信数".padStart(10) + `  ${MONTHLY_LIMIT}通で運用できる人数`);
  for (const { label, days } of PATTERNS) {
    const monthly = simulate(days, threshold);
    const capacity = monthly === 0 ? "上限なし" : `${Math.floor(MONTHLY_LIMIT / monthly)}人`;
    console.log(label.padEnd(30) + `${monthly.toFixed(1)}通`.padStart(10) + `  ${capacity}`);
  }
}

console.log(
  "\n※ 1人1営業日1通・実装の isStale による判定。送信上限や判定日数は店舗設定で変更できます。",
);
