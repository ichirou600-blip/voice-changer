# cast-blog-manager 設計書（確定版）

本書は、実装前に行った **4回の設計レビュー（v1→v4）** と、
その後の **デビルズアドボケイトによる認証設計の反証レビュー** の結論をまとめたものです。
実装中に綻びが見つかった場合は本書を更新し、変更理由を残してください。

## 前提・スコープ

- ナイトラウンジ向けのキャストブログ更新管理ツール（商用製品）
- **外部サイト（ポケパラ等）への自動投稿・自動ログイン・スクレイピングは行わない。**
  更新記録は「キャスト本人の LINE 自己申告」または「スタッフの手入力」のみ
- テナントモデルは **1導入 = 1事業者（複数店舗可）**。
  SaaS 化する場合は将来 Organization 層を追加する
- タイムゾーンは JST 固定（サマータイムなし）
- 利用規模は1店舗あたり管理スタッフ数名、同時接続は多くて数十

---

## 第1部: 設計レビュー v1→v4 で確定した決定

| # | 決定 | 潰した問題 |
|---|---|---|
| 1 | DB は開発・本番とも **PostgreSQL**（Neon 推奨） | SQLite は Vercel のサーバーレスで永続化されず、デプロイのたびにデータが消える。provider 差による環境差バグも排除 |
| 2 | リマインドは **トリガー非依存の `/api/cron/tick`** | Vercel Cron は Hobby プランで毎時実行できない。GitHub Actions（無料）/ Vercel Cron / 手動ボタンのどれからでも叩ける形にした |
| 3 | tick は **キャッチアップ型判定**（`現在時刻 >= reminderHour` かつ本日分未送信なら送る） | 「時刻が一致したら送る」方式だと、スケジューラの遅延・スキップで丸1日分のリマインドが静かに消失する |
| 4 | LINE 送信は **claim → 結果更新方式** | ユニーク制約だけで冪等性を担保すると、FAILED 行が残って**再送が恒久的に不可能**になる。先に PENDING で行を確保し、結果を更新することで二重送信防止とリトライ（上限3回）を両立 |
| 5 | **月間送信上限**（既定180）を構造的に強制 | LINE 無料枠は月200通。20名に毎日送ると月600通で即超過する。未更新者のみ・1キャスト1営業日1通に絞り、超過分は SKIPPED_QUOTA として記録 |
| 6 | **営業日 = "YYYY-MM-DD" 文字列**。店舗ごとの区切り時刻（既定 朝6時 JST）で書き込み時に確定 | 深夜営業の日またぎで集計がずれる。`@db.Date` は UTC 往復で1日ずれる典型バグを踏む |
| 7 | **週は月曜はじまり固定**。`businessWeekStart` を記録時に保存 | 週の定義が曖昧だと集計がぶれる。保存しておけば週次集計が GROUP BY 一発で済む |
| 8 | 目標は **`CastTarget`（effectiveFrom 付き履歴）**。「effectiveFrom 以降に開始する週」から適用 | 目標を変更すると過去週の達成判定まで遡って変わってしまう |
| 9 | 更新記録は **物理削除禁止・論理無効化**（voidedAt / voidedById / voidReason） | 実績が評価・給与に繋がり得るため、改ざん耐性と監査可能性が必要 |
| 10 | キャスト退店は `RETIRED`（論理削除）、`onDelete: Restrict` | 退店処理で更新履歴が巻き込み削除されるのを防ぐ |
| 11 | LINE 連携は **ワンタイム連携コード方式** + follow/unfollow ハンドリング | `lineUserId` は Webhook からしか取得できない。ブロック時は `BLOCKED` にして送信対象から自動除外し、失敗ログが積み上がるのを防ぐ |
| 12 | 自己申告は **確認ステップ（今日/昨日/キャンセル）+ 10分の重複ガード** | リッチメニューの誤タップ・連打で記録が量産される。1日複数投稿は正当なので恒久ブロックはしない |
| 13 | 初期管理者は **初回セットアップ画面 `/setup`**（User 0件時のみ有効） | 環境変数に初期パスワードを置くと Vercel の env に平文で残留し続ける |
| 14 | 招待・パスワード再設定は **リンク手渡し方式**、トークンは**ハッシュのみ保存** | メール基盤への依存を排除。DB 漏洩時の乗っ取りも防ぐ |

---

## 第2部: 認証設計のデビルズアドボケイト・レビュー

当初案（自前 DB セッション + scrypt）に対する反証レビューで、以下が指摘されました。
**方向性（自前 DB セッション）は妥当だが、当初の実装方針は不合格**という結論です。

> NextAuth / Auth.js は Credentials Provider を使うとセッション戦略が JWT に強制されるため、
> 「メール＋パスワードのみ」かつ「退職者を即座に無効化」というこの要件と構造的に噛み合わない。
> 結局 callback 内で毎リクエスト DB を引くことになり、自前実装と同じ手間をライブラリの抽象を
> 貫通しながら書く羽目になる。

### 指摘と対策

| 指摘 | 深刻度 | 対策 |
|---|---|---|
| **Server Actions が認可を素通りする**。`"use server"` は自動的に公開 POST エンドポイントになり、UI でボタンを隠しても Action 本体に認可が無ければ意味がない | 致命的 | 生の Server Action を書かず、**必ず `defineAction(role, handler)` で包む**規約にした。認証・ロール検証・Origin 照合・例外正規化を一括で行うため、書き忘れによるフェイルオープンが構造的に起きない |
| **店舗境界がスキーマにも認可にもない（IDOR）**。他店舗の ID を指定すると読み書きできる | 致命的 | DAL を設け、全クエリに `storeScope(user)` を混ぜる。ID 指定の関数は取得時点で店舗条件を含めるため、他店舗の ID は「存在しない」扱いになる。**統合テストで越境不可を検証済み** |
| **レート制限が無く、Vercel ではインメモリ実装が効かない** | 致命的 | PostgreSQL を共有ストアとして `LoginAttempt` に記録。IP 単位（20回/15分）とメール単位（5回/15分）の二重制限 |
| **Server Component から Cookie を書けない** ため、セッション延長の置き場所がない | 高 | Cookie の期限は**絶対期限に固定**して発行し、延長は DB 側（`idleExpiresAt`）のみで行う。**真実の情報源は常に DB** |
| **scrypt の地雷**（maxmem 制約、libuv スレッドプール枯渇、自己記述フォーマット欠如）。そもそも「bcrypt はネイティブビルドが必要」という回避理由が**事実誤認** | 高 | **argon2id（`@node-rs/argon2`、prebuilt バイナリ）** に変更。m=19MiB, t=2, p=1。ハッシュ文字列にパラメータが埋まるため将来の引き上げでも既存ハッシュが壊れない |
| **`__Host-` prefix が無く cookie 上書き（セッション固定）が可能** | 高 | 本番の Cookie 名を `__Host-cbm_session` に。ログイン成功時に既存セッションを全破棄してから新規発行 |
| **「即座に無効化」が達成できていない**（`isActive` を毎回見ていない／絶対期限が無い） | 高 | セッション検証のたびに `User.isActive` を JOIN で確認し、false なら全セッション削除。アイドル期限7日 + 絶対期限30日の二本立て |
| **ユーザー列挙**（存在しないメールは応答が速い） | 中 | 不在時もダミーハッシュを検証して計算コストを揃え、エラーメッセージも統一 |
| **CSRF は SameSite=Lax だけでは不足** | 中 | 変更系リクエストで Origin を照合。middleware（一次）と `defineAction`（二次）の二段 |
| **`lastUsedAt` の毎リクエスト UPDATE で DB が痛む** | 中 | 前回更新から60秒以上経過した場合のみ書き戻す |
| **リクエスト内での重複クエリ** | 中 | `getSessionUser` をリクエストスコープでメモ化（React `cache`。テスト実行時はフォールバック） |
| **招待/再設定リンクの穴**（プレビュー bot による消費、退職者の事前仕込み、パスワード変更後もセッションが残る） | 中 | GET では消費せず **POST で確定**。受諾時に `isActive` を確認。完了時に全セッションを破棄。発行者と対象を監査ログに記録 |
| **管理者1人がパスワードを忘れると復旧不能** | 中 | 復旧スクリプト `npm run db:reset-password` を用意し、README に明記 |
| 期限切れセッション・試行記録の GC が無い | 低 | cron tick のついでに掃除 |

### 実装後の自己レビューで追加した対策

| 見つけた問題 | 対策 |
|---|---|
| `loginAction` / `setupAction` / `acceptAction` は未認証で呼べるため `defineAction` を経由せず、**Origin 照合の二段目が抜けていた**（ログイン CSRF は特に指摘されていた） | 3つの Action それぞれで `assertSameOriginRequest()` を明示的に呼ぶようにした |
| リマインドで **未連携（NOT_LINKED）が `SKIPPED_BLOCKED` として記録**されており、ログの意味が誤っていた | `SKIPPED_NOT_LINKED` を enum に追加し、スキップ理由を正確にマッピング。未連携だったキャストがその日のうちに連携すれば送信される回復性もテストで担保 |
| LINE 連携コードに **試行回数制限が無かった**（探索空間 31⁸ ≒ 8500億通りで総当たりは非現実的だが、商用としては不十分） | レート制限を汎用化し、LINE ユーザー単位で 15 分あたり 5 回に制限。連携成功で解除 |

---

## リマインド tick のフロー

```
POST /api/cron/tick  (Authorization: Bearer CRON_SECRET)

for store in stores:
  if jstHour(now) >= store.reminderHour:            # 「一致」ではなく「到達済み」
    today = toBusinessDate(now, store.businessDayStart)
    for cast in ACTIVE かつ 直近 daysStaleThreshold 営業日に有効な更新が無いキャスト:
      log = upsert LineMessageLog(cast, REMINDER, today)   # claim（冪等の要）
      decideSend(...) で判定:
        SENT 済み        -> スキップ（二度と送らない）
        試行上限到達      -> スキップ
        未連携 / BLOCKED  -> スキップして記録
        月間上限到達      -> SKIPPED_QUOTA として記録
        それ以外          -> Push 送信 -> SENT / FAILED(attemptCount++)
```

トリガーが何時に・何回・重複して走っても「1営業日1通、失敗時は最大3回まで再試行」に収束します。

## LINE 自己申告フロー

```
リッチメニュー「投稿したよ」タップ
 → Bot:「どの投稿ですか？」〔今日の分〕〔昨日の分〕〔キャンセル〕(Quick Reply)
 → 選択 → 直近10分に同キャストの自己申告があれば作成せず「記録済み」と返す
 → BlogPost 作成（source=CAST_LINE）
 → Bot:「記録しました！今週は n/target 回目です」
```

応答は Push ではなく **reply** を使います（無料枠を消費しないため）。

---

## ディレクトリ構成

```
cast-blog-manager/
├── .github/workflows/reminder-cron.yml   # 毎時 /api/cron/tick を叩く（無料スケジューラ）
├── vercel.json                            # Vercel Cron（日次・Hobby 互換のバックアップ）
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts                            # 開発用のみ（本番の管理者は /setup で作成）
├── scripts/
│   ├── reset-admin-password.ts            # 緊急復旧
│   └── dev-session.mts                    # 開発用のセッション発行
├── src/
│   ├── middleware.ts                      # CSRF 一次防御 + セキュリティヘッダ（認可は置かない）
│   ├── app/
│   │   ├── setup/                         # 初回セットアップ（User 0件時のみ）
│   │   ├── login/
│   │   ├── invite/[token]/                # 招待・再設定（GET では消費しない）
│   │   ├── (dashboard)/
│   │   │   ├── dashboard/ casts/ posts/ users/ settings/
│   │   └── api/
│   │       ├── cron/tick/                 # トリガー非依存・冪等
│   │       └── line/webhook/              # 署名検証
│   ├── components/ui.tsx
│   └── lib/
│       ├── business-day.ts                # 営業日・週の計算（日付演算の唯一の入口）
│       ├── targets.ts                     # 週次目標の解決と達成判定
│       ├── reminder-policy.ts             # 送信可否の純粋判定
│       ├── reminder-runner.ts             # リマインド実行本体
│       ├── quota.ts                       # 月間送信数の管理
│       ├── auth/                          # password / session / authorize / rate-limit / login / setup / tokens
│       ├── dal/                           # 店舗スコープを強制するデータアクセス層
│       ├── line/                          # signature / client
│       └── http/csrf.ts
└── test/                                  # 実 DB に対する統合テスト
```

---

## 実装フェーズと状態

| Phase | 内容 | 状態 |
|---|---|---|
| P1 | Postgres + Prisma、営業日ユーティリティ + テスト | ✅ 完了 |
| P2 | 認証・認可（DB セッション、`/setup`、招待/再設定、店舗スコープ） | ✅ 完了 |
| P3 | キャスト・目標管理（CRUD、論理削除、目標履歴） | ✅ 完了 |
| P4 | 更新記録（スタッフ入力）+ 週次達成判定 + ダッシュボード | ✅ 完了 |
| P5 | LINE 連携基盤（Webhook 署名検証、連携コード、follow/unfollow） | ✅ 完了 |
| P6 | 「投稿したよ」自己申告 → 自動記録 | ✅ 完了 |
| P7 | リマインド（cron tick、GitHub Actions、送信量管理、手動実行） | ✅ 完了 |
| P8 | 仕上げ（監査ログ、CSP、復旧手順、ドキュメント） | ✅ 完了 |

---

## 開発時の注意

- **日付演算は必ず `src/lib/business-day.ts` を経由する**（独自の Date 演算を書かない）
- **Server Action は必ず `defineAction()` で包む**（生の `"use server"` 関数を作らない）
- **DAL を経由せず Prisma を直接呼ばない**（店舗スコープが漏れる）
- **GET で状態を変えるエンドポイントを作らない**（`/api/cron/tick` の GET は
  シークレット必須かつ冪等であるため許容した唯一の例外）
- **認可を middleware に寄せない**（Edge で DB を参照できず、バイパス系の不具合にも弱い）
- LINE Webhook の開発には **公開 HTTPS URL が必要**（`ngrok http 3000` など）
- GitHub Actions の schedule は **60日間無活動で自動無効化**される
