import "server-only";

/**
 * LINE Messaging API クライアント（必要な機能のみの薄いラッパー）。
 *
 * 送信数は課金に直結するため、呼び出しは必ず
 * `sendReminderIfAllowed`（quota 判定込み）経由で行うこと。
 */

/**
 * LINE API のベース URL。
 * 通常は既定値のままだが、検証時にモックサーバーへ向けられるようにしている。
 */
const LINE_API_BASE = process.env.LINE_API_BASE ?? "https://api.line.me/v2/bot";

export class LineApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`LINE API error ${status}: ${message}`);
    this.name = "LineApiError";
    this.status = status;
  }
}

function accessToken(): string {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません");
  return token;
}

export type LineMessage =
  | { type: "text"; text: string }
  | { type: "text"; text: string; quickReply: unknown };

/** Push 送信（1通 = 無料枠を1消費する） */
export async function pushMessage(to: string, messages: LineMessage[]): Promise<void> {
  const res = await fetch(`${LINE_API_BASE}/message/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken()}`,
    },
    body: JSON.stringify({ to, messages }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LineApiError(res.status, body.slice(0, 300));
  }
}

/**
 * 応答メッセージ（replyToken を使う）。
 * **Push と違って無料枠を消費しない**ため、
 * Webhook への応答は必ずこちらを使う。
 */
export async function replyMessage(replyToken: string, messages: LineMessage[]): Promise<void> {
  const res = await fetch(`${LINE_API_BASE}/message/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken()}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LineApiError(res.status, body.slice(0, 300));
  }
}

/** 「投稿したよ」タップ時に出す確認用のクイックリプライ */
export function selfReportConfirmMessage(): LineMessage {
  return {
    type: "text",
    text: "ブログを更新しましたか？どの分を記録しますか？",
    quickReply: {
      items: [
        {
          type: "action",
          action: { type: "postback", label: "今日の分", data: "report=today", displayText: "今日の分" },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "昨日の分",
            data: "report=yesterday",
            displayText: "昨日の分",
          },
        },
        {
          type: "action",
          action: { type: "postback", label: "キャンセル", data: "report=cancel", displayText: "キャンセル" },
        },
      ],
    },
  };
}

export function textMessage(text: string): LineMessage {
  return { type: "text", text };
}
