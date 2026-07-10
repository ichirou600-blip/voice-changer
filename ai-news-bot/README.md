# AI News Bot

毎朝9時（日本時間）に、前日のAI関連ニュースを要約して X（旧Twitter）へ自動投稿するシステムです。

## 概要

1. **収集**: RSS（Google News の医療AI系クエリ / ITmedia AI+）から前日 0:00〜23:59（JST）に公開されたAI関連記事を収集し、重複タイトルを除外します。
2. **選定・要約**: 収集した記事一覧を Claude API に渡し、**医療・ヘルスケアに関わるAIニュース3件**を選定させ、各件について「要約」と「薬剤師・経営者の視点での感想コメント」を生成します。
3. **投稿**: X API v2（OAuth 1.0a User Context）で**スレッド形式**で自動投稿します。
   - 1本目: 導入（見出し＋ハッシュタグ）
   - 2〜4本目: ニュース①②③ を、それぞれ「要約 ＋ 💊薬剤師・経営者コメント ＋ ソースリンク」で返信

> 💡 スレッドは1日あたり最大4ツイートになるため、X API の従量課金の消費もその分（最大4件）になります。

## 技術構成

| 項目 | 内容 |
| --- | --- |
| 言語 | Python 3.11 以上 |
| 定期実行 | GitHub Actions の cron（`0 0 * * *` = UTC 0:00 = JST 9:00） |
| ニュース収集 | RSS（`feedparser`） |
| 要約・投稿文生成 | Claude API（モデル: `claude-sonnet-4-6`） |
| X 投稿 | X API v2（`tweepy` / OAuth 1.0a User Context） |

### 収集元 RSS

- Google News RSS（AI・人工知能 / 日本語）: `https://news.google.com/rss/search?q=AI+人工知能&hl=ja&gl=JP&ceid=JP:ja`
- ITmedia AI+: `https://rss.itmedia.co.jp/rss/2.0/aiplus.xml`

## ディレクトリ構成

```
ai-news-bot/
├── main.py              # エントリポイント（収集→要約→投稿のオーケストレーション）
├── requirements.txt
└── src/
    ├── config.py        # 環境変数・設定の読み込み
    ├── collector.py     # RSS 収集・前日フィルタ・重複除外
    ├── summarizer.py    # Claude API による選定・要約
    └── publisher.py     # X への投稿
```

ワークフローはリポジトリ直下の `.github/workflows/ai-news-bot.yml` にあります。

## 認証情報（GitHub Secrets）

すべての認証情報は環境変数から読み込みます（コードへの直書きは禁止）。
リポジトリの **Settings → Secrets and variables → Actions** に以下を登録してください。

| Secret 名 | 用途 |
| --- | --- |
| `X_API_KEY` | X API キー |
| `X_API_SECRET` | X API シークレット |
| `X_ACCESS_TOKEN` | X アクセストークン |
| `X_ACCESS_TOKEN_SECRET` | X アクセストークンシークレット |
| `ANTHROPIC_API_KEY` | Claude API キー |

## ローカル実行

```bash
cd ai-news-bot
pip install -r requirements.txt

export X_API_KEY=...
export X_API_SECRET=...
export X_ACCESS_TOKEN=...
export X_ACCESS_TOKEN_SECRET=...
export ANTHROPIC_API_KEY=...

python main.py
```

前日のAI関連記事が見つからない場合は投稿をスキップします。

## 定期実行について

GitHub Actions の cron は UTC 基準で動作します。`0 0 * * *`（UTC 0:00）が
日本時間の 9:00 に相当します。手動実行（`workflow_dispatch`）にも対応しています。
