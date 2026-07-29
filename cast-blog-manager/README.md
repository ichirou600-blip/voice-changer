# cast-blog-manager

ナイトラウンジ向けの **キャストブログ更新管理ツール** です。
各キャストのブログ更新状況を一元管理し、更新のリマインドと進捗の可視化を行います。

> **重要:** 本ツールは「ポケパラ」等の外部サイトへの **自動投稿・自動ログイン・スクレイピングは一切行いません**。
> 更新記録は「キャスト本人の LINE 自己申告」または「スタッフの手入力」のみです。

## ドキュメント

| 文書 | 内容 |
| --- | --- |
| [docs/QUICKSTART.md](./docs/QUICKSTART.md) | **ローカル起動手順**（まずはこれ。10分で動きます） |
| [docs/SETUP_GUIDE.md](./docs/SETUP_GUIDE.md) | **導入手順書**（お客様の環境への導入。60〜90分） |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | **運用ガイド**（日常確認・ログ・バックアップ・障害対応） |
| [docs/DESIGN.md](./docs/DESIGN.md) | 設計書（決定内容と、そこに至った理由） |
| [docs/TERMS_TEMPLATE.md](./docs/TERMS_TEMPLATE.md) | 利用規約の雛形（要・専門家確認） |
| [docs/PRIVACY_POLICY_TEMPLATE.md](./docs/PRIVACY_POLICY_TEMPLATE.md) | プライバシーポリシーの雛形（要・専門家確認） |

---

## 主な機能

| 機能 | 内容 |
| --- | --- |
| ダッシュボード | 営業日基準の未更新アラート、週次目標の達成状況 |
| キャスト管理 | 在籍状況（在籍/休止/退店）、週次目標の履歴管理、LINE 連携 |
| 更新記録 | スタッフ手入力／キャスト本人の LINE 自己申告。物理削除せず論理無効化 |
| LINE リマインド | 未更新キャストへ自動送信。送信量の上限管理・重複送信防止つき |
| LINE リッチメニュー | 「投稿したよ」「今週の状況」を1タップで操作 |
| CSV 出力 | 更新記録を Excel で開ける形式（BOM付きUTF-8）で書き出し |
| スタッフ管理 | 招待リンク・パスワード再設定リンクの発行、強制ログアウト、無効化 |
| 監査ログ | 招待・無効化・記録の無効化などを追跡可能に記録 |
| 死活監視 | `/api/health` でDB接続と設定状況を確認 |

### 技術スタック

| 項目 | 採用技術 |
| --- | --- |
| フレームワーク | Next.js 16（App Router） |
| 言語 | TypeScript |
| スタイリング | Tailwind CSS |
| DB / ORM | PostgreSQL（Neon 推奨） + Prisma 6 |
| React | React 19 |
| 認証 | 自前の DB セッション（argon2id + httpOnly Cookie） |
| 通知 | LINE Messaging API |
| テスト | Vitest（単体 + 実 DB 統合テスト） |

---

## クイックスタート

```bash
npm install
cp .env.example .env          # DATABASE_URL などを設定
npm run db:migrate            # テーブル作成
npm run dev                   # http://localhost:3000
```

初回は自動的に `/setup` へ移動します。そこで最初の店舗と管理者を作成してください
（この画面はユーザーが0件のときだけ表示され、作成後は 404 になります）。

サンプルデータで試す場合は `npm run db:seed`
（`admin@example.com` / `dev-password-1234`）。

つまずいた場合は [docs/QUICKSTART.md](./docs/QUICKSTART.md) に
必要なものと対処法をまとめています。

---

## セットアップ手順（詳細）

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集し、少なくとも `DATABASE_URL` / `DIRECT_DATABASE_URL` / `APP_URL` を設定します。

### 3. データベースの準備

PostgreSQL（[Neon](https://neon.tech) の無料枠を推奨）を用意し、マイグレーションを適用します。

```bash
npm run db:migrate        # prisma migrate deploy
```

ローカルに立てる場合の例（Docker）:

```bash
docker run -d --name cast-blog-db \
  -e POSTGRES_PASSWORD=password -e POSTGRES_DB=cast_blog_manager \
  -p 5432:5432 postgres:16
```

### 4. 開発サーバーの起動

```bash
npm run dev
```

[http://localhost:3000](http://localhost:3000) を開くと `/setup` に誘導されます。
そこで **最初の店舗と管理者アカウント** を作成してください
（この画面はユーザーが0件のときだけ有効で、作成後は 404 になります）。

開発用のサンプルデータを入れる場合:

```bash
npm run db:seed   # admin@example.com / dev-password-1234
```

### 5. 検証コマンド

```bash
npm run typecheck   # 型チェック
npm run lint        # ESLint
npm test            # 単体・統合テスト（DB 接続が必要）
npm run build       # 本番ビルド

# ブラウザからの通し確認（別ターミナルで本番サーバーを起動しておく）
npm run build && PORT=3100 npm run start
npm run db:seed
npm run e2e:all      # 通し確認 + 権限境界
```

| コマンド | 検証内容 |
| --- | --- |
| `npm test` | 単体・統合テスト（営業日計算、認可、リマインド、LINE API の通信内容 等） |
| `npm run e2e` | ログイン→記録→ダッシュボード反映→無効化→CSV→キャスト登録→連携コード→ログアウト |
| `npm run e2e:permissions` | 招待フローと権限境界（STAFF に見えてはいけないものが見えないか） |

> **`npm run e2e` は必ず実行してください。** 単体テストは DAL を直接呼ぶため、
> 「フォームが実際に送信する値」で壊れるバグを検出できません。

これらは [CI](./.github/workflows/ci.yml) ですべて自動実行されます
（PostgreSQL サービスコンテナ上で型チェック・ESLint・テスト・ビルド・
脆弱性チェック・E2E）。依存パッケージの更新は Dependabot が毎週提案します。

### 依存パッケージの脆弱性について

```bash
npm audit --omit=dev   # 実行時依存のみ → 0件を維持する
npm audit              # 開発ツールを含む
```

**実行時依存（本番成果物に含まれるもの）の脆弱性は0件です。**
`npm audit` に残る指摘は ESLint のツールチェーン内のもので、
本番成果物には含まれません（`.next` に混入していないことを確認済み）。
CI では `npm audit --omit=dev --audit-level=high` で実行時依存のみを検査します。

---

## 必要な環境変数

詳細とサンプル値は [`.env.example`](./.env.example) を参照してください。

| 変数名 | 必須 | 説明 |
| --- | :---: | --- |
| `DATABASE_URL` | ○ | PostgreSQL 接続文字列（プール経由でも可） |
| `DIRECT_DATABASE_URL` | ○ | マイグレーション用の直結 URL（プール未使用なら同じ値） |
| `APP_URL` | ○ | 公開 URL。CSRF の Origin 照合と招待リンク生成に使用 |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE 利用時 | リマインド送信用のアクセストークン |
| `LINE_CHANNEL_SECRET` | LINE 利用時 | Webhook の署名検証用（Webhook の唯一の認可手段） |
| `CRON_SECRET` | リマインド利用時 | `/api/cron/tick` を保護する共有シークレット |
| `LINE_MONTHLY_PUSH_LIMIT` | 任意 | Push の月間上限（既定 180） |

> APIキーや認証情報は **絶対にリポジトリへコミットしないでください**。
> `.env` は `.gitignore` で除外されています。
> 初期管理者のパスワードも環境変数には置きません（初回セットアップ画面で作成します）。

---

## リマインドの自動実行

`/api/cron/tick` は **トリガー非依存** です。次のいずれからでも実行できます。

1. **GitHub Actions（既定・無料）** — [`.github/workflows/reminder-cron.yml`](./.github/workflows/reminder-cron.yml) が毎時実行します。
   リポジトリの Secrets に `APP_URL` と `CRON_SECRET` を登録してください。
2. **Vercel Cron** — [`vercel.json`](./vercel.json) に日次の設定があります
   （Hobby プランは1日1回までのため日次。Pro なら任意の間隔に変更可）。
3. **管理画面の「今すぐリマインドを実行」ボタン** — スケジューラなしでも運用できます。

エンドポイントは **キャッチアップ型かつ冪等** です。
スケジューラが遅延・スキップしても取りこぼさず、何度呼ばれても
1キャストにつき1営業日1通に収束します。

```bash
# 手動実行の例
curl -X POST "$APP_URL/api/cron/tick" -H "Authorization: Bearer $CRON_SECRET"
```

---

## LINE 連携の手順

1. LINE Developers で Messaging API チャネルを作成し、
   `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` を `.env` に設定
2. Webhook URL に `https://<APP_URL>/api/line/webhook` を登録し、Webhook を有効化
3. リッチメニューを登録する

   ```bash
   npm run line:image   # メニュー画像を生成（文言はスクリプト内で変更可）
   npm run line:setup   # LINE に登録
   ```

4. 管理画面のキャスト詳細で **連携コードを発行**（24時間有効。MANAGER 以上）
5. キャスト本人に公式アカウントを友だち追加してもらい、そのコードを送信してもらう
6. 連携完了。以降はリッチメニューの「投稿したよ」をタップすると、
   〔今日の分〕〔昨日の分〕〔キャンセル〕の確認を経て更新が記録されます

> **開発時の注意:** LINE Webhook には **公開 HTTPS URL が必須** です（localhost は不可）。
> `ngrok http 3000` などでトンネルを作り、その URL を Webhook に設定してください。

---

## デプロイ手順（Vercel + Neon）

1. Neon でデータベースを作成し、接続文字列を控える
2. Vercel でプロジェクトをインポート（Root Directory に `cast-blog-manager` を指定）
3. Vercel の **Environment Variables** に上記の環境変数をすべて設定
4. マイグレーションを適用（本番の `DATABASE_URL` を指定して実行）

   ```bash
   npm run db:migrate
   ```

5. デプロイ後、`/setup` で初期管理者を作成
6. GitHub リポジトリの Secrets に `APP_URL` / `CRON_SECRET` を登録してリマインドを有効化

### 運用上の注意

- **GitHub Actions の schedule は、リポジトリが60日間無活動だと自動的に無効化されます。**
  長期運用時は定期的なコミット、または Vercel Cron / 手動実行を併用してください。
- **管理者が1人だけの状態でパスワードを失うと復旧できません。** 管理者は2人以上作るか、
  緊急時は DB にアクセスできる環境から復旧スクリプトを実行してください。

  ```bash
  npm run db:reset-password -- admin@example.com '新しいパスワード'
  ```

---

## セキュリティ設計の要点

本ツールは商用製品のため、設計レビュー（デビルズアドボケイト）の指摘を反映しています。

- パスワードは **argon2id**（m=19MiB, t=2, p=1）でハッシュ化
- セッションは **DB 管理**。Cookie には平文トークン、DB にはハッシュのみ保存
- 本番の Cookie は **`__Host-` prefix** 付き（cookie 上書きによるセッション固定を防止）
- **アイドル期限（7日）と絶対期限（30日）** の二本立てで永久セッションを作らない
- スタッフ無効化時は `isActive` を毎リクエスト確認し、**全端末で即時失効**
- ログイン試行は **DB を共有ストアとしたレート制限**（サーバーレスでも有効）
- ユーザー列挙を防ぐため、**存在しないアカウントでもダミーハッシュを検証**
- Server Action は必ず `defineAction()` で包み、**認可の書き忘れを構造的に防止**
- 全クエリに店舗スコープを強制し、**他店舗データへの越境アクセス（IDOR）を遮断**
- 変更系リクエストは **Origin 照合**（middleware と Action の二段）
- 招待・再設定トークンはハッシュ保存・ワンタイム・短期限。
  **GET では消費せず POST で確定**するためリンクプレビュー bot でも切れない

---

## 販売にあたっての準備

本リポジトリには法務文書の**雛形**を同梱していますが、
そのままでは使用できません。販売前に以下を必ず行ってください。

- [ ] [LICENSE](./LICENSE) の権利者名を自社名に置き換える
- [ ] [docs/TERMS_TEMPLATE.md](./docs/TERMS_TEMPLATE.md) の〔　〕を埋め、**弁護士等の確認を受ける**
- [ ] [docs/PRIVACY_POLICY_TEMPLATE.md](./docs/PRIVACY_POLICY_TEMPLATE.md) の〔　〕を埋め、**弁護士等の確認を受ける**
      （キャストの源氏名・LINE識別子という個人情報を扱うため必須）
- [ ] 継続課金で販売する場合は、特定商取引法に基づく表記を用意する
- [ ] データの保存期間・削除方針を決めてプライバシーポリシーに反映する
- [ ] サポート範囲・対応時間・連絡先を利用規約に明記する

## ライセンス

**本ソフトウェアは商用製品です。無断での再配布・転載・二次配布を固く禁じます。**
詳細は [LICENSE](./LICENSE) を参照してください。

© cast-blog-manager. All rights reserved.
