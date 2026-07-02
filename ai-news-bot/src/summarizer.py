"""Claude API を使って重要記事を選定し、1ツイート分の投稿文を生成するモジュール。"""

from __future__ import annotations

from datetime import date

import anthropic

from .collector import Article
from .config import CLAUDE_MODEL, TOP_N, TWEET_MAX_LENGTH


def _build_prompt(articles: list[Article], target_day: date) -> str:
    """記事一覧から Claude 用のプロンプト本文を組み立てる。"""
    lines = "\n".join(f"{i + 1}. {a.to_prompt_line()}" for i, a in enumerate(articles))
    return f"""あなたは日本語で発信するAIニュースキュレーターです。

以下は {target_day.strftime("%Y年%m月%d日")} に公開されたAI関連ニュースの一覧です。
この中から特に重要度の高い記事を {TOP_N} 件選び、フォロワー向けにX（旧Twitter）へ投稿する
1ツイート分の日本語テキストを作成してください。

# 記事一覧
{lines}

# 出力ルール
- 全体で {TWEET_MAX_LENGTH} 文字以内（絵文字・改行・ハッシュタグを含む）。
- 冒頭に日付と「今日のAIニュース」のような見出しを付ける。
- 選んだ {TOP_N} 件を箇条書き（・）で簡潔にまとめる。各項目は要点のみ。
- 末尾に関連ハッシュタグを2〜3個付ける（例：#AI #人工知能）。
- URLは含めない（文字数節約のため）。
- 投稿するツイート本文だけを出力し、説明や前置きは一切書かないこと。
"""


def _extract_text(message: anthropic.types.Message) -> str:
    """Message からテキストブロックのみを連結して返す。"""
    parts = [block.text for block in message.content if block.type == "text"]
    return "".join(parts).strip()


def generate_tweet(
    client: anthropic.Anthropic, articles: list[Article], target_day: date
) -> str:
    """記事一覧を Claude に渡し、投稿用ツイート本文を生成する。"""
    prompt = _build_prompt(articles, target_day)

    message = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2000,
        thinking={"type": "adaptive"},
        messages=[{"role": "user", "content": prompt}],
    )

    tweet = _extract_text(message)
    if not tweet:
        raise RuntimeError("Claude から投稿文を取得できませんでした。")

    # 念のため文字数上限を超えていたら切り詰める
    if len(tweet) > TWEET_MAX_LENGTH:
        tweet = tweet[:TWEET_MAX_LENGTH]
    return tweet
