"""X（旧Twitter）へ投稿するモジュール。

X API v2 / tweepy / OAuth 1.0a User Context を使用する。
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
    """ツイートを投稿し、投稿された tweet の ID を返す。"""
    response = client.create_tweet(text=text)
    return str(response.data["id"])
