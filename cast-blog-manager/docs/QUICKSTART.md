# ローカル起動手順

自分の PC で動かして確認するための最短手順です。
お客様の環境へ導入する場合は [SETUP_GUIDE.md](./SETUP_GUIDE.md) を参照してください。

## 必要なもの

- **Node.js 22 以上**（`node -v` で確認）
- **PostgreSQL 16**（Docker か、後述の Neon 無料枠）

---

## 手順（所要 10 分）

### 1. リポジトリの取得と依存インストール

```bash
git clone <リポジトリURL>
cd cast-blog-manager
npm install
```

### 2. データベースを用意する

**A. Docker を使う場合（推奨）**

```bash
docker run -d --name cast-blog-db \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=cast_blog_manager \
  -p 5432:5432 postgres:16
```

**B. Neon（クラウド・無料枠）を使う場合**

[neon.tech](https://neon.tech) でプロジェクトを作り、接続文字列を控えます。

### 3. 環境変数を設定する

```bash
cp .env.example .env
```

`.env` を開き、最低限この3つを設定します。

```dotenv
DATABASE_URL="postgresql://postgres:password@localhost:5432/cast_blog_manager"
DIRECT_DATABASE_URL="postgresql://postgres:password@localhost:5432/cast_blog_manager"
APP_URL="http://localhost:3000"
```

> LINE 連携を試さないなら、`LINE_*` と `CRON_SECRET` は未設定のままで構いません。
> 管理画面の閲覧・キャスト登録・更新記録は問題なく動きます。

### 4. テーブルを作る

```bash
npm run db:migrate
```

### 5. 起動する

```bash
npm run dev
```

ブラウザで **http://localhost:3000** を開きます。

---

## 初回起動時の画面

データベースが空の状態では、`/` も `/login` も
**自動的に `/setup` へ移動**します。

`/setup` で以下を入力すると、最初の店舗と管理者アカウントが作成され、
そのままログインした状態でダッシュボードへ進みます。

| 項目 | 例 |
| --- | --- |
| 店舗名 | ラウンジ ルミエール |
| お名前 | 山田 太郎 |
| メールアドレス | admin@example.com |
| パスワード | **12文字以上** |

> `/setup` は**ユーザーが0件のときだけ**表示されます。
> 作成後は 404 になり、誰でも管理者を作れる状態は残りません。

---

## サンプルデータで試したい場合

セットアップ画面を使わず、動くデータですぐ確認したいときは:

```bash
npm run db:seed
```

| 項目 | 値 |
| --- | --- |
| URL | http://localhost:3000/login |
| メールアドレス | `admin@example.com` |
| パスワード | `dev-password-1234` |

店舗1つ・キャスト3名が登録された状態になります。
（`db:seed` は本番環境では実行できないようになっています）

---

## 本番と同じ状態で確認したい場合

開発モード（`npm run dev`）と本番モード（`npm run start`）では
挙動が一部異なります（Cookie 名、CSP、最適化）。
リリース前の確認は本番モードで行ってください。

```bash
npm run build
npm run start
```

> **開発サーバーと本番サーバーを同時に起動しないでください。**
> どちらも `.next` ディレクトリを使うため、互いのビルド結果を壊します。
> 切り替える際は、いったん停止してから起動してください。

---

## LINE 連携も試す場合

LINE は **公開 HTTPS URL が必須**のため、localhost のままでは動きません。

```bash
# 1. トンネルを張る
ngrok http 3000

# 2. 発行された https://xxxx.ngrok-free.app を .env の APP_URL に設定
# 3. LINE Developers の Webhook URL に
#    https://xxxx.ngrok-free.app/api/line/webhook を設定
# 4. リッチメニューを登録
npm run line:image
npm run line:setup
```

詳細は [SETUP_GUIDE.md](./SETUP_GUIDE.md) の手順2・7・8を参照してください。

---

## 動作確認コマンド

```bash
npm run typecheck   # 型チェック
npm run lint        # ESLint
npm test            # 単体・統合テスト（DB接続が必要）

# ブラウザからの通し確認（本番サーバーを起動した状態で）
npm run build && npm run start   # 別ターミナルで
npm run db:seed
npm run e2e:all
```

---

## よくあるつまずき

| 症状 | 原因と対処 |
| --- | --- |
| `Can't reach database server` | PostgreSQL が起動していない。`docker start cast-blog-db` |
| `/setup` が 404 | すでに管理者が作成済み。`/login` からログインしてください |
| ログインできない | `npm run db:reset-password -- <メール> '<新パスワード>'` |
| `EADDRINUSE` | ポートが使用中。`PORT=3001 npm run dev` で別ポートを使う |
| 画面が真っ白 / 古い表示 | 開発と本番を同時起動していないか確認。`rm -rf .next` して再ビルド |
| `npm run e2e` が接続できない | 先に `npm run start` でサーバーを起動しておく必要があります |
