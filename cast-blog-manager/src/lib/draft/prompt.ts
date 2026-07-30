/**
 * 文面生成の指示文（プロンプト）を組み立てる純粋関数。
 *
 * DB にも API にも触らないので、単体テストで「何が指示に含まれるか」を
 * 直接検証できる。文言を変えるときは必ずここを見る。
 *
 * 設計上、外してはいけない点:
 * - **キャストごとに文体が散ること**。同じ店舗の全員が似た文面になると、
 *   外部サイトで横並びに表示されたときに逆効果になる。
 *   → 個人プロフィールと、同じ店舗の直近の文面を指示に含めて「避けさせる」。
 * - **事実を作らせないこと**。本人が入れたキーワードを起点にする。
 * - **投稿はしないこと**。ここで作るのはあくまで下書き。
 */

export type DraftTheme = {
  key: string;
  label: string;
  /** 生成時の補足指示 */
  hint: string;
};

/** キャストが選べるテーマ。数を絞って選択の負担を下げる */
export const DRAFT_THEMES: DraftTheme[] = [
  { key: "today", label: "今日のできごと", hint: "その日にあった小さな出来事を1つだけ取り上げる" },
  { key: "thanks", label: "お礼", hint: "来店してくれた方への感謝を、特定の個人が分からない形で書く" },
  { key: "schedule", label: "出勤のお知らせ", hint: "次の出勤を知らせる。日付は本人の入力にある場合だけ書く" },
  { key: "favorite", label: "最近ハマっているもの", hint: "趣味や好きなものについて具体的に書く" },
  { key: "season", label: "季節の話題", hint: "季節や天気の話から入り、自然に来店の誘いへつなげる" },
  { key: "free", label: "おまかせ", hint: "キーワードから自然な話題を選ぶ" },
];

export function findTheme(key: string): DraftTheme {
  return DRAFT_THEMES.find((t) => t.key === key) ?? DRAFT_THEMES[DRAFT_THEMES.length - 1];
}

export type WritingProfile = {
  firstPerson: string;
  toneNote: string;
  topics: string;
  emojiLevel: number;
};

export type PromptInput = {
  castName: string;
  storeName: string;
  profile: WritingProfile;
  /** 店舗としての文面方針 */
  guideline: string;
  /** 書かせない表現 */
  ngWords: string[];
  /** キャスト本人が入力したキーワード */
  keywords: string;
  themeKey: string;
  /** 同じ店舗の直近の文面（重複回避のために見せる） */
  recentDrafts: string[];
  /** 1案あたりのおおよその文字数 */
  targetLength: number;
};

/** 生成する案の数 */
export const DRAFT_COUNT = 3;

/** 1案あたりの目安文字数（選択肢） */
export const LENGTH_OPTIONS = [120, 200, 300] as const;
export const DEFAULT_LENGTH = 200;

function emojiInstruction(level: number): string {
  if (level <= 0) return "絵文字と顔文字は使わない。";
  if (level >= 2) return "絵文字を1文につき1〜2個ほど使い、にぎやかな印象にする。";
  return "絵文字は全体で2〜4個にとどめる。";
}

/**
 * システムプロンプト（役割と禁止事項）。
 * 店舗・キャストによらず共通のため、切り出してキャッシュしやすくしている。
 */
export function buildSystemPrompt(): string {
  return [
    "あなたは、ナイトラウンジで働くキャスト本人が自分のブログに投稿する文章の下書きを手伝うアシスタントです。",
    "",
    "守ること:",
    "- 出力は日本語のブログ本文のみ。挨拶や説明、前置き、番号、記号による装飾は付けない。",
    "- 事実を作らない。与えられたキーワードとテーマの範囲で書き、具体的な日付・金額・人名・店名は入力にある場合だけ使う。",
    "- 実在の来店客が特定できる書き方をしない。",
    "- 連絡先、料金、他店との比較、他SNSへの誘導、年齢や法令に触れる表現は書かない。",
    "- 過度に性的な表現、身体的特徴を強調する表現は書かない。",
    "- 一人称と語尾は指定されたものを必ず守る。",
    "",
    "この下書きは本人が読んで手直ししたうえで自分で投稿します。投稿の代行はしません。",
  ].join("\n");
}

/**
 * ユーザープロンプト（この1回の生成に固有の情報）。
 */
export function buildUserPrompt(input: PromptInput): string {
  const theme = findTheme(input.themeKey);
  const profile = input.profile;
  const lines: string[] = [];

  lines.push(`次の条件で、ブログ記事の下書きを${DRAFT_COUNT}案つくってください。`);
  lines.push("");
  lines.push("# 書く人");
  lines.push(`- 名前: ${input.castName}`);
  lines.push(`- お店: ${input.storeName}`);
  if (profile.firstPerson) lines.push(`- 一人称: 必ず「${profile.firstPerson}」を使う`);
  if (profile.toneNote) lines.push(`- 話し方の特徴: ${profile.toneNote}`);
  if (profile.topics) lines.push(`- よく書く話題: ${profile.topics}`);
  lines.push(`- 絵文字: ${emojiInstruction(profile.emojiLevel)}`);

  lines.push("");
  lines.push("# テーマ");
  lines.push(`- ${theme.label}（${theme.hint}）`);

  lines.push("");
  lines.push("# 本人が入力した内容");
  lines.push(input.keywords.trim() ? input.keywords.trim() : "（入力なし。テーマだけで書く）");

  lines.push("");
  lines.push("# 長さ");
  lines.push(`- 1案あたり ${input.targetLength} 文字前後（±20%）`);

  if (input.guideline.trim()) {
    lines.push("");
    lines.push("# お店からの方針");
    lines.push(input.guideline.trim());
  }

  if (input.ngWords.length > 0) {
    lines.push("");
    lines.push("# 書いてはいけない表現");
    lines.push(input.ngWords.map((w) => `- ${w}`).join("\n"));
  }

  if (input.recentDrafts.length > 0) {
    lines.push("");
    lines.push("# すでに使われている文面（同じ言い回し・同じ書き出しを避ける）");
    // 長い文面をそのまま入れると入力トークンが膨らむので冒頭だけ見せる
    lines.push(input.recentDrafts.map((d) => `- ${d.slice(0, 60)}`).join("\n"));
  }

  lines.push("");
  lines.push("# 出力形式");
  lines.push(`- ${DRAFT_COUNT}案を、区切り行「---」だけで区切って並べる。`);
  lines.push("- 案の番号やタイトル、説明文は付けない。本文だけを書く。");
  lines.push("- 案ごとに書き出しと話の入り方を変える。");

  return lines.join("\n");
}

/**
 * モデルの応答を案の配列に分解する。
 *
 * 「---」で区切るよう指示しているが、守られない場合に備えて
 * 空行2つでの分割にも落とす（1案しか取れないより3案に近い方がよい）。
 */
export function parseDrafts(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];

  let parts = text
    .split(/^\s*-{3,}\s*$/m)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    parts = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  return parts
    .map((p) =>
      p
        // 「案1:」「1.」など、指示に反して付いた見出しを落とす
        .replace(/^(案\s*\d+\s*[:：.]?|【[^】]*】|\d+\s*[.)．]）?)\s*/u, "")
        .trim(),
    )
    .filter((p) => p.length > 0)
    .slice(0, DRAFT_COUNT);
}
