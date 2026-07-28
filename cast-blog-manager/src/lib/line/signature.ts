import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * LINE Webhook の署名検証。
 *
 * LINE プラットフォームは、リクエストボディを channelSecret で HMAC-SHA256 した値を
 * Base64 エンコードして `X-Line-Signature` ヘッダに載せてくる。
 *
 * この検証が Webhook の唯一の認可手段（Origin 照合は使えない）ため、
 * **検証に失敗したリクエストは必ず 400 で捨てる**こと。
 */
export function verifyLineSignature(
  channelSecret: string,
  rawBody: string,
  signature: string | null,
): boolean {
  if (!signature || !channelSecret) return false;

  const expected = createHmac("sha256", channelSecret).update(rawBody).digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
