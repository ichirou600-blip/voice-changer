/**
 * 資料用のスクリーンショットを一括で撮る。
 *
 * 依頼者向けの説明資料（docs/仕様説明.pdf）に貼る画面を、
 * 実際に動いているアプリから撮る。手描きのモックを貼ると
 * 「資料と実物が違う」という最悪の食い違いが起きるため。
 *
 * 前提: 本番サーバーが :3100 で起動していること（npm run build && PORT=3100 npm run start）
 * 実行: npm run docs:shots
 * 出力: docs/shots/*.png
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { issueCastToken } from "../src/lib/draft/cast-link.ts";
import { launchChromium } from "./chromium.mts";

const BASE = process.env.SHOT_BASE_URL ?? "http://localhost:3100";
const OUT = path.resolve("docs/shots");
const ADMIN = { email: "admin@example.com", password: "dev-password-1234" };

/** 開発中だけ出るバッジを消す（資料に写ると製品の印象を損なう） */
const HIDE_DEVTOOLS =
  "nextjs-portal,[data-nextjs-toast],#__next-build-watcher{display:none!important}";

await mkdir(OUT, { recursive: true });

const prisma = new PrismaClient();
const browser = await launchChromium();

// =============================================================
// キャスト画面（スマートフォン）
// =============================================================
const cast = await prisma.cast.findFirst({ where: { status: "ACTIVE" } });
if (!cast) throw new Error("在籍キャストがいません。npm run db:seed を先に実行してください。");

await prisma.castWritingProfile.upsert({
  where: { castId: cast.id },
  create: {
    castId: cast.id,
    firstPerson: "わたし",
    toneNote: "「〜だよ」をよく使う。テンション高め",
    topics: "カフェ巡り、猫、ネイル",
    emojiLevel: 1,
  },
  update: {},
});

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  locale: "ja-JP",
  deviceScaleFactor: 2,
});
const phone = await mobile.newPage();
const token = issueCastToken(cast.id);

/**
 * 資料に貼る都合上、余白を含めた全画面ではなく必要な範囲だけを切り出す。
 * 全画面のまま貼ると下半分が空白になり、逆に読みづらくなる。
 */
async function clipTo(name: string, selector: string, pad = 10) {
  const box = await phone.locator(selector).first().boundingBox();
  if (!box) throw new Error(`要素が見つかりません: ${selector}`);
  await phone.screenshot({
    path: path.join(OUT, `${name}.png`),
    fullPage: true,
    clip: {
      x: 0,
      y: Math.max(0, box.y - pad),
      width: 390,
      height: box.height + pad * 2,
    },
  });
  console.log(`撮影: ${name}.png`);
}

// 入力画面（見出しと入力フォーム）
await phone.goto(`${BASE}/c/${token}`, { waitUntil: "networkidle" });
await phone.addStyleTag({ content: HIDE_DEVTOOLS });
await clipTo("cast-input", "section:has(#theme)");

// 生成結果（案の一覧と報告ボタン）
await phone.selectOption("#theme", "today");
await phone.fill("#keywords", "新しいネイルにした");
await phone.click('button:has-text("文面をつくる")');
await phone.waitForSelector("article", { timeout: 30000 });
await phone.addStyleTag({ content: HIDE_DEVTOOLS });
await clipTo("cast-result", "section:has(article)");

await mobile.close();

// =============================================================
// 管理画面（PC）
// =============================================================
const desktop = await browser.newContext({
  viewport: { width: 1280, height: 1000 },
  locale: "ja-JP",
  deviceScaleFactor: 2,
});
const page = await desktop.newPage();

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[name="email"]', ADMIN.email);
await page.fill('input[name="password"]', ADMIN.password);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 20000 });

async function shot(name: string, url: string, selector?: string, pad = 24) {
  await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: HIDE_DEVTOOLS });
  await page.waitForTimeout(300);

  if (!selector) {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  } else {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`要素が見つかりません: ${selector}`);
    // fullPage を付けないと clip がビューポート内に切り詰められ、
    // 折り返しより下にある要素が途中で切れる
    await page.screenshot({
      path: path.join(OUT, `${name}.png`),
      fullPage: true,
      clip: {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: Math.min(1280, box.width + pad * 2),
        height: box.height + pad * 2,
      },
    });
  }
  console.log(`撮影: ${name}.png`);
}

await shot("admin-dashboard", "/dashboard");
await shot("admin-posts", "/posts");
// 見出しではなく、それを含むカード全体を切り出す
await shot("admin-settings-draft", "/settings", 'div:has(> h3:has-text("文面作成"))', 12);

// キャスト詳細（話し方の設定）。
// クリックではなく href を読んで直接開く（ハイドレーション待ちに左右されないため）
await page.goto(`${BASE}/casts`, { waitUntil: "networkidle" });
const castHref = await page.locator('tbody tr a:has-text("詳細")').first().getAttribute("href");
if (!castHref) throw new Error("キャスト詳細へのリンクが見つかりません");
await shot("admin-cast-profile", castHref, 'div:has(> h2:has-text("話し方の設定"))', 12);

await desktop.close();

await browser.close();
await prisma.$disconnect();

console.log(`\n完了: ${OUT}`);
