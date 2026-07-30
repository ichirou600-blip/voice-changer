import { describe, expect, it } from "vitest";

import { ALWAYS_NG_WORDS, collectNgWords, findNgWords, normalizeForMatch, parseNgWords } from "./ng-check";

/**
 * NG 表現チェックの検証。
 *
 * ここが素通りすると、店舗が想定していない文言がそのまま外部サイトに載る。
 * とくに**表記ゆれで逃げられないこと**を重点的に確かめる。
 */

describe("正規化", () => {
  it("全角英数を半角にする", () => {
    expect(normalizeForMatch("ＬＩＮＥ")).toBe("line");
  });

  it("カタカナをひらがなにする", () => {
    expect(normalizeForMatch("アフター")).toBe("あふたー");
  });

  it("空白と記号を落とす", () => {
    expect(normalizeForMatch("L I N E - I D")).toBe("lineid");
  });
});

describe("NG 語の検出", () => {
  it("そのままの表記を見つける", () => {
    expect(findNgWords("うちの指名料は…", ["指名料"])).toEqual(["指名料"]);
  });

  it("カタカナ・ひらがなの違いで逃げられない", () => {
    expect(findNgWords("あふたー行こう", ["アフター"])).toEqual(["アフター"]);
  });

  it("全角と半角の違いで逃げられない", () => {
    expect(findNgWords("ＬＩＮＥ　ＩＤは…", ["LINE ID"])).toEqual(["LINE ID"]);
  });

  it("記号を挟んでも逃げられない", () => {
    expect(findNgWords("L-I-N-E-I-D 教えます", ["LINEID"])).toEqual(["LINEID"]);
  });

  it("含まれなければ空", () => {
    expect(findNgWords("今日はいい天気でした", ["指名料"])).toEqual([]);
  });

  it("複数見つかればすべて返す", () => {
    expect(findNgWords("指名料とアフターの話", ["指名料", "アフター"])).toHaveLength(2);
  });

  it("返すのは設定どおりの表記（画面表示のため）", () => {
    expect(findNgWords("あふたー", ["アフター"])[0]).toBe("アフター");
  });
});

describe("設定文字列の解析", () => {
  it("改行・カンマ・読点のいずれでも区切れる", () => {
    expect(parseNgWords("A\nB,C、D")).toEqual(["A", "B", "C", "D"]);
  });

  it("空行を無視する", () => {
    expect(parseNgWords("A\n\n  \nB")).toEqual(["A", "B"]);
  });
});

describe("NG 語の統合", () => {
  it("店舗が設定を空にしても、常時 NG は必ず効く", () => {
    const words = collectNgWords({ storeNgWords: "", castNgWords: "" });
    for (const always of ALWAYS_NG_WORDS) {
      expect(words).toContain(always);
    }
  });

  it("店舗とキャストの設定を両方含む", () => {
    const words = collectNgWords({ storeNgWords: "他店の名前", castNgWords: "本名" });
    expect(words).toContain("他店の名前");
    expect(words).toContain("本名");
  });

  it("表記ゆれの重複を1つにまとめる", () => {
    const words = collectNgWords({ storeNgWords: "ラインID", castNgWords: "ラインid" });
    const normalized = words.map(normalizeForMatch);
    expect(new Set(normalized).size).toBe(normalized.length);
  });

  it("常時 NG に電話番号の頭3桁が入っている", () => {
    const words = collectNgWords({ storeNgWords: "", castNgWords: "" });
    expect(findNgWords("090-1234-5678 に連絡して", words)).not.toHaveLength(0);
  });
});
