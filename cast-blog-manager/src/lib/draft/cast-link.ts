/**
 * キャスト専用ページ（文面作成）へのアクセストークン。
 *
 * キャストは管理ユーザーではなく、パスワードもメールアドレスも持たない。
 * そのため LINE のリッチメニューをタップした瞬間に **短命の署名付き URL** を発行し、
 * その URL を知っていること自体を認証とする。
 *
 * 設計上の判断:
 * - **DB に持たせない**（ステートレス HMAC）。
 *   キャストは1日に何度もタップするため、毎回トークン行を作ると
 *   無駄な書き込みが増え、失効処理も必要になる。
 *   代わりに有効期限を署名対象に含め、期限切れを検証時に弾く。
 * - 有効期限は **60分**。リンクが LINE のトーク履歴に残っても、
 *   翌日以降に第三者が拾って使うことはできない。
 * - トークンは URL に載るため、`Referrer-Policy: no-referrer`（proxy.ts）と
 *   ページ内に外部リンクを置かないことをセットで守る。
 * - 署名鍵は専用の環境変数にする。他用途（セッション・cron）の鍵を使い回すと、
 *   片方が漏れたときの影響範囲が広がる。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** トークンの有効期間（60分） */
export const CAST_LINK_TTL_MS = 60 * 60 * 1000;

function secret(): string {
  const value = process.env.CAST_LINK_SECRET;
  if (!value || value.length < 32) {
    throw new Error(
      "CAST_LINK_SECRET が設定されていないか短すぎます（32文字以上・`openssl rand -hex 32` で生成してください）",
    );
  }
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/**
 * キャスト用トークンを発行する。
 * 形式: `<castId>.<有効期限のミリ秒>.<署名>`
 */
export function issueCastToken(castId: string, now: Date = new Date()): string {
  const expiresAt = now.getTime() + CAST_LINK_TTL_MS;
  const payload = `${castId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

export type CastTokenVerdict =
  | { ok: true; castId: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * トークンを検証する。
 *
 * 署名の照合は定数時間で行う（トークンの一部を推測されないようにするため）。
 * 期限切れは署名が正しい場合にだけ判定する（有効期限の値を細工されても効かない）。
 */
export function verifyCastToken(token: string, now: Date = new Date()): CastTokenVerdict {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  const [castId, expiresRaw, signature] = parts;
  const expiresAt = Number.parseInt(expiresRaw, 10);
  if (!castId || !Number.isSafeInteger(expiresAt)) return { ok: false, reason: "malformed" };

  const expected = Buffer.from(sign(`${castId}.${expiresRaw}`), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "bad_signature" };
  }

  if (now.getTime() >= expiresAt) return { ok: false, reason: "expired" };

  return { ok: true, castId };
}

/** LINE のメッセージに載せる絶対 URL を組み立てる */
export function castDraftUrl(castId: string, now: Date = new Date()): string {
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("APP_URL が設定されていません");
  return `${base}/c/${issueCastToken(castId, now)}`;
}

/** 文面作成が使える状態か（未設定の環境で LINE 導線だけ出さないための判定） */
export function isDraftFeatureConfigured(): boolean {
  return Boolean(
    process.env.CAST_LINK_SECRET &&
      process.env.CAST_LINK_SECRET.length >= 32 &&
      process.env.ANTHROPIC_API_KEY &&
      process.env.APP_URL,
  );
}
