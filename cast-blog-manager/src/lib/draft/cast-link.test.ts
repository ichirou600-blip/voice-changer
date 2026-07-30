import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CAST_LINK_TTL_MS,
  castDraftUrl,
  isDraftFeatureConfigured,
  issueCastToken,
  verifyCastToken,
} from "./cast-link";

/**
 * キャスト用トークンの検証。
 *
 * このトークンだけが「本人であること」の根拠なので、
 * 偽造・使い回し・期限の無効化ができないことを確かめる。
 */

const SECRET = "a".repeat(64);
const OTHER_SECRET = "b".repeat(64);

beforeEach(() => {
  process.env.CAST_LINK_SECRET = SECRET;
  process.env.APP_URL = "https://example.test";
});

afterEach(() => {
  delete process.env.CAST_LINK_SECRET;
  delete process.env.APP_URL;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("発行と検証", () => {
  it("発行したトークンは検証を通り、castId が取り出せる", () => {
    const token = issueCastToken("cast-1");
    const verdict = verifyCastToken(token);
    expect(verdict).toEqual({ ok: true, castId: "cast-1" });
  });

  it("形式が違うトークンは弾く", () => {
    expect(verifyCastToken("not-a-token")).toEqual({ ok: false, reason: "malformed" });
    expect(verifyCastToken("a.b")).toEqual({ ok: false, reason: "malformed" });
  });

  it("署名を書き換えたトークンは弾く", () => {
    const token = issueCastToken("cast-1");
    const tampered = `${token.slice(0, -1)}${token.at(-1) === "A" ? "B" : "A"}`;
    expect(verifyCastToken(tampered).ok).toBe(false);
  });

  it("castId を差し替えると署名が合わなくなる（他人になりすませない）", () => {
    const token = issueCastToken("cast-1");
    const [, exp, sig] = token.split(".");
    expect(verifyCastToken(`cast-2.${exp}.${sig}`)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("有効期限だけを延ばしても署名が合わない", () => {
    const token = issueCastToken("cast-1");
    const [castId, exp, sig] = token.split(".");
    const extended = String(Number(exp) + 10 * 60 * 1000);
    expect(verifyCastToken(`${castId}.${extended}.${sig}`)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("鍵が違えば検証を通らない（環境をまたいだ使い回しができない）", () => {
    const token = issueCastToken("cast-1");
    process.env.CAST_LINK_SECRET = OTHER_SECRET;
    expect(verifyCastToken(token).ok).toBe(false);
  });
});

describe("有効期限", () => {
  const base = new Date("2026-07-30T10:00:00Z");

  it("期限内は有効", () => {
    const token = issueCastToken("cast-1", base);
    const justBefore = new Date(base.getTime() + CAST_LINK_TTL_MS - 1000);
    expect(verifyCastToken(token, justBefore).ok).toBe(true);
  });

  it("期限を過ぎたら expired として弾く", () => {
    const token = issueCastToken("cast-1", base);
    const after = new Date(base.getTime() + CAST_LINK_TTL_MS + 1000);
    expect(verifyCastToken(token, after)).toEqual({ ok: false, reason: "expired" });
  });

  it("ちょうど期限の瞬間は無効（境界を有効側に倒さない）", () => {
    const token = issueCastToken("cast-1", base);
    const exact = new Date(base.getTime() + CAST_LINK_TTL_MS);
    expect(verifyCastToken(token, exact)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("鍵の設定", () => {
  it("鍵が未設定なら発行時に落とす（無署名のリンクを出さない）", () => {
    delete process.env.CAST_LINK_SECRET;
    expect(() => issueCastToken("cast-1")).toThrow(/CAST_LINK_SECRET/);
  });

  it("鍵が短すぎる場合も拒否する", () => {
    process.env.CAST_LINK_SECRET = "short";
    expect(() => issueCastToken("cast-1")).toThrow(/CAST_LINK_SECRET/);
  });
});

describe("URL の組み立て", () => {
  it("APP_URL を基点にした絶対 URL を返す", () => {
    expect(castDraftUrl("cast-1")).toMatch(/^https:\/\/example\.test\/c\/cast-1\.\d+\./);
  });

  it("APP_URL の末尾スラッシュで二重スラッシュにならない", () => {
    process.env.APP_URL = "https://example.test/";
    expect(castDraftUrl("cast-1")).not.toContain("//c/");
  });

  it("APP_URL が無ければ落とす", () => {
    delete process.env.APP_URL;
    expect(() => castDraftUrl("cast-1")).toThrow(/APP_URL/);
  });
});

describe("機能の設定判定", () => {
  it("API キーが無ければ未設定と判定する（LINE に無効なリンクを出さない）", () => {
    expect(isDraftFeatureConfigured()).toBe(false);
  });

  it("3つ揃えば設定済み", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect(isDraftFeatureConfigured()).toBe(true);
  });
});
