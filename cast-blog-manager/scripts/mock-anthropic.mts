/**
 * Claude API のモックサーバー（検証用）。
 *
 * ブラウザでの通し確認（`npm run e2e:draft`）で本物の API を叩くと、
 * 実行するたびに費用が発生し、応答内容も毎回変わって検証にならない。
 * そのため、API と同じ形で応答するだけのサーバーを立てて代用する。
 *
 * 実行: tsx scripts/mock-anthropic.mts [ポート]
 * アプリ側には ANTHROPIC_API_BASE=http://127.0.0.1:<ポート> を渡す。
 */

import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 4599);

/** 3案を「---」区切りで返す（実装が期待する形式） */
const DRAFTS = [
  "こんばんは、わたしです🌙 今日は新しいネイルにしてきたよ。指先が変わるだけで気分まで上がるのが不思議。お店で会ったらぜひ見てほしいな。",
  "新しいネイルにしたよ〜！今回はちょっと落ち着いた色にしてみたの。写真だと伝わりにくいけど、光に当たるとすごくきれい。今週も待ってるね。",
  "ネイルを変えてきました🐾 迷った末に選んだ色がすごく気に入ってて、さっきから何度も自分の手を見ちゃってる。今日も元気に出勤してるよ。",
];

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(Buffer.from(c)));
  req.on("end", () => {
    if (req.url !== "/v1/messages" || req.method !== "POST") {
      res.writeHead(404).end("{}");
      return;
    }

    // API キーが渡っていない実装ミスをここで露見させる
    if (!req.headers["x-api-key"]) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "missing x-api-key" } }));
      return;
    }

    const body = Buffer.concat(chunks).toString("utf8");
    console.log(`[mock-anthropic] ${body.length} bytes 受信`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_mock",
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text: DRAFTS.join("\n---\n") }],
        usage: { input_tokens: 640, output_tokens: 520 },
      }),
    );
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-anthropic] http://127.0.0.1:${PORT} で待機中`);
});
