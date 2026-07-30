import "server-only";

/**
 * Claude API（Messages API）の薄いクライアント。
 *
 * 公式 SDK を入れずに fetch で叩いている。理由:
 * - 依存を1つ増やすと、その脆弱性と破壊的変更を製品の寿命のあいだ追い続けることになる
 * - 使うのは「1リクエスト＝1応答」だけで、SDK の機能をほとんど使わない
 * - LINE クライアントと同じく、ベース URL を差し替えてモックサーバーで
 *   リクエストの形を検証できる（test/draft-api.test.ts）
 *
 * 呼び出しは課金に直結するため、必ず `generateDrafts`（制限判定込み）を通すこと。
 */

const API_BASE = process.env.ANTHROPIC_API_BASE ?? "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

/** 既定のモデル。費用と品質の釣り合いで Haiku を既定にする */
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/** 応答の上限トークン。3案 × 300文字程度を想定した余裕値 */
export const MAX_OUTPUT_TOKENS = 1500;

/** 応答を待つ上限。ここを超えたら画面側でやり直してもらう */
export const REQUEST_TIMEOUT_MS = 45 * 1000;

export class AnthropicApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`Anthropic API error ${status}: ${message}`);
    this.name = "AnthropicApiError";
    this.status = status;
  }
}

export function draftModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

function apiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY が設定されていません");
  return key;
}

export type CompletionResult = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

/**
 * 1回の生成を行う。
 *
 * `system` を独立したフィールドで渡すのは Messages API の仕様どおりであり、
 * 店舗・キャストによらず同じ内容になるため、将来キャッシュを効かせやすい。
 */
export async function complete(params: {
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
}): Promise<CompletionResult> {
  const model = draftModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey(),
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: params.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        // 毎回まったく同じ文面が返ると使い物にならないため、やや高めにする
        temperature: params.temperature ?? 1,
        system: params.system,
        messages: [{ role: "user", content: params.user }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AnthropicApiError(408, "応答がありませんでした（タイムアウト）");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AnthropicApiError(res.status, body.slice(0, 300));
  }

  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = (json.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();

  return {
    text,
    model: json.model ?? model,
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
  };
}
