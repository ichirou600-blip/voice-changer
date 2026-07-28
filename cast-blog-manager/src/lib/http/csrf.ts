/**
 * CSRF 対策（Origin 照合）。
 *
 * 設計レビューでの指摘:
 * - SameSite=Lax だけでは「ログイン CSRF」や
 *   「GET で状態を変えるエンドポイント」を守れない
 * - middleware だけに置くとフレームワークのバイパス系 CVE で無力化されうる
 *   → middleware（一次防御）と Server Action / Route Handler 内（二次防御）の
 *     二段で照合する
 *
 * 規約: **GET で状態を変更するエンドポイントを作らない**こと。
 */

/** 状態を変更しうる HTTP メソッド */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * Origin ヘッダが自サイトのものかを判定する（純粋関数）。
 *
 * @param origin  Origin ヘッダ（無い場合は null）
 * @param host    Host ヘッダ
 * @param allowedOrigin  APP_URL などで明示された許可オリジン（任意）
 */
export function isSameOrigin(
  origin: string | null,
  host: string | null,
  allowedOrigin?: string | null,
): boolean {
  // Origin が無いリクエスト（一部の同一オリジン GET やネイティブクライアント）は
  // ここでは判定できない。呼び出し側で「変更系のみ検査する」ことで担保する。
  if (!origin) return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  if (allowedOrigin) {
    try {
      if (originHost === new URL(allowedOrigin).host) return true;
    } catch {
      // APP_URL が不正な場合は host 比較にフォールバック
    }
  }

  return Boolean(host) && originHost === host;
}

/**
 * Sec-Fetch-Site による補助判定。
 * `same-origin` / `none`（アドレスバー直接入力）は安全とみなす。
 */
export function isSafeFetchSite(secFetchSite: string | null): boolean {
  return secFetchSite === "same-origin" || secFetchSite === "none";
}

/**
 * 変更系リクエストとして許可してよいかの総合判定。
 */
export function isAllowedMutation(params: {
  method: string;
  origin: string | null;
  host: string | null;
  secFetchSite: string | null;
  allowedOrigin?: string | null;
}): boolean {
  if (!isMutatingMethod(params.method)) return true;
  if (isSameOrigin(params.origin, params.host, params.allowedOrigin)) return true;
  // Origin ヘッダを送らない環境向けのフォールバック
  if (!params.origin && isSafeFetchSite(params.secFetchSite)) return true;
  return false;
}
