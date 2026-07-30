import "server-only";

import { complete, draftModel } from "@/lib/draft/anthropic";
import { checkDraftLimits } from "@/lib/draft/limits";
import { collectNgWords, findNgWords } from "@/lib/draft/ng-check";
import {
  buildSystemPrompt,
  buildUserPrompt,
  DEFAULT_LENGTH,
  findTheme,
  parseDrafts,
} from "@/lib/draft/prompt";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * 文面（下書き）生成のオーケストレーション。
 *
 * 手順:
 *   1. キャストと店舗を取り、機能が有効かを確認する
 *   2. 実行制限（連打・月間上限）を判定する
 *   3. 同じ店舗の直近の文面を集める（似た文面の反復を避けるため）
 *   4. 生成する
 *   5. **生成結果を NG 語で検査する**（指示だけでは混ざることがある）
 *   6. 実行ログを残す（利用状況・費用の把握と、次回の重複回避に使う）
 *
 * ここで更新実績（BlogPost）は作らない。
 * 下書きを作っただけで実績になると、実績の水増しになるため。
 */

/** 重複回避のために参照する、同じ店舗の直近の文面の件数 */
const RECENT_DRAFT_SAMPLE = 6;

export type GenerateResult =
  | { ok: true; drafts: string[]; warnings: string[] }
  | {
      ok: false;
      error: string;
      /** 画面側で「時間をおいて再試行」を促すか */
      retryable: boolean;
    };

export async function generateDrafts(params: {
  castId: string;
  themeKey: string;
  keywords: string;
  targetLength?: number;
}): Promise<GenerateResult> {
  const cast = await prisma.cast.findUnique({
    where: { id: params.castId },
    include: { store: true, writingProfile: true },
  });

  if (!cast || cast.status !== "ACTIVE") {
    return { ok: false, error: "ご利用いただけません。お店にご確認ください。", retryable: false };
  }
  if (!cast.store.draftEnabled) {
    return { ok: false, error: "この機能は現在お店の設定でオフになっています。", retryable: false };
  }

  const verdict = await checkDraftLimits({
    castId: cast.id,
    storeId: cast.storeId,
    monthlyLimit: cast.store.draftMonthlyLimit,
  });

  if (!verdict.allowed) {
    await recordSkipped(cast.id, cast.storeId, params, verdict.reason);
    if (verdict.reason === "burst") {
      return {
        ok: false,
        error: `続けて実行しすぎです。${verdict.retryAfterSeconds}秒ほどおいてからお試しください。`,
        retryable: true,
      };
    }
    return {
      ok: false,
      error: "今月の作成回数の上限に達しました。お店にご相談ください。",
      retryable: false,
    };
  }

  const ngWords = collectNgWords({
    storeNgWords: cast.store.draftNgWords,
    castNgWords: cast.writingProfile?.ngWords ?? "",
  });

  const recentDrafts = await collectRecentDrafts(cast.storeId);

  const system = buildSystemPrompt();
  const user = buildUserPrompt({
    castName: cast.name,
    storeName: cast.store.name,
    profile: {
      firstPerson: cast.writingProfile?.firstPerson ?? "",
      toneNote: cast.writingProfile?.toneNote ?? "",
      topics: cast.writingProfile?.topics ?? "",
      emojiLevel: cast.writingProfile?.emojiLevel ?? 1,
    },
    guideline: cast.store.draftGuideline,
    ngWords,
    keywords: params.keywords,
    themeKey: params.themeKey,
    recentDrafts,
    targetLength: params.targetLength ?? DEFAULT_LENGTH,
  });

  let completion;
  try {
    completion = await complete({ system, user });
  } catch (error) {
    logger.error("draft.generate_failed", error, { castId: cast.id });
    await prisma.draftGeneration.create({
      data: {
        castId: cast.id,
        storeId: cast.storeId,
        theme: findTheme(params.themeKey).label,
        keywords: params.keywords.slice(0, 500),
        drafts: [],
        model: draftModel(),
        result: "FAILED",
        errorDetail: error instanceof Error ? error.message.slice(0, 300) : "unknown error",
      },
    });
    return {
      ok: false,
      error: "文面をつくれませんでした。少し時間をおいてもう一度お試しください。",
      retryable: true,
    };
  }

  const drafts = parseDrafts(completion.text);
  if (drafts.length === 0) {
    return {
      ok: false,
      error: "文面をつくれませんでした。キーワードを変えてもう一度お試しください。",
      retryable: true,
    };
  }

  // --- NG 検査 ---
  // 1案でも NG を含むなら、その案だけを落とす。
  // 全部落ちた場合だけ失敗として扱う（使える案があるなら見せた方がよい）。
  const warnings: string[] = [];
  const clean: string[] = [];
  const blocked: string[] = [];
  for (const draft of drafts) {
    const hits = findNgWords(draft, ngWords);
    if (hits.length === 0) clean.push(draft);
    else blocked.push(hits.join("・"));
  }

  if (blocked.length > 0) {
    warnings.push(
      `${blocked.length}件の案に使えない表現（${[...new Set(blocked)].join("、")}）が含まれていたため除きました。`,
    );
  }

  await prisma.draftGeneration.create({
    data: {
      castId: cast.id,
      storeId: cast.storeId,
      theme: findTheme(params.themeKey).label,
      keywords: params.keywords.slice(0, 500),
      drafts: clean,
      model: completion.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      result: clean.length === 0 ? "BLOCKED_NG" : "OK",
      errorDetail: blocked.length > 0 ? `NG: ${[...new Set(blocked)].join(",")}`.slice(0, 300) : null,
    },
  });

  if (clean.length === 0) {
    return {
      ok: false,
      error: "使えない表現が含まれていたため表示できません。キーワードを変えてお試しください。",
      retryable: true,
    };
  }

  return { ok: true, drafts: clean, warnings };
}

/** 同じ店舗の直近の文面（書き出しの重複を避けるための参考） */
async function collectRecentDrafts(storeId: string): Promise<string[]> {
  const rows = await prisma.draftGeneration.findMany({
    where: { storeId, result: "OK" },
    orderBy: { createdAt: "desc" },
    take: RECENT_DRAFT_SAMPLE,
    select: { drafts: true },
  });

  const out: string[] = [];
  for (const row of rows) {
    const drafts = Array.isArray(row.drafts) ? row.drafts : [];
    for (const d of drafts) {
      if (typeof d === "string" && d.trim()) out.push(d.trim());
    }
  }
  return out.slice(0, RECENT_DRAFT_SAMPLE);
}

async function recordSkipped(
  castId: string,
  storeId: string,
  params: { themeKey: string; keywords: string },
  reason: string,
): Promise<void> {
  await prisma.draftGeneration.create({
    data: {
      castId,
      storeId,
      theme: findTheme(params.themeKey).label,
      keywords: params.keywords.slice(0, 500),
      drafts: [],
      model: draftModel(),
      result: "SKIPPED_LIMIT",
      errorDetail: reason,
    },
  });
}
