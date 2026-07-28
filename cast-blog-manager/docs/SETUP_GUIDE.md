# 導入手順書

新しい店舗へ本ツールを導入する際の作業手順です。
上から順に実施すれば完了します。所要時間の目安は **60〜90分** です。

## 事前に用意するもの

- [ ] GitHub アカウント（リポジトリのアクセス権）
- [ ] Vercel アカウント
- [ ] Neon アカウント（PostgreSQL）
- [ ] LINE ビジネス ID（LINE公式アカウント作成用）
- [ ] 店舗名、初期管理者の氏名・メールアドレス

---

## 手順1: データベースを作る（10分）

1. [Neon](https://neon.tech) にログインし、プロジェクトを作成
2. リージョンは **Asia Pacific (Singapore)** を選択（日本から最も近い）
3. Connection String を2種類コピーする
   - **Pooled connection**（`-pooler` を含む）→ `DATABASE_URL` に使う
   - **Direct connection** → `DIRECT_DATABASE_URL` に使う
4. バックアップ（Point-in-Time Restore）が有効か確認

---

## 手順2: LINE公式アカウントを作る（20分）

1. [LINE Developers](https://developers.line.biz/console/) にログイン
2. プロバイダーを作成（例: 店舗名）
3. **Messaging API** チャネルを作成
4. 以下を控える
   - **チャネルシークレット**（Basic settings）→ `LINE_CHANNEL_SECRET`
   - **チャネルアクセストークン（長期）**（Messaging API 設定で発行）→ `LINE_CHANNEL_ACCESS_TOKEN`
5. **応答設定** を以下にする
   - 応答メッセージ: **オフ**（自動応答が邪魔になるため）
   - Webhook: **オン**
   - あいさつメッセージ: 任意
6. Webhook URL は手順4のデプロイ後に設定します

---

## 手順3: シークレットを生成する（5分）

```bash
# cron 用
openssl rand -hex 32
```

出力を `CRON_SECRET` として控えます。

---

## 手順4: Vercel にデプロイする（15分）

1. Vercel でリポジトリをインポート
2. **Root Directory** に `cast-blog-manager` を指定
3. Environment Variables に以下を設定

| 変数名 | 値 |
| --- | --- |
| `DATABASE_URL` | 手順1の Pooled connection |
| `DIRECT_DATABASE_URL` | 手順1の Direct connection |
| `APP_URL` | デプロイ後の URL（例: `https://xxx.vercel.app`） |
| `LINE_CHANNEL_ACCESS_TOKEN` | 手順2のトークン |
| `LINE_CHANNEL_SECRET` | 手順2のシークレット |
| `CRON_SECRET` | 手順3で生成した値 |
| `LINE_MONTHLY_PUSH_LIMIT` | `180`（無料プランの場合） |

4. デプロイを実行
5. デプロイ後の URL を `APP_URL` に設定し直して再デプロイ

---

## 手順5: データベースを初期化する（5分）

手元の PC から、本番の接続文字列を指定して実行します。

```bash
cd cast-blog-manager
npm install

# .env に本番の DATABASE_URL / DIRECT_DATABASE_URL を設定してから
npm run db:migrate
```

---

## 手順6: 初期管理者を作る（5分）

1. ブラウザで `https://<APP_URL>/setup` を開く
2. 店舗名・氏名・メールアドレス・パスワード（12文字以上）を入力
3. 作成すると自動的にログインされます

> この画面はユーザーが0件のときだけ表示され、作成後は404になります。

**この直後に、管理者をもう1名招待してください。**
管理者が1名だけだと、その人がパスワードを失った際に
DB 直接操作でしか復旧できません。

---

## 手順7: LINE の Webhook を設定する（5分）

1. LINE Developers の Messaging API 設定を開く
2. Webhook URL に `https://<APP_URL>/api/line/webhook` を入力
3. 「検証」ボタンを押して **成功** することを確認
4. Webhook の利用を **オン** にする

---

## 手順8: リッチメニューを登録する（10分）

```bash
# 画像を生成（文言を変えたい場合は scripts/generate-rich-menu-image.mts を編集）
npm run line:image

# LINE に登録（.env に LINE_CHANNEL_ACCESS_TOKEN が必要）
npm run line:setup
```

登録すると、キャストのトーク画面下部に
「投稿したよ」「今週の状況」のメニューが表示されます。

---

## 手順9: リマインドの自動実行を有効にする（10分）

GitHub リポジトリの **Settings → Secrets and variables → Actions** に登録します。

| Secret 名 | 値 |
| --- | --- |
| `APP_URL` | `https://<APP_URL>` |
| `CRON_SECRET` | 手順3の値 |

登録後、**Actions タブ → 「リマインド定期実行」→ Run workflow** で
手動実行し、成功することを確認してください。

> GitHub Actions の schedule は、リポジトリが60日間無活動だと
> 自動的に無効化されます。長期運用では定期的に確認してください。

---

## 手順10: 動作確認（15分）

以下をすべて確認します。

- [ ] `https://<APP_URL>/api/health` が `"status": "ok"` を返す
- [ ] 管理画面にログインできる
- [ ] 設定画面で営業日の区切り時刻・リマインド時刻を設定できる
- [ ] キャストを登録できる
- [ ] キャストの連携コードを発行できる
- [ ] 自分の LINE で公式アカウントを友だち追加し、連携コードを送って連携できる
- [ ] リッチメニューが表示される
- [ ] 「投稿したよ」→「今日の分」で記録され、管理画面に反映される
- [ ] 「今週の状況」で進捗が返る
- [ ] 設定画面の「今すぐリマインドを実行」で通知が届く
- [ ] 更新記録の CSV 書き出しができる

---

## 手順11: 店舗設定を実運用に合わせる（5分）

設定画面で以下を店舗の実態に合わせます。

| 項目 | 説明 | 例 |
| --- | --- | --- |
| 営業日の区切り | この時刻を境に営業日が変わる | 朝6時（深夜営業のため） |
| リマインド送信時刻 | この時刻以降の最初の実行で送信 | 17時（出勤前） |
| 未更新と判定する日数 | 直近この日数更新が無ければ対象 | 2日 |

---

## 引き渡し時の説明事項

お客様に必ず伝えてください。

1. **管理者は2名以上作ること**（1名だと復旧不能になる）
2. **LINE の無料枠は月200通**。キャストが増えたら有料プランが必要
3. **本ツールは外部サイトへの自動投稿を行わない**。更新記録は自己申告・手入力
4. **退職者は「無効化」で即座に締め出せる**（強制ログアウトだけでは不十分）
5. パスワードは12文字以上、使い回さないこと
