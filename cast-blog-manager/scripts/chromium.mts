/**
 * この環境にプリインストールされた Chromium を使うためのヘルパ。
 *
 * PLAYWRIGHT_BROWSERS_PATH 配下のバイナリを直接指定する。
 * （playwright のバージョンとブラウザのビルド番号がずれていても動かすため）
 */
import { existsSync } from "node:fs";

import { chromium, type Browser } from "playwright";

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter(Boolean) as string[];

export async function launchChromium(): Promise<Browser> {
  const executablePath = CANDIDATES.find((p) => existsSync(p));
  return chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}
