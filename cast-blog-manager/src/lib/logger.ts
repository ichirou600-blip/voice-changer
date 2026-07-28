/**
 * 構造化ログ。
 *
 * 商用サポートを提供する以上、障害時に「何が起きたか」を追える必要がある。
 * Vercel のログはJSON行を構造化して取り込むため、1行1JSONで出力する。
 *
 * 方針:
 * - 個人情報（メールアドレス・LINE userId・氏名）は**そのまま出さない**。
 *   識別が必要な場合は `maskId()` で先頭数文字だけ残す。
 * - エラーはスタックトレースまで残す（本番の利用者には出さないが、ログには必要）。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function minLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL as LogLevel | undefined;
  if (raw && raw in LEVEL_ORDER) return raw;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function serializeError(error: unknown): LogContext {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack?.split("\n").slice(0, 8).join("\n"),
    };
  }
  return { errorMessage: String(error) };
}

function emit(level: LogLevel, event: string, context: LogContext = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel()]) return;

  const line = JSON.stringify({
    level,
    event,
    time: new Date().toISOString(),
    ...context,
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, context?: LogContext) => emit("debug", event, context),
  info: (event: string, context?: LogContext) => emit("info", event, context),
  warn: (event: string, context?: LogContext) => emit("warn", event, context),
  error: (event: string, error?: unknown, context?: LogContext) =>
    emit("error", event, { ...context, ...(error !== undefined ? serializeError(error) : {}) }),
};

/**
 * ID を部分的にマスクする（ログから個人を特定できないようにしつつ、
 * 同一ユーザーの一連の動きは追えるようにする）。
 */
export function maskId(id: string | null | undefined): string {
  if (!id) return "-";
  if (id.length <= 6) return "***";
  return `${id.slice(0, 6)}***`;
}
