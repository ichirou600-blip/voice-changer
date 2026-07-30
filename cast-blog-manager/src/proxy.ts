import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { isAllowedMutation } from "@/lib/http/csrf";

/**
 * リクエストの前段処理（Next.js 16 で `middleware` から `proxy` に名称変更された）。
 *
 * 役割は次の2つだけに限定する。
 *
 * 1. CSRF の一次防御（変更系リクエストの Origin 照合）
 * 2. セキュリティヘッダの付与
 *
 * **認可はここに置かない。**
 * この層は Edge Runtime で DB を参照できず、
 * 過去にヘッダ細工によるバイパスの CVE も存在するため、
 * 認可は必ず Server Component / Server Action / Route Handler 側
 * （`requireUser` / `defineAction`）で行う。後任者もここに寄せないこと。
 */

const CSP = [
  "default-src 'self'",
  // Next.js のインラインブートストラップのため script は 'unsafe-inline' を許容せざるを得ないが、
  // 外部スクリプトの読み込みは禁止する
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("Content-Security-Policy", CSP);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return res;
}

export default function proxy(request: NextRequest) {
  // --- CSRF 一次防御 ---
  // LINE Webhook は外部（LINE プラットフォーム）からの POST なので Origin 照合の対象外。
  // 代わりに署名検証（X-Line-Signature）で真正性を担保する。
  const isLineWebhook = request.nextUrl.pathname.startsWith("/api/line/webhook");
  // cron は Bearer トークンで認可するため対象外
  const isCron = request.nextUrl.pathname.startsWith("/api/cron/");

  if (!isLineWebhook && !isCron) {
    const allowed = isAllowedMutation({
      method: request.method,
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
      secFetchSite: request.headers.get("sec-fetch-site"),
      allowedOrigin: process.env.APP_URL ?? null,
    });
    if (!allowed) {
      return withSecurityHeaders(
        new NextResponse("Forbidden: cross-origin request rejected", { status: 403 }),
      );
    }
  }

  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  // 静的アセットは対象外
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
