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

## 第3部: 実装レビュー（デビルズアドボケイト）の指摘と対策

完成したコードに対して再度デビルズアドボケイトを立てた結果、
**「認可の構造（defineAction 強制・storeScope の全クエリ適用）は守られているが、
その外側が破綻している」**という講評とともに、以下が指摘されました。全て修正済みです。

| # | 指摘 | 深刻度 | 対策 |
|---|---|---|---|
| 1 | **STAFF が実績を捏造できた**。`issueLinkCodeAction` が STAFF 権限で、発行コードを画面に平文で返していたため、STAFF が自分の LINE をキャストに紐付けて更新実績を作れた。解除も無効化も MANAGER 限定のため後始末もできない | 致命的 | 発行を **MANAGER 以上**に格上げ。コードの表示も MANAGER 以上に限定（STAFF が他人の発行分を横取りできないように） |
| 2 | **リマインドの冪等性が多重起動で成立していなかった**。`upsert` は行を返すだけで行ロックにならず、2インスタンスが同じ `PENDING` を読んで**二重送信**する。月間送信数もプロセス内変数だったため、上限をインスタンス数倍まで突破しうる | 致命的 | claim を **CAS（条件付き更新）** に変更し、`SENDING` 状態を追加。更新できた1プロセスだけが送信する。クラッシュ時は5分後に回収。月間送信数は送信のたびに DB から読み直す |
| 3 | **MANAGER が同店舗の ADMIN を締め出せた**。`issuePasswordReset` と `setUserActive` には ADMIN ガードがあるのに **`revokeSessions` と `listSessionsForUser` だけ抜けていた**（同じチェックを3箇所に手書きした結果） | 高 | `assertCanManageUser()` に集約し、「自分と同格以上は操作不可」として一般化。ガード漏れが再発しない形にした |
| 4 | **複数店舗でダッシュボードの数字が壊れる**。代表1店舗の営業日で DB を引きながら、集計はキャストごとに別の営業日で行っていた。しかも代表店舗が**キャストの名前順**で決まるため、キャストを1人足すだけで全店舗の数字が入れ替わりうる | 高 | **店舗ごとにグループ化**し、その店舗の営業日・週で引くよう全面的に書き直した |
| 5 | **`reminderHour < businessDayStart` だと設定時刻が無視される**。判定がカレンダー時刻なのに重複排除キーは営業日だったため、「深夜3時に送りたい」設定が毎朝6時の送信になっていた | 高 | 判定を**営業日内の経過時間**に変更 |
| 6 | 自己申告の重複ガードに `businessDate` が入っておらず、「今日の分」の直後に「昨日の分」を入れると**記録されないのに成功表示**になっていた | 中 | ガードを営業日ごとに変更 |
| 7 | 手動リマインドが**全店舗**を発火し、共有の月間枠を消費できた。送信数も STAFF に見えていた | 中 | 非 ADMIN は自店舗のみに限定。送信数の表示・取得を MANAGER 以上に |
| 8 | `/users` が **STAFF にも同僚のメールアドレスを表示**しており、それを使って店長のログインを連続失敗させ締め出せた | 中 | ページを MANAGER 以上に限定 |
| 9 | 未認証 Action（login/setup/invite）だけ CSRF が一段防御だった | 中 | 各 Action で `assertSameOriginRequest()` を明示的に呼ぶ |
| 10 | STAFF が**無制限・無期限に遡って**記録を投入でき、取り消しは MANAGER のみ | 中 | 遡及を60営業日以内に制限、1営業日あたり10件の上限、休止中キャストへの記録を禁止 |
| 11 | `voidPost` / `unlinkLine` の `revalidatePath` 漏れ | 低 | 関連ページを追加 |
| 12 | ダッシュボードが最終更新日のために**全 BlogPost をロード**していた（記録は物理削除しないので単調増加） | 低 | `groupBy` の `_max` に置換 |
| 13 | リマインド文面生成がキャストごとに2クエリ（N+1） | 低 | 一括取得に変更 |
| 14 | 連携コード衝突リトライのオフバイワン | 低 | 検証してから採用する形に修正 |
| 15 | 招待時のメール重複チェックで**他店舗のユーザー存在を列挙**できた | 低 | スコープ外は汎用メッセージに |
| 16 | 退店しても LINE 連携が残り、`follow` で連携が復活しうる | 低 | 退店時に LINE 情報をクリア |
| 17 | `handlePostback` が休止中のキャストの記録を許可（どこにも表示されない記録が生まれる） | 低 | 在籍中のみ受付に統一 |
| 18 | `x-forwarded-for` の先頭を優先しており、構成次第で攻撃者が制御できた | 低 | `x-real-ip` を優先 |

**問題なしと確認された観点**（レビュー結果より）: `defineAction` 未使用の Action なし / DAL の店舗スコープ漏れなし /
`issueLinkCodeAction`・`unlinkLineAction` の IDOR なし / LINE 署名検証 / `business-day.ts` の日付計算（境界値・
`businessDateStartInstant` の往復一致を含む）/ セッション管理 / 招待・リセットトークン / 権限昇格（招待経由）/
`decideSend` の判定順序 / cron の認可 / SQLインジェクション / XSS / 本番でのエラー詳細漏洩 / middleware への認可依存。

---

## リマインド tick のフロー

```
POST /api/cron/tick  (Authorization: Bearer CRON_SECRET)

for store in stores:
  if jstHour(now) >= store.reminderHour:            # 「一致」ではなく「到達済み」
    today = toBusinessDate(now, store.businessDayStart)
    for cast in ACTIVE かつ 直近 daysStaleThreshold 営業日に有効な更新が無いキャスト:
      log = upsert LineMessageLog(cast, REMINDER, today)   # 行を用意
      decideSend(...) で判定:
        SENT 済み        -> スキップ（二度と送らない）
        試行上限到達      -> スキップ
        未連携 / BLOCKED  -> スキップして記録
        月間上限到達      -> SKIPPED_QUOTA として記録
        それ以外          -> CAS で claim（result と attemptCount を条件に更新）
                             更新できた1プロセスだけが Push 送信
                             -> SENT / FAILED
```

CAS の where に「読み取った時点の result と attemptCount」を含めるため、
複数インスタンスが同時に走っても**送信するのは1プロセスだけ**になります
（ユニーク制約が防ぐのは行の重複であって送信の重複ではない、というのが実装レビューの指摘です）。

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

## 第4部: 商用リリース前の整備

### Next.js 16 への移行（セキュリティ)

販売可否の確認時に `npm audit` を実行したところ、Next.js 14.2.35 に
**未修正の HIGH 脆弱性が多数**残っていることが判明した。
本アプリの構成に直接該当するものが含まれていたため、16 系へ移行した。

| 該当した主な脆弱性 | 深刻度 | 本アプリへの関係 |
|---|---|---|
| Denial of Service in App Router using Server Actions | HIGH | Server Actions を全面的に使用 |
| HTTP request deserialization DoS (RSC) | HIGH | App Router / RSC を使用 |
| Denial of Service with Server Components | HIGH | 同上 |
| Unauthenticated disclosure of internal Server Function endpoints | MODERATE | 認可モデルに直結 |
| XSS in App Router applications using CSP nonces | MODERATE | CSP を設定済み |

移行にあたって対応した破壊的変更:

- `cookies()` / `headers()` / `params` / `searchParams` が **非同期化**
  → 全呼び出し箇所で `await` するよう修正（テストスタブも Promise を返す形に）
- `experimental.serverComponentsExternalPackages` → `serverExternalPackages`
- `next lint` の廃止 → ESLint のフラット設定（`eslint.config.mjs`）へ移行
- React 19 へ更新

あわせて、Next.js が同梱する古い `postcss` / `sharp` を `overrides` で
修正済みバージョンへ引き上げ、**実行時依存の脆弱性を0件**にした。

### ブラウザでの通し確認（E2E）で発見した中核バグ

単体・統合テストが 124 件通っている状態でブラウザから操作したところ、
**更新記録の登録がまったく動作していなかった**。

原因は、未入力の日付欄が空文字 `""` として送信されるのに対し、
`businessDateSchema.optional()` が空文字を受け付けなかったこと
（`title` / `url` には空文字許容があったが `businessDate` だけ抜けていた）。

DAL を直接呼ぶテストでは `businessDate: undefined` を渡していたため、
スキーマを経由せず検出できなかった。

対策:
- `optionalBusinessDateSchema` を追加し、空文字を `undefined` に正規化
- **「フォームが実際に送信する形」で全スキーマを検証するテスト**を追加
- ブラウザからの通し確認（`npm run e2e`）をリポジトリに追加し、CI 相当の手順に組み込み

### 検証の三層構造

実装レビューとブラウザ確認を経て、検証を次の三層に整理した。
どの層も欠けると、実際に起きたようなバグを見逃す。

| 層 | 対象 | 検出できるもの | 実際に検出した例 |
|---|---|---|---|
| 単体・統合（`npm test`） | 純粋関数と DAL（実 DB 接続） | ロジックの誤り、店舗境界の破れ、リマインドの冪等性 | 多重起動での二重送信、複数店舗での集計ずれ |
| LINE API 契約（`npm test` に含む） | モック LINE サーバーへの実リクエスト | エンドポイント・ヘッダ・ボディ構造の誤り | （回帰防止として整備） |
| E2E（`npm run e2e:all`） | 実ブラウザからの操作 | フォームが実際に送る値、UI のロールゲート | **更新記録の登録が全く動かないバグ**、権限境界 |

とくに三層目が無い状態では、単体テストが 124 件通っていても
「アプリの中核機能が動かない」ことに気づけなかった。

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
