/**
 * 文面作成の実地検証。
 *
 * 単体テストとE2Eはモックサーバー相手なので、
 * 「実際にどんな日本語が返ってくるか」「本当に文体が散るか」
 * 「NG表現が混ざる頻度」「1回いくらか」は **一度も検証できていない**。
 * このスクリプトは本物の API を叩いて、それらを実測して表にする。
 *
 * 販売前に必ず1回は実行し、出てきた文面を人が読んで判断すること。
 *
 * 使い方:
 *   1. .env に ANTHROPIC_API_KEY を設定する
 *   2. npm run draft:probe            （既定: 4パターン × 2回）
 *      npm run draft:probe -- --runs 3   （繰り返し回数を変える）
 *      npm run draft:probe -- --model claude-sonnet-5   （モデルを変えて比較）
 *
 * DB は使わない（キャスト登録なしで単体で動く）。
 */

import { createRequire } from "node:module";

/**
 * .env の読み込み。
 * Next.js は自動で読むが、このスクリプトは素の Node で動くため明示的に読む
 * （これが無いと .env にキーを書いても「未設定」と言われて混乱する）。
 */
try {
  process.loadEnvFile(".env");
} catch {
  // .env が無い場合は環境変数から取る
}

import { collectNgWords, findNgWords, normalizeForMatch } from "../src/lib/draft/ng-check";
import { buildSystemPrompt, buildUserPrompt, parseDrafts } from "../src/lib/draft/prompt";

/**
 * `src/lib/draft/anthropic.ts` は `import "server-only"` で守られており、
 * Next.js の外から読み込むと例外になる（クライアントへの混入を防ぐための仕組み）。
 *
 * このガードは本番では必要なので**外さない**。
 * 代わりに、このスクリプトの中でだけ空モジュールに差し替えてから読み込む。
 * （テストでも vitest.config.ts で同じことをしている）
 */
const requireFromHere = createRequire(import.meta.url);
const serverOnlyId = requireFromHere.resolve("server-only");
requireFromHere.cache[serverOnlyId] = {
  id: serverOnlyId,
  filename: serverOnlyId,
  loaded: true,
  exports: {},
  children: [],
  paths: [],
} as unknown as NodeJS.Module;

const { complete, draftModel } = await import("../src/lib/draft/anthropic");

// ---------------------------------------------------------------
// 料金（1Mトークンあたりのドル）。請求額の目安を出すためだけに使う。
// 契約中の単価に合わせて変更すること。
// ---------------------------------------------------------------
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-opus-5": { input: 15, output: 75 },
};
const JPY_PER_USD = 155;

function priceFor(model: string) {
  const key = Object.keys(PRICE_PER_MTOK).find((k) => model.startsWith(k));
  return key ? PRICE_PER_MTOK[key] : null;
}

// ---------------------------------------------------------------
// 検証に使うキャスト像。
// **わざと似た条件を並べていない**。
// 文体の設定が実際に出力へ効いているかを見るため、
// 一人称・語尾・話題・絵文字量を意図的にばらしている。
// ---------------------------------------------------------------
const CASTS = [
  {
    name: "あやか",
    profile: { firstPerson: "わたし", toneNote: "「〜だよ」をよく使う。テンション高め", topics: "カフェ巡り、猫、ネイル", emojiLevel: 1 },
    theme: "today",
    keywords: "新しいネイルにした",
  },
  {
    name: "みゆ",
    profile: { firstPerson: "みゆ", toneNote: "ていねいめ。「〜です」「〜ですね」", topics: "お菓子作り、映画", emojiLevel: 0 },
    theme: "thanks",
    keywords: "昨日はたくさん来てくれた",
  },
  {
    name: "れいな",
    profile: { firstPerson: "うち", toneNote: "くだけた口調。「〜やん」", topics: "K-POP、カラオケ、旅行", emojiLevel: 2 },
    theme: "schedule",
    keywords: "金曜と土曜に出勤",
  },
  {
    // プロフィール未入力のケース。導入時に埋め忘れた店舗で何が起きるかを見る
    name: "さくら",
    profile: { firstPerson: "", toneNote: "", topics: "", emojiLevel: 1 },
    theme: "free",
    keywords: "",
  },
];

const STORE = {
  name: "ラウンジ ルミエール",
  guideline: "敬語は使わず親しみやすく。来店のお誘いは最後に一言だけ。",
  ngWords: "他店の名前\nアフター\n本名",
};

const TARGET_LENGTH = 200;

// ---------------------------------------------------------------
// 引数
// ---------------------------------------------------------------
const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1]) || 2;
const modelArg = args.includes("--model") ? args[args.indexOf("--model") + 1] : null;
if (modelArg) process.env.ANTHROPIC_MODEL = modelArg;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY が設定されていません。\n" +
      ".env に実際のキーを設定してから実行してください（このスクリプトは本物の API を呼びます）。",
  );
  process.exit(1);
}

/** 2つの文章がどれくらい似ているか（文字3-gram の重なり率 0〜1） */
function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = normalizeForMatch(s);
    const set = new Set<string>();
    for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared += 1;
  return shared / Math.min(ga.size, gb.size);
}

const ngWords = collectNgWords({ storeNgWords: STORE.ngWords, castNgWords: "" });
const system = buildSystemPrompt();

type Sample = {
  cast: string;
  round: number;
  drafts: string[];
  inputTokens: number;
  outputTokens: number;
  ngHits: string[];
  model: string;
};

const samples: Sample[] = [];
const allDrafts: { cast: string; text: string }[] = [];

console.log(`モデル: ${draftModel()}   キャスト${CASTS.length}名 × ${runs}回 = ${CASTS.length * runs}回の生成を実行します\n`);

for (let round = 1; round <= runs; round++) {
  for (const cast of CASTS) {
    // 直近の文面を渡す（実運用と同じ条件にする。ここを空にすると重複が過小評価される）
    const recentDrafts = allDrafts.slice(-6).map((d) => d.text);

    const user = buildUserPrompt({
      castName: cast.name,
      storeName: STORE.name,
      profile: cast.profile,
      guideline: STORE.guideline,
      ngWords,
      keywords: cast.keywords,
      themeKey: cast.theme,
      recentDrafts,
      targetLength: TARGET_LENGTH,
    });

    const result = await complete({ system, user });
    const drafts = parseDrafts(result.text);
    const ngHits = drafts.flatMap((d) => findNgWords(d, ngWords));

    samples.push({
      cast: cast.name,
      round,
      drafts,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      ngHits,
      model: result.model,
    });
    for (const d of drafts) allDrafts.push({ cast: cast.name, text: d });

    process.stdout.write(`.`);
  }
}
console.log("\n");

// ---------------------------------------------------------------
// 1. 生成された文面（人が読んで判断する部分）
// ---------------------------------------------------------------
console.log("=".repeat(78));
console.log("1. 生成された文面");
console.log("=".repeat(78));
for (const s of samples) {
  console.log(`\n--- ${s.cast}（${s.round}回目）${s.ngHits.length ? "  ⚠ NG検出: " + s.ngHits.join("、") : ""}`);
  s.drafts.forEach((d, i) => {
    console.log(`  [案${i + 1}] ${d.length}文字`);
    console.log(`  ${d.replace(/\n/g, "\n  ")}`);
  });
}

// ---------------------------------------------------------------
// 2. 文体が散っているか（同一キャスト内 vs 別キャスト間）
// ---------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("2. 文面の重複度（3-gram の重なり率・低いほど散っている）");
console.log("=".repeat(78));

const sameCast: number[] = [];
const crossCast: number[] = [];
for (let i = 0; i < allDrafts.length; i++) {
  for (let j = i + 1; j < allDrafts.length; j++) {
    const sim = similarity(allDrafts[i].text, allDrafts[j].text);
    if (allDrafts[i].cast === allDrafts[j].cast) sameCast.push(sim);
    else crossCast.push(sim);
  }
}
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);

console.log(`  同じキャスト内   平均 ${(avg(sameCast) * 100).toFixed(1)}%   最大 ${(max(sameCast) * 100).toFixed(1)}%`);
console.log(`  別のキャスト間   平均 ${(avg(crossCast) * 100).toFixed(1)}%   最大 ${(max(crossCast) * 100).toFixed(1)}%`);
console.log(
  `\n  判断の目安: 別キャスト間の平均が30%を超えるなら、` +
    `店舗内で似た文面が並ぶ恐れがある（話し方の設定を増やすか、指示の見直しが必要）。`,
);

// 最も似ている組を出す（目視で確認するため）
let worst = { sim: 0, a: "", b: "", ca: "", cb: "" };
for (let i = 0; i < allDrafts.length; i++) {
  for (let j = i + 1; j < allDrafts.length; j++) {
    if (allDrafts[i].cast === allDrafts[j].cast) continue;
    const sim = similarity(allDrafts[i].text, allDrafts[j].text);
    if (sim > worst.sim) {
      worst = { sim, a: allDrafts[i].text, b: allDrafts[j].text, ca: allDrafts[i].cast, cb: allDrafts[j].cast };
    }
  }
}
if (worst.sim > 0) {
  console.log(`\n  最も似ていた組（${worst.ca} と ${worst.cb} / ${(worst.sim * 100).toFixed(1)}%）:`);
  console.log(`    A: ${worst.a.slice(0, 70)}`);
  console.log(`    B: ${worst.b.slice(0, 70)}`);
}

// ---------------------------------------------------------------
// 3. 指示が守られているか（機械的に判定できる範囲）
// ---------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("3. 指示の遵守状況");
console.log("=".repeat(78));

const withFirstPerson = CASTS.filter((c) => c.profile.firstPerson);
let fpOk = 0;
let fpTotal = 0;
for (const s of samples) {
  const cast = CASTS.find((c) => c.name === s.cast)!;
  if (!cast.profile.firstPerson) continue;
  for (const d of s.drafts) {
    fpTotal += 1;
    if (normalizeForMatch(d).includes(normalizeForMatch(cast.profile.firstPerson))) fpOk += 1;
  }
}

const lengths = samples.flatMap((s) => s.drafts.map((d) => d.length));
const inRange = lengths.filter((l) => l >= TARGET_LENGTH * 0.8 && l <= TARGET_LENGTH * 1.2).length;
const draftCounts = samples.map((s) => s.drafts.length);
const ngTotal = samples.reduce((a, s) => a + s.ngHits.length, 0);

console.log(`  一人称の遵守       ${fpOk}/${fpTotal} 件（${fpTotal ? ((fpOk / fpTotal) * 100).toFixed(0) : "-"}%）  対象: ${withFirstPerson.map((c) => c.name).join("、")}`);
console.log(`  指定文字数±20%内   ${inRange}/${lengths.length} 件（${((inRange / lengths.length) * 100).toFixed(0)}%）  平均 ${(avg(lengths)).toFixed(0)}文字`);
console.log(`  3案そろった回数    ${draftCounts.filter((c) => c === 3).length}/${draftCounts.length} 回`);
console.log(`  NG表現の検出       ${ngTotal} 件${ngTotal ? "  ← 検査で除外されるが、頻発するなら指示の見直しが必要" : "  （検査をすり抜けた表現がないか、上の文面も目視で確認すること）"}`);

// ---------------------------------------------------------------
// 4. 実測の費用
// ---------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("4. 実測のトークン数と費用");
console.log("=".repeat(78));

const totalIn = samples.reduce((a, s) => a + s.inputTokens, 0);
const totalOut = samples.reduce((a, s) => a + s.outputTokens, 0);
const model = samples[0]?.model ?? draftModel();
const price = priceFor(model);

console.log(`  モデル             ${model}`);
console.log(`  1回あたり入力      ${(totalIn / samples.length).toFixed(0)} トークン`);
console.log(`  1回あたり出力      ${(totalOut / samples.length).toFixed(0)} トークン`);

if (price) {
  const perCall = ((totalIn / samples.length) * price.input + (totalOut / samples.length) * price.output) / 1_000_000;
  const perCallJpy = perCall * JPY_PER_USD;
  console.log(`  1回あたり費用      $${perCall.toFixed(5)}（約 ${perCallJpy.toFixed(2)} 円）`);
  console.log("");
  for (const [people, freq, label] of [
    [100, 1, "100名が週1回"],
    [100, 3, "100名が週3回"],
    [100, 7, "100名が毎日"],
  ] as [number, number, string][]) {
    const monthly = people * freq * (365 / 12 / 7);
    console.log(`  ${label.padEnd(14)} 月 ${monthly.toFixed(0).padStart(5)}回 → 約 ${(monthly * perCallJpy).toFixed(0)} 円`);
  }
  console.log(`\n  ※ 資料に記載した単価と差がある場合は、docs/spec-sheet.html を実測値に合わせて更新すること。`);
} else {
  console.log(`  （${model} の単価が未登録のため費用は算出していません）`);
}

console.log("\n" + "=".repeat(78));
console.log("最終判断は人が行ってください。上の「1. 生成された文面」を必ず読み、");
console.log("お店として出せる文章かどうかを確認したうえで導入可否を決めること。");
console.log("=".repeat(78));
