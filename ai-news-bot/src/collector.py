"""RSS からニュース記事を収集するモジュール。

- feedparser で各フィードを取得
- 前日 0:00〜23:59（JST）に公開された記事のみを抽出
- 重複タイトルを除外
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

import feedparser

from .config import JST, RSS_FEEDS


@dataclass(frozen=True)
class Article:
    """収集した記事1件を表す。"""

    title: str
    link: str
    source: str
    published_jst: datetime

    def to_prompt_line(self) -> str:
        """Claude に渡すための1行テキスト表現。"""
        stamp = self.published_jst.strftime("%Y-%m-%d %H:%M")
        return f"[{self.source}] {self.title}（{stamp} / {self.link}）"


def _yesterday_jst(now: datetime | None = None) -> date:
    """JST における「前日」の日付を返す。"""
    now_jst = (now or datetime.now(tz=JST)).astimezone(JST)
    return (now_jst - timedelta(days=1)).date()


def _entry_published_jst(entry: feedparser.FeedParserDict) -> datetime | None:
    """RSS エントリの公開日時を JST の aware datetime として返す。

    feedparser の *_parsed は UTC の time.struct_time。取得できなければ None。
    """
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if parsed is None:
        return None
    # published_parsed は UTC の time.struct_time。aware な UTC datetime に変換して JST へ。
    dt_utc = datetime(*parsed[:6], tzinfo=timezone.utc)
    return dt_utc.astimezone(JST)


def _source_name(feed: feedparser.FeedParserDict, url: str) -> str:
    """フィードのタイトル（媒体名）を取得。無ければ URL のホスト名。"""
    title = feed.feed.get("title") if feed.feed else None
    if title:
        return str(title)
    return url.split("/")[2] if "//" in url else url


def collect_articles(now: datetime | None = None) -> list[Article]:
    """前日（JST）公開の AI 関連記事を収集し、重複タイトルを除外して返す。"""
    target_day = _yesterday_jst(now)
    seen_titles: set[str] = set()
    articles: list[Article] = []

    for url in RSS_FEEDS:
        feed = feedparser.parse(url)
        source = _source_name(feed, url)

        for entry in feed.entries:
            title = (entry.get("title") or "").strip()
            link = (entry.get("link") or "").strip()
            if not title or not link:
                continue

            published = _entry_published_jst(entry)
            if published is None or published.date() != target_day:
                continue

            # 重複タイトルを除外（前後空白・大文字小文字を正規化して比較）
            key = title.casefold()
            if key in seen_titles:
                continue
            seen_titles.add(key)

            articles.append(
                Article(title=title, link=link, source=source, published_jst=published)
            )

    # 公開が新しい順に並べる
    articles.sort(key=lambda a: a.published_jst, reverse=True)
    return articles
