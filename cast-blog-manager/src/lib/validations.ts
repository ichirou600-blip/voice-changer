import { z } from "zod";

import { isValidBusinessDate } from "./business-day";
import { MIN_PASSWORD_LENGTH } from "./constants";

/** 入力バリデーション（zod）。Server Action の入口で必ず通す */

export const emailSchema = z
  .string()
  .trim()
  .min(1, "メールアドレスを入力してください")
  .email("メールアドレスの形式が正しくありません")
  .max(254)
  .transform((v) => v.toLowerCase());

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `パスワードは${MIN_PASSWORD_LENGTH}文字以上で設定してください`)
  .max(200, "パスワードが長すぎます");

export const nameSchema = z.string().trim().min(1, "名前を入力してください").max(60);

export const roleSchema = z.enum(["ADMIN", "MANAGER", "STAFF"]);

export const businessDateSchema = z
  .string()
  .refine(isValidBusinessDate, "日付の形式が正しくありません（YYYY-MM-DD）");

/**
 * 任意入力の営業日。
 *
 * HTML フォームは未入力の項目を **空文字** として送信するため、
 * `.optional()` だけでは「未入力」を弾いてしまう
 * （実際にこれで更新記録の登録が動かないバグが発生した）。
 * 空文字を undefined に正規化して受け取る。
 */
export const optionalBusinessDateSchema = z
  .union([businessDateSchema, z.literal("")])
  .optional()
  .transform((v) => (v ? v : undefined));

/** 初回セットアップ（最初の管理者 + 店舗を作成） */
export const setupSchema = z.object({
  storeName: z.string().trim().min(1, "店舗名を入力してください").max(60),
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  // ログイン時は長さ制限のみ（既存パスワードを弾かないため）
  password: z.string().min(1, "パスワードを入力してください").max(200),
});

export const inviteSchema = z.object({
  email: emailSchema,
  name: nameSchema,
  role: roleSchema,
  storeId: z.string().min(1).nullable().optional(),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export const storeSettingsSchema = z.object({
  storeId: z.string().min(1),
  name: z.string().trim().min(1, "店舗名を入力してください").max(60),
  businessDayStart: z.coerce
    .number()
    .int("0〜23の整数で指定してください")
    .min(0, "0〜23の整数で指定してください")
    .max(23, "0〜23の整数で指定してください"),
  reminderHour: z.coerce.number().int().min(0).max(23),
  daysStaleThreshold: z.coerce
    .number()
    .int()
    .min(1, "1以上で指定してください")
    .max(30, "30以下で指定してください"),
});

export const castCreateSchema = z.object({
  storeId: z.string().min(1, "店舗を選択してください"),
  name: z.string().trim().min(1, "源氏名を入力してください").max(40),
  postsPerWeek: z.coerce
    .number()
    .int("週の目標回数は整数で指定してください")
    .min(0, "0以上で指定してください")
    .max(50, "50以下で指定してください"),
});

export const castUpdateSchema = z.object({
  castId: z.string().min(1),
  name: z.string().trim().min(1, "源氏名を入力してください").max(40),
  status: z.enum(["ACTIVE", "INACTIVE", "RETIRED"]),
});

export const castTargetSchema = z.object({
  castId: z.string().min(1),
  postsPerWeek: z.coerce.number().int().min(0).max(50),
  /** 未指定なら「次に開始する週」から適用 */
  effectiveFrom: optionalBusinessDateSchema,
});

export const postCreateSchema = z.object({
  castId: z.string().min(1, "キャストを選択してください"),
  /** 更新日（営業日）。未指定・空文字なら現在の営業日 */
  businessDate: optionalBusinessDateSchema,
  title: z.string().trim().max(120).optional().or(z.literal("")),
  url: z
    .string()
    .trim()
    .max(500)
    .url("URLの形式が正しくありません")
    .optional()
    .or(z.literal("")),
});

export const postVoidSchema = z.object({
  postId: z.string().min(1),
  reason: z.string().trim().min(1, "無効化の理由を入力してください").max(200),
});

export type SetupInput = z.infer<typeof setupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type InviteInput = z.infer<typeof inviteSchema>;
export type CastCreateInput = z.infer<typeof castCreateSchema>;
export type PostCreateInput = z.infer<typeof postCreateSchema>;

/**
 * FormData を zod スキーマで検証する。
 * 失敗時は最初のエラーメッセージと、フィールド別エラーを返す。
 */
export function parseForm<T extends z.ZodType>(
  schema: T,
  formData: FormData,
): { ok: true; data: z.infer<T> } | { ok: false; error: string; fieldErrors: Record<string, string[]> } {
  const raw: Record<string, unknown> = {};
  formData.forEach((value, key) => {
    if (typeof value === "string") raw[key] = value;
  });
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };

  const flat = result.error.flatten();
  const fieldErrors = flat.fieldErrors as Record<string, string[]>;
  const first =
    Object.values(fieldErrors).flat()[0] ?? flat.formErrors[0] ?? "入力内容を確認してください";
  return { ok: false, error: first, fieldErrors };
}
