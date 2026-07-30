import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Claude API との通信内容の検証。
 *
 * LINE と同じ考え方で、**API の仕様どおりに受け取るモックサーバー**を立て、
 * こちらが送るリクエストの形（パス・ヘッダ・ボディ）を確かめる。
 *
 * ここが間違っていると、キャストが「文面をつくる」を押しても
 * 何も出ないという形で顧客に露見する。
 */

type Captured = {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
};

let server: Server;
let captured: Captured[] = [];
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
          "x-api-key": req.headers["x-api-key"] as string | undefined,
          "anthropic-version": req.headers["anthropic-version"] as string | undefined,
          "content-type": req.headers["content-type"],
          // 認証情報を Authorization に入れてしまう実装ミスの検出用
          authorization: req.headers.authorization,
        },
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(nextStatus, { "Content-Type": "application/json" });
      res.end(nextBody);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  process.env.ANTHROPIC_API_BASE = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = "test-api-key";
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.ANTHROPIC_API_BASE;
  delete process.env.ANTHROPIC_API_KEY;
});

beforeEach(() => {
  captured = [];
  nextStatus = 200;
  nextBody = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: "案A\n---\n案B" }],
    usage: { input_tokens: 620, output_tokens: 480 },
  });
});

describe("生成リクエスト", () => {
  it("Messages API の仕様どおりのリクエストを送る", async () => {
    const { complete } = await import("@/lib/draft/anthropic");
    await complete({ system: "システム指示", user: "本文の指示" });

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/messages");
    // 認証は x-api-key（Bearer ではない）
    expect(req.headers["x-api-key"]).toBe("test-api-key");
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(req.body);
    expect(typeof body.model).toBe("string");
    expect(body.max_tokens).toBeGreaterThan(0);
    // system は messages ではなく独立したフィールド
    expect(body.system).toBe("システム指示");
    expect(body.messages).toEqual([{ role: "user", content: "本文の指示" }]);
  });

  it("応答の本文とトークン数を取り出す（費用の記録に使う）", async () => {
    const { complete } = await import("@/lib/draft/anthropic");
    const result = await complete({ system: "s", user: "u" });

    expect(result.text).toBe("案A\n---\n案B");
    expect(result.inputTokens).toBe(620);
    expect(result.outputTokens).toBe(480);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
  });

  it("複数のテキストブロックを連結する", async () => {
    nextBody = JSON.stringify({
      content: [
        { type: "text", text: "前半" },
        { type: "text", text: "後半" },
      ],
    });
    const { complete } = await import("@/lib/draft/anthropic");
    expect((await complete({ system: "s", user: "u" })).text).toBe("前半後半");
  });

  it("usage が無くても落ちない（0 として扱う）", async () => {
    nextBody = JSON.stringify({ content: [{ type: "text", text: "本文" }] });
    const { complete } = await import("@/lib/draft/anthropic");
    const result = await complete({ system: "s", user: "u" });
    expect(result.inputTokens).toBe(0);
  });

  it("エラー応答なら例外を投げる（呼び出し側が FAILED として記録できる）", async () => {
    const { complete, AnthropicApiError } = await import("@/lib/draft/anthropic");
    nextStatus = 429;
    nextBody = JSON.stringify({ error: { message: "rate limit" } });

    await expect(complete({ system: "s", user: "u" })).rejects.toThrow(AnthropicApiError);
    await expect(complete({ system: "s", user: "u" })).rejects.toThrow(/429/);
  });

  it("API キー未設定なら送信を試みない（誤って無認証で叩かない）", async () => {
    const { complete } = await import("@/lib/draft/anthropic");
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    await expect(complete({ system: "s", user: "u" })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(captured).toHaveLength(0);

    process.env.ANTHROPIC_API_KEY = saved;
  });
});

describe("モデルの指定", () => {
  it("環境変数で上書きできる", async () => {
    const { complete } = await import("@/lib/draft/anthropic");
    process.env.ANTHROPIC_MODEL = "claude-sonnet-5";
    await complete({ system: "s", user: "u" });
    expect(JSON.parse(captured[0].body).model).toBe("claude-sonnet-5");
    delete process.env.ANTHROPIC_MODEL;
  });

  it("未設定なら既定のモデルを使う", async () => {
    const { complete, DEFAULT_MODEL } = await import("@/lib/draft/anthropic");
    await complete({ system: "s", user: "u" });
    expect(JSON.parse(captured[0].body).model).toBe(DEFAULT_MODEL);
  });
});
