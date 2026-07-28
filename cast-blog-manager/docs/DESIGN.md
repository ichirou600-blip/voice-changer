# cast-blog-manager 設計書（v4 確定版）

4回の設計レビュー（v1→v4）を経て確定した設計。実装中に綻びが見つかった場合は
本書を更新し、変更理由を残すこと。

## 前提・スコープ

- ナイトラウンジ向けのキャストブログ更新管理ツール
- **外部サイト（ポケパラ等）への自動投稿・自動ログイン・スクレイピングは行わない**。
  更新記録は「キャスト本人の LINE 自己申告」または「スタッフの手入力」のみ
- v1 のテナントモデルは **1導入 = 1事業者（複数店舗可）**。
  SaaS 化する場合は将来 Organization 層を追加する
- タイムゾーンは JST 固定（サマータイムなし）

## 設計レビューで確定した主要決定

| # | 決定 | 理由（レビューで潰した問題） |
|---|---|---|
| 1 | DB は開発・本番とも **PostgreSQL**（Neon 推奨） | SQLite は Vercel サーバーレスで永続化されない。環境差バグの排除 |
| 2 | リマインド実行は **トリガー非依存の `/api/cron/tick`** | Vercel Cron は Hobby プランで毎時実行不可。GitHub Actions schedule（無料）/ Vercel Cron / 手動ボタンのどれからでも叩ける |
| 3 | tick は **キャッチアップ型判定**（`現在時刻 >= reminderHour` かつ本日分未送信なら送る） | スケジューラの遅延・スキップで丸1日分のリマインドが消失するのを防ぐ |
| 4 | LINE 送信は **claim → 結果更新方式**（`LineMessageLog` を先に PENDING で upsert） | ユニーク制約だけだと FAILED 行が再送を恒久ブロックする。二重送信防止とリトライ（上限3回）を両立 |
| 5 | **月間送信上限**（`LINE_MONTHLY_PUSH_LIMIT`、既定180）を構造的に強制 | LINE 無料枠は月200通。未更新者のみ・1キャスト1営業日1通・全送信ログで使用量を可視化 |
| 6 | **営業日 = "YYYY-MM-DD" 文字列**。店舗ごとの区切り時刻（既定 朝6時 JST）で書き込み時に確定保存 | 深夜営業の日またぎ集計ずれ、`@db.Date` の UTC 往復バグを排除。計算は `src/lib/business-day.ts` のみ |
| 7 | **週は月曜はじまり固定**。`businessWeekStart` を記録時に保存 | 週次集計を GROUP BY 一発にする。週定義の曖昧さを排除 |
| 8 | 目標は **`CastTarget`（effectiveFrom 付き履歴）**。「effectiveFrom 以降に開始する週」から適用 | 目標変更が過去週の達成判定を書き換えるのを防ぐ |
| 9 | 更新記録は **物理削除禁止・論理無効化**（voidedAt / voidedBy / voidReason） | 実績が評価・給与に繋がり得るため改ざん耐性と監査を確保 |
| 10 | キャスト退店は `RETIRED`（論理削除）、`onDelete: Restrict` で履歴保全 | 退店処理で実績履歴が消えるのを防ぐ |
| 11 | LINE 連携は **ワンタイム連携コード方式** + follow/unfollow ハンドリング | `lineUserId` は Webhook からしか取得できない。ブロック時は `BLOCKED` で送信対象から自動除外 |
| 12 | 自己申告は **確認ステップ（今日/昨日/キャンセル）+ 10分重複ガード** | 誤タップ・連打での記録量産を防止。1日複数投稿は正当として許可 |
| 13 | 初期管理者は **初回セットアップ画面 `/setup`**（User 0件時のみ有効） | env にパスワードを残すアンチパターンの排除 |
| 14 | 招待・パスワード再設定は **リンク手渡し方式**、トークンは**ハッシュのみ保存** | メール基盤への依存を排除。DB 漏洩時の乗っ取り防止 |

## リマインド tick のフロー（擬似コード）

```
POST /api/cron/tick  (Authorization: Bearer CRON_SECRET)

for store in stores:
  today = toBusinessDate(now, store.businessDayStart)
  if jstHour(now) >= store.reminderHour:            # 「一致」ではなく「到達済み」
    staleCasts = ACTIVE かつ lineStatus=LINKED かつ
                 recentBusinessDates(today, store.daysStaleThreshold) に
                 有効な BlogPost が無いキャスト
    for cast in staleCasts:
      log = upsert LineMessageLog(cast, REMINDER, today)   # claim（冪等の要）
      if log.result == SENT or log.attemptCount >= 3: continue
      if 当月送信数 >= LINE_MONTHLY_PUSH_LIMIT: log.result = SKIPPED_QUOTA
      elif cast.lineStatus == BLOCKED:            log.result = SKIPPED_BLOCKED
      else: Push 送信 → SENT / FAILED(attemptCount++)
```

- トリガーが何時に・何回・重複して走っても「1営業日1通、失敗時は最大3回再試行」に収束する
- トリガーは GitHub Actions（毎時）を既定とし、`workflow_dispatch` と管理画面の
  「今すぐ実行」ボタンでも同エンドポイントを叩ける

## LINE 自己申告フロー

```
リッチメニュー「投稿したよ」タップ
 → Bot: 「どの投稿ですか？」〔今日の分〕〔昨日の分〕〔キャンセル〕(Quick Reply)
 → 選択 → 直近10分に同キャストの CAST_LINE 記録があれば作成せず「記録済み」と返す
 → BlogPost 作成（source=CAST_LINE）
 → Bot: 「記録したよ！今週 n/target 回目」（達成状況を即フィードバック）
```

## 実装フェーズ

| Phase | 内容 | 状態 |
|---|---|---|
| P1 | Postgres + Prisma スキーマ、`business-day.ts` + ユニットテスト | ✅ 完了 |
| P2 | 認証（NextAuth Credentials）+ `/setup` + 招待/再設定リンク + 店舗スコープ認可 | 未着手 |
| P3 | キャスト・目標管理（CRUD、論理削除、CastTarget 履歴） | 未着手 |
| P4 | 更新記録（スタッフ入力）+ 週次達成判定 + ダッシュボード | 未着手 |
| P5 | LINE 連携基盤：Webhook（署名検証）、連携コード、follow/unfollow、リッチメニュー | 未着手 |
| P6 | 「投稿したよ」自己申告 → 自動記録 | 未着手 |
| P7 | リマインド：`/api/cron/tick` + GitHub Actions + 送信量管理 + 手動実行 | 未着手 |
| P8 | 仕上げ：レートリミット、エラー処理、デプロイ手順確定 | 未着手 |

## 開発時の注意

- **LINE Webhook の開発には公開 HTTPS URL が必要**（localhost 不可）。
  `ngrok http 3000` 等でトンネルを作り、LINE Developers の Webhook URL に設定する
- **GitHub Actions の schedule はリポジトリが60日間無活動だと自動無効化される**。
  運用が安定した後は定期的なコミット活動、または外部監視での手動実行を検討する
- マイグレーションは `prisma/migrations/0_init` をベースラインとして
  `prisma migrate deploy` で適用する（開発中の変更は `prisma migrate dev`）
- 日付演算は必ず `src/lib/business-day.ts` を経由する（独自の Date 演算を書かない）
