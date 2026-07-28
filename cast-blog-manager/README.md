# cast-blog-manager

ナイトラウンジ向けの **キャストブログ更新管理ツール** です。
各キャストのブログ更新状況を一元管理し、更新のリマインドや進捗の可視化を行うことを目的としています。

> **重要:** 本ツールは「ポケパラ」等の外部サイトへの **自動投稿・自動ログイン・スクレイピングは一切行いません**。
> 更新記録は「キャスト本人の LINE 自己申告」または「スタッフの手入力」のみで行う、社内向けの管理・可視化・リマインドツールです。

設計の詳細と決定理由は [docs/DESIGN.md](./docs/DESIGN.md) を参照してください。

---

## 概要

- キャストごとのブログ更新状況の管理（営業日基準・深夜営業対応）
- キャスト本人が LINE で「投稿したよ」を1タップ報告 → 自動記録
- 未更新キャストへの LINE 自動リマインド（送信量の上限管理付き）
- 週次目標と達成状況の可視化ダッシュボード
- 管理者 / 店長 / スタッフのロール別認証付き管理画面

### 技術スタック

| 項目           | 採用技術                                   |
| -------------- | ------------------------------------------ |
| フレームワーク | Next.js 14（App Router）                   |
| 言語           | TypeScript                                 |
| スタイリング   | Tailwind CSS                               |
| DB / ORM       | PostgreSQL（Neon 推奨） + Prisma           |
| 認証           | NextAuth.js（導入予定・P2）                |
| 通知           | LINE Messaging API（導入予定・P5〜P7）     |
| テスト         | Vitest                                     |

---

## セットアップ手順

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 環境変数の設定

`.env.example` をコピーして `.env` を作成し、各値を設定します。

```bash
cp .env.example .env
```

### 3. データベースの準備

PostgreSQL（[Neon](https://neon.tech) の無料枠を推奨）を用意し、接続文字列を
`.env` の `DATABASE_URL` に設定したうえでマイグレーションを適用します。

```bash
npm run db:migrate        # prisma migrate deploy
```

ローカルに PostgreSQL を立てる場合の例（Docker）:

```bash
docker run -d --name cast-blog-db -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=cast_blog_manager -p 5432:5432 postgres:16
```

### 4. 開発サーバーの起動

```bash
npm run dev
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開いて動作を確認します。
初回起動時はユーザーが存在しないため、`/setup` から初期管理者を作成します（P2 実装後）。

### テストの実行

```bash
npm test
```

---

## 必要な環境変数

詳細とサンプル値は [`.env.example`](./.env.example) を参照してください。

| 変数名                      | 説明                                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`              | PostgreSQL 接続文字列（開発・本番とも PostgreSQL）                       |
| `NEXTAUTH_SECRET`           | NextAuth.js のセッション暗号化用の秘密鍵（`openssl rand -base64 32`）    |
| `NEXTAUTH_URL`              | アプリの公開 URL（開発時は `http://localhost:3000`）                     |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API のチャネルアクセストークン（リマインド送信用）        |
| `LINE_CHANNEL_SECRET`       | LINE Messaging API のチャネルシークレット（Webhook 署名検証用）          |
| `CRON_SECRET`               | `/api/cron/tick` 保護用シークレット（`openssl rand -hex 32`）            |
| `LINE_MONTHLY_PUSH_LIMIT`   | LINE Push の月間送信上限（既定 180。無料枠 200 通への安全マージン）      |

> APIキーや認証情報は **絶対にリポジトリへコミットしないでください**。
> `.env` / `.env.local` は `.gitignore` により除外されています。
> 初期管理者のパスワードも環境変数には置きません（初回セットアップ画面で作成）。

---

## デプロイ手順

本アプリは **Vercel + Neon（PostgreSQL）** の構成を想定しています。

1. Neon でデータベースを作成し、接続文字列を控える
2. Vercel でプロジェクトをインポート（対象リポジトリを選択）
3. Vercel の **Environment Variables** に上記の環境変数をすべて設定
4. デプロイ後、マイグレーションを適用: `npm run db:migrate`（`DATABASE_URL` を本番向けにして実行）
5. リマインドの自動実行は GitHub Actions の schedule（毎時）で `/api/cron/tick` を叩く構成（P7 で追加）

```bash
# ローカルでの本番ビルド確認
npm run build
npm run start
```

### 開発時の注意

- **LINE Webhook の開発には公開 HTTPS URL が必要です**（localhost 不可）。
  `ngrok http 3000` 等でトンネルを作成し、LINE Developers コンソールの Webhook URL に設定してください
- GitHub Actions の schedule はリポジトリが 60 日間無活動だと自動無効化されます（運用時の注意）

---

## ライセンス

**本ソフトウェアは商用製品です。無断での再配布・転載・二次配布を固く禁じます。**

- 本リポジトリおよびソースコードの著作権はすべて権利者に帰属します。
- 権利者の書面による許可なく、本ソフトウェアの全部または一部を複製・改変・再配布・販売することを禁止します。
- 本ソフトウェアは商用販売を予定しており、ソースコードは非公開（プライベート）で管理されます。

© cast-blog-manager. All rights reserved.
