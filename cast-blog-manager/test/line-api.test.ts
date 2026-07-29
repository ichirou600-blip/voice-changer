import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * LINE Messaging API との通信内容の検証。
 *
 * 本物の LINE には接続できないため、**LINE の仕様どおりに検証するモックサーバー**を
 * 立てて、こちらが送るリクエストの形（パス・ヘッダ・ボディ）が正しいかを確かめる。
 *
 * ここが間違っていると、導入初日に「通知が届かない」という形で顧客に露見する。
 * 検証する内容:
 * - エンドポイントのパス
 * - Authorization: Bearer ヘッダ
 * - Content-Type
 * - リクエストボディの構造（LINE のドキュメントに準拠しているか）
 * - エラー応答時に例外を投げるか
 */

type Captured = {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
};

let server: Server;
let captured: Captured[] = [];
/** 次のリクエストに返すステータス（エラー系の検証用） */
let nextStatus = 200;
let nextBody = "{}";

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      captured.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: {
          authorization: req.headers.authorization,
          "content-type": req.headers["content-type"],
        },
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(nextStatus, { "Content-Type": "application/json" });
      res.end(nextBody);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  process.env.LINE_API_BASE = `http://127.0.0.1:${port}/v2/bot`;
  process.env.LINE_DATA_API_BASE = `http://127.0.0.1:${port}/v2/bot`;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-access-token";
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.LINE_API_BASE;
  delete process.env.LINE_DATA_API_BASE;
});

beforeEach(() => {
  captured = [];
  nextStatus = 200;
  nextBody = "{}";
});

describe("Push 送信", () => {
  it("LINE の仕様どおりのリクエストを送る", async () => {
    const { pushMessage, textMessage } = await import("@/lib/line/client");
    await pushMessage("U-target-user", [textMessage("こんばんは")]);

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v2/bot/message/push");
    expect(req.headers.authorization).toBe("Bearer test-access-token");
    expect(req.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(req.body);
    expect(body.to).toBe("U-target-user");
    expect(body.messages).toEqual([{ type: "text", text: "こんばんは" }]);
  });

  it("エラー応答なら例外を投げる（呼び出し側が FAILED として記録できる）", async () => {
    const { pushMessage, textMessage, LineApiError } = await import("@/lib/line/client");
    nextStatus = 429;
    nextBody = JSON.stringify({ message: "You have reached your monthly limit." });

    await expect(pushMessage("U-1", [textMessage("x")])).rejects.toThrow(LineApiError);
    await expect(pushMessage("U-1", [textMessage("x")])).rejects.toThrow(/429/);
  });

  it("アクセストークン未設定なら送信を試みない", async () => {
    const { pushMessage, textMessage } = await import("@/lib/line/client");
    const saved = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;

    await expect(pushMessage("U-1", [textMessage("x")])).rejects.toThrow(
      /LINE_CHANNEL_ACCESS_TOKEN/,
    );
    expect(captured).toHaveLength(0);

    process.env.LINE_CHANNEL_ACCESS_TOKEN = saved;
  });
});

describe("応答（reply）送信", () => {
  it("replyToken を使い、Push とは別のエンドポイントを叩く", async () => {
    const { replyMessage, textMessage } = await import("@/lib/line/client");
    await replyMessage("reply-token-abc", [textMessage("記録しました")]);

    const req = captured[0];
    expect(req.path).toBe("/v2/bot/message/reply");
    const body = JSON.parse(req.body);
    expect(body.replyToken).toBe("reply-token-abc");
    expect(body.messages[0].text).toBe("記録しました");
    // Push ではないので to は含めない（含めると LINE 側で 400 になる）
    expect(body.to).toBeUndefined();
  });

  it("クイックリプライ付きメッセージが LINE の構造で送られる", async () => {
    const { replyMessage, selfReportConfirmMessage } = await import("@/lib/line/client");
    await replyMessage("rt", [selfReportConfirmMessage()]);

    const body = JSON.parse(captured[0].body);
    const message = body.messages[0];
    expect(message.type).toBe("text");
    expect(message.quickReply.items).toHaveLength(3);

    const actions = message.quickReply.items.map(
      (i: { action: { type: string; data: string; label: string } }) => i.action,
    );
    expect(actions.map((a: { data: string }) => a.data)).toEqual([
      "report=today",
      "report=yesterday",
      "report=cancel",
    ]);
    for (const a of actions) {
      expect(a.type).toBe("postback");
      // LINE の制約: label は 20 文字以内
      expect(a.label.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("リッチメニュー登録", () => {
  it("作成→画像アップロード→既定設定 の順に正しく呼ぶ", async () => {
    const { setupRichMenu } = await import("@/lib/line/rich-menu");

    // 一覧（既存なし）→ 作成 → 画像 → 既定設定 の順に応答する
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        captured.push({
          method: req.method ?? "",
          path: req.url ?? "",
          headers: {
            authorization: req.headers.authorization,
            "content-type": req.headers["content-type"],
          },
          body: Buffer.concat(chunks).toString("binary"),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url?.includes("/richmenu/list")) res.end(JSON.stringify({ richmenus: [] }));
        else res.end(JSON.stringify({ richMenuId: "richmenu-test-id" }));
      });
    });

    const id = await setupRichMenu(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(id).toBe("richmenu-test-id");

    const paths = captured.map((c) => `${c.method} ${c.path}`);
    expect(paths).toEqual([
      "GET /v2/bot/richmenu/list",
      "POST /v2/bot/richmenu",
      "POST /v2/bot/richmenu/richmenu-test-id/content",
      "POST /v2/bot/user/all/richmenu/richmenu-test-id",
    ]);

    // 作成リクエストのボディが LINE の仕様に沿っているか
    const create = JSON.parse(captured[1].body);
    expect(create.size).toEqual({ width: 2500, height: 843 });
    expect(create.selected).toBe(true);
    expect(create.chatBarText.length).toBeLessThanOrEqual(14); // LINE の制約
    expect(create.areas).toHaveLength(2);
    for (const area of create.areas) {
      expect(area.bounds.width).toBeGreaterThan(0);
      expect(area.action.type).toBe("postback");
      expect(area.action.label.length).toBeLessThanOrEqual(20);
    }
    // 2領域が重ならず、幅いっぱいを覆っているか
    const [left, right] = create.areas;
    expect(left.bounds.x + left.bounds.width).toBe(right.bounds.x);
    expect(right.bounds.x + right.bounds.width).toBe(2500);

    // 画像アップロードは Content-Type が image/png
    expect(captured[2].headers["content-type"]).toBe("image/png");
  });
});
