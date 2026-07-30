/**
 * 生成された文面の NG 表現チェック（純粋関数・DB アクセスなし）。
 *
 * 生成の指示に「書かないでください」と入れるだけでは不十分で、
 * 実際に混ざることがある。**生成後に必ず機械的に検査する**。
 *
 * 検査は表記ゆれを吸収したうえで行う。
 * 「LINE」「ライン」「らいん」を別物として扱うと、素通りしてしまうため。
 */

/** 検査用の正規化: 全角英数→半角、カタカナ→ひらがな、小文字化、記号と空白を除去 */
export function normalizeForMatch(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　!-/:-@[-`{-~、。・「」（）！？]/g, "");
}

/** 設定文字列（改行・読点区切り）を語のリストにする */
export function parseNgWords(raw: string): string[] {
  return raw
    .split(/[\n,、]/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .slice(0, 200);
}

/**
 * 文面に含まれる NG 語を返す（見つからなければ空配列）。
 *
 * 返すのは**元の設定語**であって正規化後の文字列ではない。
 * 画面には設定どおりの表記で見せたいため。
 */
export function findNgWords(text: string, ngWords: string[]): string[] {
  const haystack = normalizeForMatch(text);
  const hits: string[] = [];
  for (const word of ngWords) {
    const needle = normalizeForMatch(word);
    if (needle.length === 0) continue;
    if (haystack.includes(needle)) hits.push(word);
  }
  return hits;
}

/**
 * 常に禁止する表現。
 *
 * 店舗ごとの設定とは別に、業種として書かれると困るものを既定で持つ。
 * ここは「消していい設定」ではなく実装として固定する
 * （店舗が設定を空にしても効く）。
 */
export const ALWAYS_NG_WORDS = [
  // 連絡先の直接記載（個人が特定され、トラブルの入口になる）
  "LINE ID",
  "ラインID",
  "電話番号",
  "090",
  "080",
  "070",
  // 料金・システムへの言及（店舗の掲示と食い違うと苦情になる）
  "円ポッキリ",
  "指名料",
  "同伴料金",
  // 他店比較・誇大表現
  "他店より",
  "日本一",
  "業界最安",
  // 年齢・法令に関わる表現
  "未成年",
  "18歳未満",
];

/** 店舗設定・キャスト設定・常時 NG を1つのリストにまとめる */
export function collectNgWords(params: {
  storeNgWords: string;
  castNgWords: string;
}): string[] {
  const merged = [
    ...ALWAYS_NG_WORDS,
    ...parseNgWords(params.storeNgWords),
    ...parseNgWords(params.castNgWords),
  ];
  // 正規化して重複を除く（「LINE ID」と「ラインid」を二重に持たない）
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of merged) {
    const key = normalizeForMatch(word);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}
