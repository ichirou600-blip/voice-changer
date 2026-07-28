/**
 * CSV 生成。
 *
 * Excel で開くことを前提に:
 * - BOM 付き UTF-8（付けないと日本語が文字化けする）
 * - 改行コードは CRLF
 * - 数式インジェクション対策として、= + - @ で始まる値の先頭にシングルクォートを付ける
 *   （表計算ソフトで開いた瞬間に数式として実行されるのを防ぐ）
 */

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (FORMULA_PREFIX.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const lines = [headers.map(escapeCsvValue).join(",")];
  for (const row of rows) lines.push(row.map(escapeCsvValue).join(","));
  // BOM + CRLF
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** Content-Disposition 用にファイル名を安全にエンコードする */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
