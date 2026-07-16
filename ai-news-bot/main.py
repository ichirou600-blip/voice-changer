"""AIニュースBot エントリポイント。

前日（JST）の医療関連AIニュースをRSSから収集し、Claude で重要3件を選定・要約して
X（旧Twitter）へスレッド形式で自動投稿する。各件にソースリンクと、薬剤師・経営者
としての感想コメントを添える。GitHub Actions の cron から毎朝実行される。
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timedelta

import anthropic

from src.collector import collect_articles
from src.config import (
    JST,
    TWEET_MAX_WEIGHT,
    URL_WEIGHT,
    ConfigError,
    load_credentials,
)
from src.publisher import build_client, post_thread
from src.summarizer import ThreadItem, generate_thread
from src.textutil import truncate_to_weight, weighted_len

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("ai-news-bot")

# 返信ツイートの見出しに使う丸数字
CIRCLED = ["①", "②", "③", "④", "⑤"]


def _build_reply(index: int, item: ThreadItem) -> str:
    """1件分の返信ツイート本文を組み立てる（本文＋コメント＋リンク）。

    X の重み付き文字数（日本語=2, URL=23, 上限280）に収まるよう、
    リンクと改行分を差し引いた予算内に本文を切り詰める。
    """
    mark = CIRCLED[index] if index < len(CIRCLED) else f"{index + 1}."
    body = f"【医療AIニュース{mark}】{item.summary}\n💊薬剤師・経営者の視点：{item.comment}"
    # 上限280 から「本文とリンクの間の改行(1)」「URL(23)」と安全マージン(10)を差し引く
    body_budget = TWEET_MAX_WEIGHT - URL_WEIGHT - 1 - 10
    body = truncate_to_weight(body, body_budget)
    return f"{body}\n{item.link}"


def main() -> int:
    now = datetime.now(tz=JST)
    target_day = (now - timedelta(days=1)).date()
    logger.info("対象日（JST）: %s", target_day)

    try:
        creds = load_credentials()
    except ConfigError as exc:
        logger.error("設定エラー: %s", exc)
        return 1

    # 1. 収集
    articles = collect_articles(now)
    logger.info("収集した記事数（重複除外後）: %d", len(articles))
    if not articles:
        logger.warning("対象日のAI関連記事が見つかりませんでした。投稿をスキップします。")
        return 0

    # 2. 選定・要約（Claude）— 医療AIニュースのスレッド内容を生成
    anthropic_client = anthropic.Anthropic(api_key=creds.anthropic_api_key)
    content = generate_thread(anthropic_client, articles, target_day)
    logger.info("選定した医療AIニュース: %d件", len(content.items))

    # 3. スレッド本文を組み立てる（導入 + 各ニュース）
    #    導入ツイートも念のため上限内に収める（安全マージン10）。
    intro = truncate_to_weight(content.intro, TWEET_MAX_WEIGHT - 10)
    tweets = [intro]
    for i, item in enumerate(content.items):
        tweets.append(_build_reply(i, item))

    for i, text in enumerate(tweets):
        logger.info(
            "ツイート%d（%d文字 / 重み%d）:\n%s",
            i + 1,
            len(text),
            weighted_len(text),
            text,
        )

    # 4. X へスレッド投稿
    x_client = build_client(creds)
    tweet_ids = post_thread(x_client, tweets)
    logger.info("スレッド投稿完了。%d件。先頭 tweet_id=%s", len(tweet_ids), tweet_ids[0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
