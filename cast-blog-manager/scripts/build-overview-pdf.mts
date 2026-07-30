/**
 * 依頼者・お客様への共有用「仕様概要」PDF（A4・1ページ）を生成する。
 *
 * 文言や項目を変更する場合は docs/overview-sheet.html を編集して再実行する。
 * 管理画面のスクリーンショットは HTML 内に base64 で埋め込んである。
 *
 * 実行: npm run docs:overview
 * 出力: docs/仕様概要.pdf
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { launchChromium } from "./chromium.mts";

const html = await readFile("docs/overview-sheet.html", "utf8");
const browser = await launchChromium();
try {
  const page = await (await browser.newContext({ locale: "ja-JP" })).newPage();
  await page.setContent(html, { waitUntil: "load" });
  const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
  });
  const out = path.resolve("docs/仕様概要.pdf");
  await writeFile(out, pdf);
  console.log(`生成しました: ${out}（${(pdf.length / 1024).toFixed(0)} KB）`);
} finally {
  await browser.close();
}
