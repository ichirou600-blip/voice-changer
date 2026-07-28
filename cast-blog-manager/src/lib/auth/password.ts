/**
 * パスワードハッシュ（argon2id）。
 *
 * 設計レビュー（デビルズアドボケイト）で以下を指摘され、対策済み:
 * - scrypt は maxmem 制約・libuv スレッドプール枯渇・自己記述フォーマット欠如の
 *   地雷が多く、「bcrypt はネイティブビルドが必要」という回避理由自体が誤りだった
 *   → prebuilt バイナリで動作する @node-rs/argon2 (argon2id) を採用
 * - ハッシュ文字列にアルゴリズムとパラメータが埋め込まれるため、
 *   将来パラメータを引き上げても既存ハッシュの検証が壊れない
 * - 検証失敗時の応答時間差でユーザーの存在が漏れるため、
 *   ユーザー不在時もダミーハッシュを検証する（verifyDummyPassword）
 */

import { hash, verify } from "@node-rs/argon2";

/** OWASP 推奨相当（argon2id: m=19MiB, t=2, p=1） */
const ARGON2_OPTIONS = {
  memoryCost: 19456, // KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * ユーザー不在時のタイミング差を消すためのダミーハッシュ。
 * 実在しないパスワードから生成した固定値。
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$REYMg5eIAnDnT2+GWeqnQw$AQUDQdfYUWr8ZHkvS6zj/+k2DDtrijD36O+9FSMR7No";

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * パスワードを検証する。ハッシュが壊れている場合も false を返す（例外を投げない）。
 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * ユーザーが存在しなかった場合に呼ぶ。
 * 実在ユーザーと同じ計算コストを消費してタイミング攻撃による
 * ユーザー列挙を防ぐ。戻り値は常に false。
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  await verifyPassword(DUMMY_HASH, password);
  return false;
}
