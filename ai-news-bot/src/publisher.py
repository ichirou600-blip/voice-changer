"""X（旧Twitter）へ投稿するモジュール。

X API v2 / tweepy / OAuth 1.0a User Context を使用する。
スレッド（連続ツイート）投稿に対応。
"""

from __future__ import annotations

import tweepy

from .config import Credentials


def build_client(creds: Credentials) -> tweepy.Client:
    """OAuth 1.0a User Context で認証した tweepy.Client を生成する。"""
    return tweepy.Client(
        consumer_key=creds.x_api_key,
        consumer_secret=creds.x_api_secret,
        access_token=creds.x_access_token,
        access_token_secret=creds.x_access_token_secret,
    )


def post_tweet(client: tweepy.Client, text: str) -> str:
    """単発ツイートを投稿し、投稿された tweet の ID を返す。"""
    response = client.create_tweet(text=text)
    return str(response.data["id"])


def post_thread(client: tweepy.Client, tweets: list[str]) -> list[str]:
    """複数のツイートをスレッド（返信の連鎖）として順に投稿する。

    1本目を通常投稿し、2本目以降は直前のツイートへの返信として繋げる。
    投稿された各 tweet の ID を順に返す。
    """
    tweet_ids: list[str] = []
    reply_to: str | None = None

    for text in tweets:
        if reply_to is None:
            response = client.create_tweet(text=text)
        else:
            response = client.create_tweet(text=text, in_reply_to_tweet_id=reply_to)
        tweet_id = str(response.data["id"])
        tweet_ids.append(tweet_id)
        reply_to = tweet_id

    return tweet_ids
