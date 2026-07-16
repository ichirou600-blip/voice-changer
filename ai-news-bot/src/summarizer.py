"""Claude API を使って医療関連のAIニュースを選定し、
スレッド（連続ツイート）用の投稿内容を生成するモジュール。

出力:
- 導入ツイート（intro）
- 医療AIニュース3件（各: 要約 summary / 薬剤師・経営者コメント comment / ソースリンク link）
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date

import anthropic

from .collector import Article
from .config import CLAUDE_MODEL, TOP_N


@dataclass(frozen=True)
class ThreadItem:
    """スレッドの1件（返信ツイート1本分の素材）。"""

    summary: str
    comment: str
    link: str


@dataclass(frozen=True)
class ThreadContent:
    """スレッド全体の内容。"""

    intro: str
    items: list[ThreadItem]


def _build_prompt(articles: list[Article], target_day: date) -> str:
    """記事一覧から Claude 用のプロンプト本文を組み立てる。"""
    lines = "\n".join(f"{i + 1}. {a.to_prompt_line()}" for i, a in enumerate(articles))
    return f"""あなたは、薬剤師でありながら薬局・企業を経営する経営者でもある人物の
X（旧Twitter）投稿を代筆するアシスタントです。

以下は {target_day.strftime("%Y年%m月%d日")} に公開されたAI関連ニュースの一覧です。
この中から【医療・ヘルスケア・医薬・創薬・薬局・病院・診断・介護などに関わるもの】に
絞って、特に重要度の高い記事を {TOP_N} 件選び、スレッド形式の投稿を作成してください。

# 記事一覧
{lines}

# 作成するもの
1. intro: スレッド1本目に投稿する導入文。
   - 日付と「今日の医療AIニュース」のような見出しを付ける。
   - 「薬剤師・経営者の視点で3本、スレッドで紹介します」といった一言を添える。
   - 末尾にハッシュタグを2〜3個（例：#AI #医療 #薬剤師）。
   - 全体で全角60文字以内。
2. picks: 選んだ {TOP_N} 件。各要素は次の3項目。
   - index: 上の「記事一覧」の番号（整数）。
   - summary: そのニュースの要約。全角45文字以内。事実ベースで簡潔に。
   - comment: 薬剤師かつ経営者としての率直な感想・所感。全角55文字以内。
     現場（薬局・患者対応）と経営（コスト・人材・業務効率・法規制）の
     両方の目線を意識した、一人称の生きたコメントにする。
   - ※各ツイートには番号見出しとリンクも付くため、summary と comment は
     必ず上記の文字数を守り、簡潔にすること。

# 医療に関わる記事が {TOP_N} 件に満たない場合
- 無理に非医療の記事を混ぜず、医療に関わるものだけを選ぶ（1〜2件でもよい）。

# 出力形式（厳守）
- 説明や前置きを一切書かず、次の形式の JSON だけを出力すること。
- リンク（URL）は含めないこと（こちらで自動付与します）。

{{
  "intro": "……",
  "picks": [
    {{"index": 1, "summary": "……", "comment": "……"}}
  ]
}}
"""


def _extract_text(message: anthropic.types.Message) -> str:
    """Message からテキストブロックのみを連結して返す。"""
    parts = [block.text for block in message.content if block.type == "text"]
    return "".join(parts).strip()


def _parse_json(text: str) -> dict:
    """Claude の応答テキストから JSON 部分を取り出してパースする。"""
    # コードフェンス（```json ... ```）が付く場合に備えて中身の { ... } を抽出
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise RuntimeError(f"Claude の応答から JSON を抽出できませんでした: {text[:200]}")
    return json.loads(text[start : end + 1])


def generate_thread(
    client: anthropic.Anthropic, articles: list[Article], target_day: date
) -> ThreadContent:
    """記事一覧を Claude に渡し、医療AIニュースのスレッド内容を生成する。"""
    prompt = _build_prompt(articles, target_day)

    # 決まった形式（JSON）で確実に返させたいので思考（thinking）は無効化する。
    # adaptive thinking は思考でトークン枠を使い切り、本文（JSON）が空になることがある。
    message = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=4000,
        thinking={"type": "disabled"},
        messages=[{"role": "user", "content": prompt}],
    )

    data = _parse_json(_extract_text(message))

    intro = str(data.get("intro", "")).strip()
    if not intro:
        raise RuntimeError("導入文（intro）が生成されませんでした。")

    items: list[ThreadItem] = []
    for pick in data.get("picks", []):
        try:
            idx = int(pick["index"]) - 1  # 1始まり → 0始まり
        except (KeyError, TypeError, ValueError):
            continue
        if not (0 <= idx < len(articles)):
            continue  # 範囲外のインデックスは無視
        summary = str(pick.get("summary", "")).strip()
        comment = str(pick.get("comment", "")).strip()
        if not summary:
            continue
        items.append(
            ThreadItem(summary=summary, comment=comment, link=articles[idx].link)
        )

    if not items:
        raise RuntimeError("医療関連のニュースを選定できませんでした。")

    return ThreadContent(intro=intro, items=items)
