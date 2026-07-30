/**
 * 依頼者・お客様への共有用「仕様説明」PDF（A4・5ページ）を生成する。
 *
 * 文言や項目を変更する場合は docs/spec-sheet.html を編集して再実行する。
 * 画面図は docs/shots/ 配下の PNG を参照する（`npm run docs:shots` で更新）。
 *
 * base64 で埋め込まず file:// で開くのは、
 * HTML を素のまま編集・プレビューできるようにするため。
 *
 * 実行: npm run docs:spec
 * 出力: docs/仕様説明.pdf
 */
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { launchChromium } from "./chromium.mts";

const htmlPath = path.resolve("docs/spec-sheet.html");
const shotsDir = path.resolve("docs/shots");

// 画面図が欠けたまま生成すると、空欄の資料が顧客に渡る事故になる
const shots = await readdir(shotsDir).catch(() => [] as string[]);
if (shots.filter((f) => f.endsWith(".png")).length === 0) {
  throw new Error("docs/shots に画面図がありません。先に npm run docs:shots を実行してください。");
}

const browser = await launchChromium();
try {
  const page = await (await browser.newContext({ locale: "ja-JP" })).newPage();

  const missing: string[] = [];
  page.on("requestfailed", (req) => missing.push(req.url()));

  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });

  // 読み込めなかった画像を黙って通さない
  const brokenImages = await page.evaluate(() =>
    [...document.querySelectorAll("img")]
      .filter((img) => !img.complete || img.naturalWidth === 0)
      .map((img) => img.getAttribute("src") ?? ""),
  );
  if (brokenImages.length > 0 || missing.length > 0) {
    throw new Error(`画像を読み込めませんでした: ${[...brokenImages, ...missing].join(", ")}`);
  }

  const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
  });

  const out = path.resolve("docs/仕様説明.pdf");
  await writeFile(out, pdf);
  console.log(`生成しました: ${out}（${(pdf.length / 1024).toFixed(0)} KB）`);
} finally {
  await browser.close();
}
