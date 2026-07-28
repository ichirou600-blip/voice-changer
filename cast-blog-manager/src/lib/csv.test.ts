import { describe, expect, it } from "vitest";

import { contentDisposition, escapeCsvValue, toCsv } from "./csv";

describe("CSV エスケープ", () => {
  it("カンマ・改行・引用符を含む値を引用する", () => {
    expect(escapeCsvValue("a,b")).toBe('"a,b"');
    expect(escapeCsvValue("a\nb")).toBe('"a\nb"');
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
  });

  it("空値は空文字", () => {
    expect(escapeCsvValue(null)).toBe("");
    expect(escapeCsvValue(undefined)).toBe("");
  });

  it("数式インジェクションを無害化する", () => {
    // Excel で開いた瞬間に実行されるのを防ぐ
    expect(escapeCsvValue("=1+1")).toBe("'=1+1");
    // シングルクォートは引用のトリガーではないので、先頭の ' 付与のみ
    expect(escapeCsvValue("+cmd|'/c calc'")).toBe("'+cmd|'/c calc'");
    // カンマを含む場合は引用も併用される
    expect(escapeCsvValue("=cmd,1")).toBe(`"'=cmd,1"`);
    expect(escapeCsvValue("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(escapeCsvValue("-2+3")).toBe("'-2+3");
  });

  it("通常の日本語はそのまま", () => {
    expect(escapeCsvValue("あやか")).toBe("あやか");
  });
});

describe("toCsv", () => {
  it("BOM 付き・CRLF 区切りで出力する（Excel対応）", () => {
    const csv = toCsv(["営業日", "キャスト"], [["2026-07-28", "あやか"]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("\r\n");
    expect(csv).toBe("﻿営業日,キャスト\r\n2026-07-28,あやか\r\n");
  });

  it("行が無くてもヘッダは出る", () => {
    expect(toCsv(["a", "b"], [])).toBe("﻿a,b\r\n");
  });
});

describe("contentDisposition", () => {
  it("日本語ファイル名を RFC 5987 形式で付与する", () => {
    const value = contentDisposition("更新記録.csv");
    expect(value).toContain("filename*=UTF-8''");
    expect(value).toContain(encodeURIComponent("更新記録.csv"));
    // ASCII フォールバックにマルチバイトが混ざらない
    const ascii = value.match(/filename="([^"]*)"/)?.[1] ?? "";
    expect(/^[\x20-\x7e]*$/.test(ascii)).toBe(true);
  });

  it("引用符やバックスラッシュを無害化する", () => {
    const value = contentDisposition('a"b\\c.csv');
    const ascii = value.match(/filename="([^"]*)"/)?.[1] ?? "";
    expect(ascii).not.toContain('"');
    expect(ascii).not.toContain("\\");
  });
});
