import { launchChromium } from "../scripts/chromium.mts";

/**
 * ブラウザからの通し確認（スモークテスト）。
 *
 * 単体テストは DAL を直接呼ぶため、
 * 「フォームが実際に送る値」で壊れるバグを検出できない。
 * （実際に、未入力の日付欄が空文字で送られて更新記録の登録が
 *   まったく動かないというバグをここで発見した）
 *
 * 実行手順:
 *   1. npm run build && PORT=3100 npm run start
 *   2. npm run db:seed  （admin@example.com / dev-password-1234）
 *   3. npm run e2e
 */
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP" });
const page = await ctx.newPage();
const fails: string[] = [];
const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? "✔" : "✘"} ${label}`);
  if (!cond) fails.push(label);
};

// --- 1. ログイン ---
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[name="email"]', "admin@example.com");
await page.fill('input[name="password"]', "dev-password-1234");
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 15000 }).catch(() => {});
ok("ログインしてダッシュボードへ遷移", page.url().includes("/dashboard"));

// --- 2. Cookie が httpOnly か ---
const cookie = (await ctx.cookies()).find((c) => c.name.includes("cbm_session"));
ok("セッションCookieが httpOnly", cookie?.httpOnly === true);
ok("セッションCookieが __Host- プレフィックス付き", cookie?.name.startsWith("__Host-") === true);

// --- 3. 更新記録を追加 ---
await page.goto(`${BASE}/posts`, { waitUntil: "networkidle" });
const before = await page.locator("tbody tr").count();
await page.selectOption('select[name="castId"]', { label: "れいな" });
await page.fill('input[name="title"]', "E2Eテストの記録");
await page.click('button:has-text("記録する")');
await page.waitForTimeout(2500);
const afterText = await page.locator("body").innerText();
ok("記録の成功メッセージが出る", afterText.includes("記録しました"));
await page.reload({ waitUntil: "networkidle" });
const after = await page.locator("tbody tr").count();
ok(`記録が一覧に増える (${before} → ${after})`, after === before + 1);
ok("追加した記録が表示される", (await page.locator("body").innerText()).includes("E2Eテストの記録"));

// --- 4. ダッシュボードに反映される ---
await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
const dash = await page.locator("body").innerText();
ok("ダッシュボードで れいな が 1/3 回になる", /れいな[\s\S]{0,80}1\/3/.test(dash));

// --- 5. 記録の無効化（MANAGER以上） ---
await page.goto(`${BASE}/posts`, { waitUntil: "networkidle" });
await page.locator('button:has-text("無効化")').first().click();
await page.fill('input[name="reason"]', "E2E検証のため");
await page.click('button:has-text("確定")');
await page.waitForTimeout(2500);
await page.reload({ waitUntil: "networkidle" });
ok("無効化が理由つきで表示される", (await page.locator("body").innerText()).includes("E2E検証のため"));

// --- 6. CSV ダウンロード ---
const dl = await Promise.all([
  page.waitForEvent("download", { timeout: 15000 }),
  page.click('a[href*="/api/export/posts"]'),
]).then(([d]) => d).catch(() => null);
if (dl) {
  const stream = await dl.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  const csv = Buffer.concat(chunks).toString("utf8");
  ok("CSVがBOM付きで出力される", csv.charCodeAt(0) === 0xfeff);
  ok("CSVに日本語ヘッダが含まれる", csv.includes("営業日") && csv.includes("キャスト"));
  ok("CSVに無効化理由が含まれる", csv.includes("E2E検証のため"));
} else {
  ok("CSVダウンロード", false);
}

// --- 7. キャスト登録と連携コード発行 ---
await page.goto(`${BASE}/casts`, { waitUntil: "networkidle" });
await page.fill('input[name="name"]', "E2Eキャスト");
await page.fill('input[name="postsPerWeek"]', "2");
await page.click('button:has-text("追加")');
await page.waitForTimeout(2500);
await page.reload({ waitUntil: "networkidle" });
ok("キャストを追加できる", (await page.locator("body").innerText()).includes("E2Eキャスト"));

await page.locator('tr:has-text("E2Eキャスト") a:has-text("詳細")').click();
await page.waitForLoadState("networkidle");
await page.click('button:has-text("連携コードを発行")');
await page.waitForTimeout(2500);
const detail = await page.locator("body").innerText();
ok("連携コードが8桁で表示される", /[A-Z2-9]{8}/.test(detail));

// --- 8. ログアウト ---
await page.click('button:has-text("ログアウト")');
await page.waitForTimeout(2000);
await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
ok("ログアウト後はログイン画面へ戻される", page.url().includes("/login"));

await page.screenshot({ path: "screenshots/e2e-final.png", fullPage: true }).catch(() => {});
await browser.close();

console.log(`\n=== E2E: ${fails.length === 0 ? "全項目パス" : `${fails.length}件 失敗`} ===`);
if (fails.length) { fails.forEach(f => console.log("  失敗:", f)); process.exitCode = 1; }
