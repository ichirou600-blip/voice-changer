/**
 * 権限境界と招待フローのブラウザ検証。
 *
 * 実装レビューで指摘された以下が、実際のブラウザ操作で塞がれているかを確かめる。
 * - STAFF が /users で同僚のメールアドレスを見られない
 *   （見られると、それを使ってログインを連続失敗させ店長を締め出せる）
 * - STAFF に LINE 連携コードが表示されない
 *   （見えると、キャスト本人より先に自分の LINE を紐付けて実績を捏造できる）
 * - STAFF が記録を無効化できない
 * - 招待リンクが GET では消費されず、POST で1回だけ消費される
 *
 * 実行手順:
 *   1. npm run build && PORT=3100 npm run start
 *   2. npm run db:seed
 *   3. npm run e2e:permissions
 */

import { launchChromium } from "../scripts/chromium.mts";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const ADMIN = { email: "admin@example.com", password: "dev-password-1234" };
const STAFF = { email: "staff-e2e@example.com", password: "staff-password-1234" };

const browser = await launchChromium();
const fails: string[] = [];
const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? "✔" : "✘"} ${label}`);
  if (!cond) fails.push(label);
};

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP" });
  return { ctx, page: await ctx.newPage() };
}

async function login(page: import("playwright").Page, who: { email: string; password: string }) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', who.email);
  await page.fill('input[name="password"]', who.password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 }).catch(() => {});
}

// =============================================================
// 1. 管理者が STAFF を招待する
// =============================================================
const admin = await newPage();
await login(admin.page, ADMIN);
ok("管理者でログインできる", admin.page.url().includes("/dashboard"));

await admin.page.goto(`${BASE}/users`, { waitUntil: "networkidle" });
await admin.page.fill('input[name="name"]', "E2Eスタッフ");
await admin.page.fill('input[name="email"]', STAFF.email);
await admin.page.selectOption('select[name="role"]', "STAFF");
await admin.page.click('button:has-text("招待リンクを発行")');
await admin.page.waitForTimeout(2500);

const inviteText = await admin.page.locator("body").innerText();
const inviteUrl = inviteText.match(/https?:\/\/\S*\/invite\/\S+/)?.[0] ?? "";
ok("招待リンクが発行され画面に表示される", inviteUrl.length > 0);

// =============================================================
// 2. 招待リンクは GET では消費されない（プレビューbot対策）
// =============================================================
const guest = await newPage();
const invitePath = inviteUrl.replace(/^https?:\/\/[^/]+/, "");
await guest.page.goto(`${BASE}${invitePath}`, { waitUntil: "networkidle" });
ok(
  "招待リンクを開くとパスワード設定画面が出る",
  (await guest.page.locator("body").innerText()).includes("アカウントの作成"),
);
// もう一度開いても有効なまま
await guest.page.reload({ waitUntil: "networkidle" });
ok(
  "何度開いてもリンクが無効にならない",
  (await guest.page.locator("body").innerText()).includes("アカウントの作成"),
);

// =============================================================
// 3. 招待を受諾（POST で1回だけ消費される）
// =============================================================
await guest.page.fill('input[name="password"]', STAFF.password);
await guest.page.click('button:has-text("パスワードを設定")');
await guest.page.waitForTimeout(3000);
ok("受諾するとログイン画面へ遷移する", guest.page.url().includes("/login"));

// 同じリンクをもう一度使うと無効
await guest.page.goto(`${BASE}${invitePath}`, { waitUntil: "networkidle" });
ok(
  "使用済みリンクは無効になる",
  (await guest.page.locator("body").innerText()).includes("無効"),
);
await guest.ctx.close();

// =============================================================
// 4. STAFF でログインし、権限境界を確認する
// =============================================================
const staff = await newPage();
await login(staff.page, STAFF);
ok("招待されたスタッフでログインできる", staff.page.url().includes("/dashboard"));

// --- /users は見えない ---
const usersRes = await staff.page.goto(`${BASE}/users`, { waitUntil: "networkidle" });
const usersText = await staff.page.locator("body").innerText();
ok("STAFF は /users にアクセスできない（404）", usersRes?.status() === 404);
ok("STAFF に同僚のメールアドレスが漏れない", !usersText.includes(ADMIN.email));

// --- 設定画面に送信数が出ない ---
await staff.page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
const settingsText = await staff.page.locator("body").innerText();
ok("STAFF に LINE 送信数が表示されない", !settingsText.includes("今月の LINE 送信数"));
ok("STAFF に「今すぐリマインドを実行」が出ない", !settingsText.includes("今すぐリマインドを実行"));

// --- キャスト詳細に連携コードが出ない ---
// 先に管理者側でコードを発行しておく
await admin.page.goto(`${BASE}/casts`, { waitUntil: "networkidle" });
await admin.page.locator('tbody tr a:has-text("詳細")').first().click();
await admin.page.waitForLoadState("networkidle");
const castUrl = admin.page.url();
await admin.page.click('button:has-text("連携コードを発行")');
await admin.page.waitForTimeout(2500);
const adminDetail = await admin.page.locator("body").innerText();
const code = adminDetail.match(/\b[A-HJ-NP-Z2-9]{8}\b/)?.[0] ?? "";
ok("管理者には連携コードが表示される", code.length === 8);

await staff.page.goto(castUrl, { waitUntil: "networkidle" });
const staffDetail = await staff.page.locator("body").innerText();
ok("STAFF には連携コードが表示されない", code.length === 8 && !staffDetail.includes(code));
ok("STAFF に「連携コードを発行」ボタンが出ない", !staffDetail.includes("連携コードを発行"));
ok("STAFF に基本情報の編集フォームが出ない", !staffDetail.includes("週次目標の変更"));

// --- 記録は作れるが無効化はできない ---
await staff.page.goto(`${BASE}/posts`, { waitUntil: "networkidle" });
const postsText = await staff.page.locator("body").innerText();
ok("STAFF は更新記録を入力できる", postsText.includes("更新を記録"));
ok("STAFF に無効化ボタンが出ない", (await staff.page.locator('button:has-text("無効化")').count()) === 0);

// =============================================================
// 5. 管理者が STAFF を無効化すると即座に締め出される
// =============================================================
await admin.page.goto(`${BASE}/users`, { waitUntil: "networkidle" });
await admin.page.locator(`tr:has-text("${STAFF.email}") button:has-text("無効化")`).click();
await admin.page.waitForTimeout(3000);

const afterDisable = await staff.page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
ok(
  "無効化されたスタッフは即座にログイン画面へ戻される",
  staff.page.url().includes("/login") || afterDisable?.status() === 401,
);

await staff.ctx.close();
await admin.ctx.close();
await browser.close();

console.log(`\n=== 権限境界E2E: ${fails.length === 0 ? "全項目パス" : `${fails.length}件 失敗`} ===`);
if (fails.length) {
  fails.forEach((f) => console.log("  失敗:", f));
  process.exitCode = 1;
}
