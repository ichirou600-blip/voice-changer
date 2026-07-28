/**
 * LINE リッチメニューを登録する（導入時に1回だけ実行）。
 *
 * 事前に `.env` へ LINE_CHANNEL_ACCESS_TOKEN を設定し、
 * `npm run line:image` で assets/rich-menu.png を生成しておくこと。
 *
 * 実行: npm run line:setup
 *
 * 何度実行しても最終状態は同じ（同名の既存メニューを削除してから登録する）。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { config } from "dotenv";

config({ path: ".env" });

import { setupRichMenu } from "../src/lib/line/rich-menu";

async function main() {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません（.env を確認してください）");
    process.exitCode = 1;
    return;
  }

  const imagePath = path.resolve("assets/rich-menu.png");
  let image: Buffer;
  try {
    image = await readFile(imagePath);
  } catch {
    console.error(
      `画像が見つかりません: ${imagePath}\n先に \`npm run line:image\` を実行してください。`,
    );
    process.exitCode = 1;
    return;
  }

  const richMenuId = await setupRichMenu(image);
  console.log(`リッチメニューを登録しました: ${richMenuId}`);
  console.log("キャストの LINE トーク画面下部にメニューが表示されます。");
}

await main();
