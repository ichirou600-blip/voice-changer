# 運用ガイド

導入後の運用担当者向けの手順書です。

## 日常の確認

| 頻度 | 確認内容 | 方法 |
| --- | --- | --- |
| 毎日 | リマインドが送られているか | 設定画面の「今月の LINE 送信数」が増えているか |
| 毎日 | 未更新キャスト | ダッシュボードの「要リマインド」 |
| 毎週 | 目標達成状況 | ダッシュボード |
| 毎月 | LINE 送信数の残量 | 設定画面（上限に近づいたら LINE のプランを検討） |
| 随時 | 死活監視 | `GET /api/health` が 200 を返すか |

### ヘルスチェック

```bash
curl -s https://<APP_URL>/api/health | jq
```

```json
{
  "status": "ok",
  "checks": {
    "database": true,
    "lineConfigured": true,
    "cronConfigured": true,
    "appUrlConfigured": true
  }
}
```

`status` が `degraded` の場合は DB に接続できていません。
UptimeRobot 等の死活監視サービスにこの URL を登録することを推奨します。

## ログの見方

ログは1行1JSONで出力されます（Vercel のログ画面で検索できます）。

| event | 意味 | 対応 |
| --- | --- | --- |
| `reminder.run_finished` | リマインド実行の集計 | `sent`/`failed` を確認 |
| `reminder.send_failed` | Push 送信に失敗 | `errorMessage` を確認。3回まで自動再試行される |
| `line.webhook.invalid_signature` | 署名検証に失敗 | `LINE_CHANNEL_SECRET` の設定ずれ、または不正なリクエスト |
| `line.webhook.event_failed` | Webhook イベント処理の失敗 | スタックトレースを確認 |
| `cron.unauthorized` | cron が認可されなかった | `CRON_SECRET` の設定ずれ |
| `action.failed` | 管理画面の操作で予期せぬエラー | スタックトレースを確認 |

個人情報（氏名・メール・LINE userId）はログに出力されません
（ID は先頭6文字のみマスク出力）。

## バックアップと復元

### バックアップ

Neon / Supabase 等のマネージド DB を使う場合、
サービス側の自動バックアップ（Point-in-Time Recovery）を有効にしてください。

手動でダンプを取る場合:

```bash
# 論理バックアップ（推奨: 日次）
pg_dump "$DATABASE_URL" -Fc -f backup_$(date +%Y%m%d).dump

# 保管は最低30日分。別リージョン・別アカウントに保存すること
```

### 復元

```bash
# 新しい空の DB を用意してから
pg_restore -d "$NEW_DATABASE_URL" --clean --if-exists backup_20260728.dump
```

### 復元のリハーサル

**年1回は実際に復元を試してください。** 取れているつもりのバックアップが
壊れていた、という事故が最も多いパターンです。

### データの書き出し（顧客への引き渡し）

管理画面の「更新記録」→「CSVで書き出す」から、
全期間の記録（無効化されたものを含む）を CSV で取得できます。

```bash
# API から直接取得することもできます（要ログインセッション）
curl -b "cookie.txt" "https://<APP_URL>/api/export/posts?includeVoided=1" -o 記録.csv
```

## 緊急時の対応

### 管理者がパスワードを忘れてログインできない

```bash
npm run db:reset-password -- admin@example.com '新しいパスワード'
```

DB に接続できる環境から実行してください。実行するとそのユーザーの
全セッションも失効します。

**予防策: 管理者は必ず2名以上作成してください。**

### 退職者を即座に締め出したい

管理画面の「スタッフ管理」→ 対象者の「無効化」。
その時点で全端末のセッションが失効します。
「強制ログアウト」はセッションのみを切るため、
退職時は必ず「無効化」を使ってください。

### リマインドが送られていない

1. `/api/health` で `cronConfigured` が true か確認
2. GitHub Actions の実行履歴を確認（60日間無活動で自動停止します）
3. 設定画面の「今すぐリマインドを実行」を押して手動実行
4. ログの `reminder.run_finished` で `skipped` の理由を確認
   - `NOT_LINKED`: キャストが LINE 未連携
   - `BLOCKED`: キャストが公式アカウントをブロック
   - `QUOTA`: 月間送信上限に到達

### LINE の送信枠が足りない

`LINE_MONTHLY_PUSH_LIMIT` は無料枠200通に対する安全弁です（既定180）。
店舗規模が大きい場合は LINE 公式アカウントの有料プランを契約し、
この値を引き上げてください。

## 定期メンテナンス

| 頻度 | 作業 |
| --- | --- |
| 週次 | 依存パッケージの脆弱性確認（`npm audit`） |
| 月次 | Next.js / Prisma のパッチ適用 |
| 年次 | バックアップからの復元リハーサル |
| 年次 | 管理者アカウントの棚卸し（退職者が残っていないか） |
