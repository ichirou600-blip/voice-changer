/**
 * LINE リッチメニュー画像（2500 × 843 PNG）を生成する。
 *
 * 画像編集ソフトを使わずに済むよう、HTML を Chromium でレンダリングして
 * スクリーンショットを撮る方式にしている。
 * 文言や色を変えたい場合はこのファイルの HTML を編集して再実行する。
 *
 * 実行: npm run line:image
 * 出力: assets/rich-menu.png
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { launchChromium } from "./chromium.mts";

const WIDTH = 2500;
const HEIGHT = 843;

const HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    display: flex;
    font-family: "Noto Sans CJK JP", "Noto Sans JP", sans-serif;
  }
  .cell {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 40px;
    color: #fff;
  }
  .left  { background: linear-gradient(135deg, #1e293b 0%, #334155 100%); }
  .right { background: linear-gradient(135deg, #334155 0%, #475569 100%); }
  .divider { width: 4px; background: rgba(255,255,255,0.15); }
  .icon { font-size: 190px; line-height: 1; }
  .label { font-size: 96px; font-weight: 700; letter-spacing: 0.05em; }
  .sub { font-size: 46px; opacity: 0.75; }
</style>
</head>
<body>
  <div class="cell left">
    <div class="icon">✍️</div>
    <div class="label">投稿したよ</div>
    <div class="sub">ブログを更新したらタップ</div>
  </div>
  <div class="divider"></div>
  <div class="cell right">
    <div class="icon">📊</div>
    <div class="label">今週の状況</div>
    <div class="sub">目標までの残りを確認</div>
  </div>
</body>
</html>`;

async function main() {
  const outDir = path.resolve("assets");
  const outPath = path.join(outDir, "rich-menu.png");
  await mkdir(outDir, { recursive: true });

  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    await page.setContent(HTML, { waitUntil: "load" });
    const buffer = await page.screenshot({ type: "png" });
    await writeFile(outPath, buffer);
    console.log(`リッチメニュー画像を生成しました: ${outPath}（${WIDTH}x${HEIGHT}）`);
  } finally {
    await browser.close();
  }
}

await main();
