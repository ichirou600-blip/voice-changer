"""環境変数（GitHub Secrets）から認証情報・設定を読み込むモジュール。

すべての認証情報は環境変数から取得する。コードへの直書きは禁止。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from zoneinfo import ZoneInfo

# 日本標準時（JST = UTC+9）
JST = ZoneInfo("Asia/Tokyo")

# 要約・投稿文生成に使用する Claude モデル
CLAUDE_MODEL = "claude-sonnet-4-6"

# 収集対象の RSS フィード
# 医療×AI に関する記事を確実に集めるため、医療系クエリを中心に構成する。
RSS_FEEDS = [
    # Google News RSS（AI × 医療 / 日本語）
    "https://news.google.com/rss/search?q=AI+医療&hl=ja&gl=JP&ceid=JP:ja",
    # Google News RSS（AI × 創薬・医薬・薬局・ヘルスケア / 日本語）
    "https://news.google.com/rss/search?q=AI+創薬+OR+医薬+OR+薬局+OR+ヘルスケア&hl=ja&gl=JP&ceid=JP:ja",
    # Google News RSS（AI・人工知能 全般 / 日本語）— 医療に関わる話題の取りこぼしを補う
    "https://news.google.com/rss/search?q=AI+人工知能&hl=ja&gl=JP&ceid=JP:ja",
    # ITmedia AI+（AI全般。医療関連の話題を含む場合に選定対象とする）
    "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml",
]

# 選定する記事数（スレッドの返信ツイート数）
TOP_N = 3

# X のツイート上限（重み付き文字数）。日本語=2、URL=23 でカウントされる。
TWEET_MAX_WEIGHT = 280
# URL は t.co により一律この重みで数えられる。
URL_WEIGHT = 23


class ConfigError(RuntimeError):
    """必須の環境変数が欠けている場合に送出する例外。"""


@dataclass(frozen=True)
class Credentials:
    """X API と Anthropic API の認証情報。"""

    x_api_key: str
    x_api_secret: str
    x_access_token: str
    x_access_token_secret: str
    anthropic_api_key: str


def _require_env(name: str) -> str:
    """環境変数を必須として取得する。未設定なら ConfigError。"""
    value = os.environ.get(name)
    if not value:
        raise ConfigError(f"環境変数 {name} が設定されていません。GitHub Secrets を確認してください。")
    return value


def load_credentials() -> Credentials:
    """GitHub Secrets（環境変数）から認証情報を読み込む。"""
    return Credentials(
        x_api_key=_require_env("X_API_KEY"),
        x_api_secret=_require_env("X_API_SECRET"),
        x_access_token=_require_env("X_ACCESS_TOKEN"),
        x_access_token_secret=_require_env("X_ACCESS_TOKEN_SECRET"),
        anthropic_api_key=_require_env("ANTHROPIC_API_KEY"),
    )
