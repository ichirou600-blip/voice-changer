import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { isSameOrigin } from "@/lib/http/csrf";
import { logger } from "@/lib/logger";

import { getSessionUser, type SessionUser } from "./session";

/**
 * 認可レイヤ。
 *
 * 設計レビューで指摘された最重要リスクへの対策:
 * 1. **Server Actions の素通り**
 *    App Router の `"use server"` 関数は自動的に公開 POST エンドポイントになる。
 *    UI でボタンを隠しても Action 本体に認可が無ければ意味がない。
 *    → 生の Server Action を書かず、必ず `defineAction()` で包む規約にする。
 * 2. **店舗境界（IDOR）**
 *    MANAGER/STAFF が他店舗の ID を指定すると読み書きできてしまう。
 *    → 全クエリに `storeScope()` の where 条件を必ず混ぜる。
 *    ADMIN のみ全店舗横断が許される。
 */

export const ROLE_RANK = { STAFF: 0, MANAGER: 1, ADMIN: 2 } as const;
export type Role = keyof typeof ROLE_RANK;

/** 認可失敗を表す例外（Server Action からはメッセージのみ返す） */
export class AuthorizationError extends Error {
  constructor(message = "この操作を行う権限がありません") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class AuthenticationError extends Error {
  constructor(message = "ログインが必要です") {
    super(message);
    this.name = "AuthenticationError";
  }
}

/** 認証済みユーザーを取得する。未認証なら例外（Server Action / DAL 用） */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthenticationError();
  return user;
}

/** 認証済みユーザーを取得する。未認証ならログイン画面へリダイレクト（ページ用） */
export async function requireUserOrRedirect(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export function hasRole(user: SessionUser, minimum: Role): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}

/** 指定ロール以上であることを要求する */
export async function requireRole(minimum: Role): Promise<SessionUser> {
  const user = await requireUser();
  if (!hasRole(user, minimum)) throw new AuthorizationError();
  return user;
}

/**
 * 店舗スコープの where 条件を返す。
 *
 * - ADMIN: 全店舗（条件なし）
 * - それ以外: 自店舗のみ。所属店舗が無いユーザーは
 *   決して真にならない条件を返して 0 件にする（フェイルクローズ）
 */
export function storeScope(user: SessionUser): { storeId?: string } {
  if (user.role === "ADMIN") return {};
  if (!user.storeId) {
    // 所属店舗が無い非ADMINは何も見えない（空文字の storeId は存在しない）
    return { storeId: "__no_store__" };
  }
  return { storeId: user.storeId };
}

/**
 * 対象の店舗にアクセスできるかを検証する。
 * 他店舗のリソースを ID 指定で触ろうとした場合にここで弾く。
 */
export function assertStoreAccess(user: SessionUser, storeId: string | null | undefined): void {
  if (user.role === "ADMIN") return;
  if (!storeId || storeId !== user.storeId) {
    throw new AuthorizationError("他店舗のデータにはアクセスできません");
  }
}

/**
 * 「自分と同格以上のユーザーを操作していないか」を検証する。
 *
 * 実装レビューで、同じ趣旨のチェックが3箇所に手書きされていて
 * `revokeSessions` だけ抜けており、MANAGER が同店舗の ADMIN を
 * 強制ログアウトし続けて締め出せる、という欠陥が見つかった。
 * ガード漏れが再発しないよう1箇所に集約する。
 */
export function assertCanManageUser(
  actor: SessionUser,
  target: { id: string; role: Role },
): void {
  if (actor.id === target.id) return; // 自分自身への操作は各呼び出し側で判断する
  if (ROLE_RANK[target.role] >= ROLE_RANK[actor.role]) {
    throw new AuthorizationError("自分と同じかそれ以上の権限を持つユーザーは操作できません");
  }
}

/** Server Action の戻り値。例外を UI に出せる形へ正規化する */
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type ActionContext = { user: SessionUser };

/**
 * Server Action を定義するための唯一の入口。
 *
 * - 必ず認証・ロール検証を通す（書き忘れによるフェイルオープンを構造的に防ぐ）
 * - 例外を ActionResult に正規化し、内部エラー詳細を UI に漏らさない
 *
 * 使い方:
 *   export const updateCast = defineAction("MANAGER", async (ctx, input: Input) => { ... })
 */
export function defineAction<TInput, TOutput>(
  minimumRole: Role,
  handler: (ctx: ActionContext, input: TInput) => Promise<TOutput>,
): (input: TInput) => Promise<ActionResult<TOutput>> {
  return async (input: TInput): Promise<ActionResult<TOutput>> => {
    try {
      assertSameOriginRequest();
      const user = await requireRole(minimumRole);
      const data = await handler({ user }, input);
      return { ok: true, data };
    } catch (error) {
      // 想定内の拒否（未認証・権限不足・入力不備）以外は障害として記録する。
      // ここを残さないと、利用者には汎用メッセージしか出ないため原因が追えない。
      if (
        !(error instanceof AuthenticationError) &&
        !(error instanceof AuthorizationError) &&
        !(error instanceof ValidationError)
      ) {
        logger.error("action.failed", error, { minimumRole });
      }
      return { ok: false, error: toUserMessage(error) };
    }
  };
}

/**
 * Server Action の CSRF 二次防御。
 *
 * middleware でも Origin を照合しているが、フレームワーク側の
 * middleware バイパス系の不具合に備えて Action 内でも検査する
 * （認可を一箇所に依存させない）。
 */
export function assertSameOriginRequest(): void {
  const h = headers();
  const origin = h.get("origin");
  const host = h.get("host");

  // Origin が付かない環境向けのフォールバック
  if (!origin && h.get("sec-fetch-site") === "same-origin") return;

  if (!isSameOrigin(origin, host, process.env.APP_URL ?? null)) {
    throw new AuthorizationError("不正なリクエスト元です");
  }
}

/** 例外を利用者向けメッセージへ変換する（内部情報を漏らさない） */
export function toUserMessage(error: unknown): string {
  if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
    return error.message;
  }
  if (error instanceof ValidationError) {
    return error.message;
  }
  if (process.env.NODE_ENV !== "production") {
    return error instanceof Error ? error.message : String(error);
  }
  return "処理中にエラーが発生しました。時間をおいて再度お試しください。";
}

/** 入力値の不備（利用者にそのまま見せてよいメッセージ） */
export class ValidationError extends Error {
  readonly fieldErrors?: Record<string, string[]>;

  constructor(message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = "ValidationError";
    this.fieldErrors = fieldErrors;
  }
}
