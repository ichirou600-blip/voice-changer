import { logger } from "@/lib/logger";

/**
 * LINE リッチメニューの登録。
 *
 * キャストが「投稿したよ」を1タップで報告できるようにするための常設メニュー。
 * これが無いとキャストは毎回テキストを入力する必要があり、運用が続かない。
 *
 * セットアップは `npm run line:setup` から1回だけ実行する
 * （LINE 側にメニューが登録され、全友だちの既定メニューになる）。
 */

// 検証時にモックサーバーへ向けられるよう環境変数で上書き可能にしている
const LINE_API_BASE = process.env.LINE_API_BASE ?? "https://api.line.me/v2/bot";
const LINE_DATA_API_BASE = process.env.LINE_DATA_API_BASE ?? "https://api-data.line.me/v2/bot";

/** リッチメニューの領域定義（3分割・幅2500 × 高さ843 = LINE の compact サイズ） */
export const RICH_MENU_WIDTH = 2500;
export const RICH_MENU_HEIGHT = 843;

/**
 * 3分割の境界。
 * 2500 は3で割り切れないため、端数を最後の領域に寄せて
 * 「隙間なく・重ならず・右端まで覆う」状態を保つ（テストで検証している）。
 */
const THIRD = Math.floor(RICH_MENU_WIDTH / 3);

export const RICH_MENU_DEFINITION = {
  size: { width: RICH_MENU_WIDTH, height: RICH_MENU_HEIGHT },
  selected: true,
  name: "cast-blog-manager",
  chatBarText: "メニュー",
  areas: [
    {
      bounds: { x: 0, y: 0, width: THIRD, height: RICH_MENU_HEIGHT },
      action: {
        type: "postback",
        label: "投稿したよ",
        data: "menu=report",
        displayText: "投稿したよ",
      },
    },
    {
      bounds: { x: THIRD, y: 0, width: THIRD, height: RICH_MENU_HEIGHT },
      action: {
        type: "postback",
        label: "文面をつくる",
        data: "menu=draft",
        displayText: "文面をつくる",
      },
    },
    {
      bounds: {
        x: THIRD * 2,
        y: 0,
        width: RICH_MENU_WIDTH - THIRD * 2,
        height: RICH_MENU_HEIGHT,
      },
      action: {
        type: "postback",
        label: "今週の状況",
        data: "menu=status",
        displayText: "今週の状況",
      },
    },
  ],
} as const;

function accessToken(): string {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません");
  return token;
}

async function lineFetch(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken()}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LINE API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

/** リッチメニューを作成し、その ID を返す */
export async function createRichMenu(): Promise<string> {
  const res = await lineFetch(`${LINE_API_BASE}/richmenu`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(RICH_MENU_DEFINITION),
  });
  const json = (await res.json()) as { richMenuId: string };
  return json.richMenuId;
}

/** リッチメニューの画像を登録する（PNG または JPEG） */
export async function uploadRichMenuImage(
  richMenuId: string,
  image: Buffer,
  contentType: "image/png" | "image/jpeg" = "image/png",
): Promise<void> {
  await lineFetch(`${LINE_DATA_API_BASE}/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(image),
  });
}

/** 全ユーザーの既定リッチメニューに設定する */
export async function setDefaultRichMenu(richMenuId: string): Promise<void> {
  await lineFetch(`${LINE_API_BASE}/user/all/richmenu/${richMenuId}`, { method: "POST" });
}

/** 登録済みリッチメニューの一覧 */
export async function listRichMenus(): Promise<{ richMenuId: string; name: string }[]> {
  const res = await lineFetch(`${LINE_API_BASE}/richmenu/list`, { method: "GET" });
  const json = (await res.json()) as { richmenus: { richMenuId: string; name: string }[] };
  return json.richmenus;
}

/** リッチメニューを削除する */
export async function deleteRichMenu(richMenuId: string): Promise<void> {
  await lineFetch(`${LINE_API_BASE}/richmenu/${richMenuId}`, { method: "DELETE" });
}

/**
 * 既存の同名メニューを片付けてから新規に登録し、既定メニューに設定する。
 * 何度実行しても最終状態が同じになる（冪等）。
 */
export async function setupRichMenu(image: Buffer): Promise<string> {
  const existing = await listRichMenus();
  for (const menu of existing) {
    if (menu.name === RICH_MENU_DEFINITION.name) {
      await deleteRichMenu(menu.richMenuId);
      logger.info("line.richmenu.deleted", { richMenuId: menu.richMenuId });
    }
  }

  const richMenuId = await createRichMenu();
  await uploadRichMenuImage(richMenuId, image);
  await setDefaultRichMenu(richMenuId);
  logger.info("line.richmenu.created", { richMenuId });
  return richMenuId;
}
