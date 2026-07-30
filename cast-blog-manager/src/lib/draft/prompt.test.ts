import { describe, expect, it } from "vitest";

import {
  buildSystemPrompt,
  buildUserPrompt,
  DRAFT_COUNT,
  DRAFT_THEMES,
  findTheme,
  parseDrafts,
  type PromptInput,
} from "./prompt";

/**
 * 生成の指示文の検証。
 *
 * 「指示に入っているつもりで入っていない」のが最も気づきにくい欠陥なので、
 * 品質と安全に直結する項目が**文字列として実際に含まれるか**を確かめる。
 */

const base: PromptInput = {
  castName: "あやか",
  storeName: "ラウンジ ルミエール",
  profile: { firstPerson: "わたし", toneNote: "「〜だよ」をよく使う", topics: "猫", emojiLevel: 1 },
  guideline: "",
  ngWords: [],
  keywords: "",
  themeKey: "free",
  recentDrafts: [],
  targetLength: 200,
};

describe("システムプロンプト", () => {
  const system = buildSystemPrompt();

  it("投稿の代行をしないことを明示する", () => {
    // 「自動投稿はしない」は製品の根幹の方針。指示からも落とさない
    expect(system).toContain("投稿の代行はしません");
  });

  it("事実を作らせない指示を含む", () => {
    expect(system).toContain("事実を作らない");
  });

  it("連絡先・料金・他店比較を禁じる", () => {
    expect(system).toContain("連絡先");
    expect(system).toContain("料金");
    expect(system).toContain("他店との比較");
  });
});

describe("ユーザープロンプト", () => {
  it("一人称と話し方を必ず含める（文体が全員同じになるのを防ぐ）", () => {
    const prompt = buildUserPrompt(base);
    expect(prompt).toContain("「わたし」");
    expect(prompt).toContain("「〜だよ」をよく使う");
  });

  it("キーワード未入力でも成立する", () => {
    const prompt = buildUserPrompt({ ...base, keywords: "   " });
    expect(prompt).toContain("（入力なし。テーマだけで書く）");
  });

  it("NG 語をリストとして渡す", () => {
    const prompt = buildUserPrompt({ ...base, ngWords: ["他店の名前", "アフター"] });
    expect(prompt).toContain("# 書いてはいけない表現");
    expect(prompt).toContain("- 他店の名前");
    expect(prompt).toContain("- アフター");
  });

  it("NG 語が無いときは該当の見出しごと出さない（無駄なトークンを使わない）", () => {
    expect(buildUserPrompt(base)).not.toContain("# 書いてはいけない表現");
  });

  it("直近の文面を渡して重複を避けさせる", () => {
    const prompt = buildUserPrompt({ ...base, recentDrafts: ["今日はいい天気でした"] });
    expect(prompt).toContain("すでに使われている文面");
    expect(prompt).toContain("今日はいい天気でした");
  });

  it("直近の文面は先頭だけを渡す（入力トークンがそのまま費用になるため）", () => {
    const long = "あ".repeat(500);
    const prompt = buildUserPrompt({ ...base, recentDrafts: [long] });
    expect(prompt).toContain("あ".repeat(60));
    expect(prompt).not.toContain("あ".repeat(61));
  });

  it("絵文字の量が設定に応じて変わる", () => {
    const none = buildUserPrompt({ ...base, profile: { ...base.profile, emojiLevel: 0 } });
    const many = buildUserPrompt({ ...base, profile: { ...base.profile, emojiLevel: 2 } });
    expect(none).toContain("絵文字と顔文字は使わない");
    expect(many).toContain("にぎやかな印象");
  });

  it("店舗の方針を含める", () => {
    const prompt = buildUserPrompt({ ...base, guideline: "敬語は使わない" });
    expect(prompt).toContain("# お店からの方針");
    expect(prompt).toContain("敬語は使わない");
  });

  it("案の数と長さを指定する", () => {
    const prompt = buildUserPrompt({ ...base, targetLength: 300 });
    expect(prompt).toContain(`${DRAFT_COUNT}案`);
    expect(prompt).toContain("300 文字前後");
  });
});

describe("テーマ", () => {
  it("全テーマにヒントがある", () => {
    for (const theme of DRAFT_THEMES) {
      expect(theme.hint.length).toBeGreaterThan(0);
    }
  });

  it("未知のキーは「おまかせ」に落ちる（不正な入力で落ちない）", () => {
    expect(findTheme("no-such-theme").key).toBe("free");
  });
});

describe("応答の分解", () => {
  it("--- 区切りで分解する", () => {
    expect(parseDrafts("案A\n---\n案B\n---\n案C")).toEqual(["案A", "案B", "案C"]);
  });

  it("区切りが守られなかった場合は空行で分解する", () => {
    expect(parseDrafts("案A\n\n案B\n\n案C")).toEqual(["案A", "案B", "案C"]);
  });

  it("指示に反して付いた見出しを落とす", () => {
    expect(parseDrafts("案1: こんばんは\n---\n2. おはよう\n---\n【案3】ただいま")).toEqual([
      "こんばんは",
      "おはよう",
      "ただいま",
    ]);
  });

  it("指定数を超えても切り詰める（画面と費用の想定を守る）", () => {
    expect(parseDrafts("a\n---\nb\n---\nc\n---\nd")).toHaveLength(DRAFT_COUNT);
  });

  it("空の応答は空配列", () => {
    expect(parseDrafts("   ")).toEqual([]);
  });
});
