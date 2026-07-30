/**
 * 文面作成のブラウザ検証。
 *
 * 単体テストでは「関数が正しく動く」ことしか分からない。
 * 実際にキャストが触る画面が動くかは、ブラウザで確かめるしかない
 * （過去に、単体テストが全て通っているのに更新記録の登録が
 *   フォームからは一切動かないという不具合を出したことがある）。
 *
 * 確かめること:
 * - LINE から渡されるリンクで画面が開く
 * - 生成すると3案が表示される
 * - コピーボタンが実際にクリップボードへ書き込む
 * - 「投稿しました」で更新実績が記録される
 * - 期限切れ・改ざんされたリンクでは開けない
 * - 生成しただけでは実績が増えない
 *
 * 実行手順:
 *   1. npm run e2e:draft   （モックAPIとサーバーの起動込み）
 */

import { PrismaClient } from "@prisma/client";

import { launchChromium } from "../scripts/chromium.mts";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";

const prisma = new PrismaClient();
const fails: string[] = [];
const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? "✔" : "✘"} ${label}`);
  if (!cond) fails.push(label);
};

// =============================================================
// 準備: 在籍キャストと、その署名付きリンクを用意する
// =============================================================
const cast = await prisma.cast.findFirst({
  where: { status: "ACTIVE" },
  include: { store: true },
});
if (!cast) {
  console.error("在籍キャストがいません。先に npm run db:seed を実行してください。");
  process.exit(1);
}

await prisma.store.update({ where: { id: cast.storeId }, data: { draftEnabled: true } });
await prisma.castWritingProfile.upsert({
  where: { castId: cast.id },
  create: {
    castId: cast.id,
    firstPerson: "わたし",
    toneNote: "「〜だよ」をよく使う",
    topics: "猫",
    emojiLevel: 1,
  },
  update: {},
});

const { issueCastToken } = await import("../src/lib/draft/cast-link.ts");
const token = issueCastToken(cast.id);

const postsBefore = await prisma.blogPost.count({ where: { castId: cast.id } });

const browser = await launchChromium();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, // スマートフォン想定
  locale: "ja-JP",
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await ctx.newPage();

// =============================================================
// 1. リンクで画面が開く
// =============================================================
await page.goto(`${BASE}/c/${token}`, { waitUntil: "networkidle" });
const body = await page.locator("body").innerText();
ok("署名付きリンクで文面作成の画面が開く", body.includes("文面づくり"));
ok("キャスト名が表示される", body.includes(cast.name));
ok("下書きであることが明示されている", body.includes("下書き"));

// =============================================================
// 2. 生成する
// =============================================================
await page.selectOption("#theme", "today");
await page.fill("#keywords", "新しいネイルにした");
await page.click('button:has-text("文面をつくる")');
await page.waitForSelector("article", { timeout: 30000 }).catch(() => {});

const articles = await page.locator("article").count();
ok("生成すると案が表示される", articles > 0);
ok("3案が表示される", articles === 3);

const firstDraft = await page.locator("article p").first().innerText();
ok("案の本文が空でない", firstDraft.trim().length > 0);

// =============================================================
// 3. コピーボタンが実際に書き込む
// =============================================================
await page.locator('article button:has-text("コピー")').first().click();
await page.waitForTimeout(500);
const clipboard = await page.evaluate(() => navigator.clipboard.readText());
ok("コピーボタンでクリップボードに入る", clipboard.trim() === firstDraft.trim());
ok(
  "コピー後にボタンの表示が変わる",
  (await page.locator('article button:has-text("コピーしました")').count()) === 1,
);

// =============================================================
// 4. 生成しただけでは実績が増えない
// =============================================================
const postsAfterGenerate = await prisma.blogPost.count({ where: { castId: cast.id } });
ok("生成しただけでは更新実績が増えない", postsAfterGenerate === postsBefore);

// =============================================================
// 5. 「投稿しました」で記録される
// =============================================================
await page.click('button:has-text("投稿しました")');
await page.waitForTimeout(2500);
const reported = await page.locator("body").innerText();
ok("報告すると画面に結果が出る", /記録しました|記録済み/.test(reported));

const postsAfterReport = await prisma.blogPost.count({ where: { castId: cast.id } });
ok("更新実績が1件増える", postsAfterReport === postsBefore + 1);

const latest = await prisma.blogPost.findFirst({
  where: { castId: cast.id },
  orderBy: { createdAt: "desc" },
});
ok("本人の申告として記録される", latest?.source === "CAST_LINE");

// =============================================================
// 6. 実行ログが残る（費用の把握に使う）
// =============================================================
const generation = await prisma.draftGeneration.findFirst({
  where: { castId: cast.id },
  orderBy: { createdAt: "desc" },
});
ok("生成の実行ログが残る", generation?.result === "OK");
ok("トークン数が記録される", (generation?.inputTokens ?? 0) > 0);

// =============================================================
// 7. 改ざん・期限切れのリンクでは開けない
// =============================================================
const [castId, exp, sig] = token.split(".");
const tamperedRes = await page.goto(`${BASE}/c/${castId}.${exp}.${sig.slice(0, -1)}X`, {
  waitUntil: "networkidle",
});
ok("署名を書き換えたリンクは開けない", tamperedRes?.status() === 404);

const expired = `${castId}.${Date.now() - 1000}.${sig}`;
const expiredRes = await page.goto(`${BASE}/c/${expired}`, { waitUntil: "networkidle" });
ok(
  "期限切れのリンクは開けない",
  expiredRes?.status() === 404 ||
    (await page.locator("body").innerText()).includes("有効期限"),
);

const otherRes = await page.goto(`${BASE}/c/not-a-token`, { waitUntil: "networkidle" });
ok("でたらめなリンクは開けない", otherRes?.status() === 404);

await ctx.close();
await browser.close();
await prisma.$disconnect();

console.log(`\n=== 文面作成E2E: ${fails.length === 0 ? "全項目パス" : `${fails.length}件 失敗`} ===`);
if (fails.length) {
  fails.forEach((f) => console.log("  失敗:", f));
  process.exitCode = 1;
}
