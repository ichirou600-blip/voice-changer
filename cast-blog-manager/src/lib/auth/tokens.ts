/**
 * セッショントークン・招待トークンの生成とハッシュ化。
 *
 * 平文トークンは Cookie / URL にしか存在せず、DB には常に SHA-256 ハッシュのみを保存する。
 * （DB が漏洩してもセッション乗っ取り・招待リンク悪用ができない）
 *
 * トークンは十分な乱数長（32バイト = 256bit）を持つため、
 * パスワードのような遅いハッシュ（argon2）ではなく SHA-256 で十分。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** URL セーフな乱数トークンを生成する（32バイト = base64url 43文字） */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** トークンを DB 保存用のハッシュに変換する */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * ハッシュ同士を定数時間で比較する。
 * （DB 検索は tokenHash の一意インデックスで行うため通常は不要だが、
 *   アプリ側で突き合わせる場合に使う）
 */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * キャストの LINE 連携用ワンタイムコード。
 * キャストが LINE のトークルームに手入力するため、
 * 読み間違えやすい文字（0/O, 1/I/L）を除いた 8 文字にする。
 */
const LINK_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateLinkCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += LINK_CODE_ALPHABET[bytes[i] % LINK_CODE_ALPHABET.length];
  }
  return out;
}

/** 入力された連携コードを正規化する（小文字・空白・全角の揺れを吸収） */
export function normalizeLinkCode(input: string): string {
  return input
    .trim()
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s-]/g, "")
    .toUpperCase();
}
