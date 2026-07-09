"""AIニュースBot エントリポイント。

前日（JST）のAI関連ニュースをRSSから収集し、Claude で重要3件を選定・要約して
X（旧Twitter）へ自動投稿する。GitHub Actions の cron から毎朝9時（JST）に実行される。
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timedelta

import anthropic

from src.collector import collect_articles
from src.config import JST, ConfigError, load_credentials
from src.publisher import build_client, post_tweet
from src.summarizer import generate_tweet

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("ai-news-bot")


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

    # 2. 選定・要約（Claude）
    anthropic_client = anthropic.Anthropic(api_key=creds.anthropic_api_key)
    tweet = generate_tweet(anthropic_client, articles, target_day)
    logger.info("生成された投稿文（%d文字）:\n%s", len(tweet), tweet)

    # 3. X へ投稿
    x_client = build_client(creds)
    tweet_id = post_tweet(x_client, tweet)
    logger.info("投稿完了。tweet_id=%s", tweet_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
