# cast-blog-manager — 作業引き継ぎ

ナイトラウンジ向けの **キャストブログ更新管理ツール**（商用販売予定）。
リポジトリは `ichirou600-blip/voice-changer` の `cast-blog-manager/` 配下。
作業ブランチは `claude/cast-blog-manager-setup-fpqaxf`。

## 絶対に守る制約（依頼者の指示）

1. **リポジトリは必ずプライベート**（商用販売予定のため）
2. **APIキーや認証情報を絶対にコミットしない**（`.env` は `.gitignore` 済み）
3. **ポケパラ等への自動投稿・自動ログイン・スクレイピングは一切実装しない**
   - 文面作成機能も「下書きを作るだけ」。投稿はキャスト本人が手作業で行う
   - 更新実績は本人のLINE申告かスタッフ入力のみ（自己申告値）

## 設計上の不変条件（崩さないこと）

- **Server Action は必ず `defineAction()` で包む**。生の `"use server"` 関数を作らない
  （認可の書き忘れによるフェイルオープンを構造的に防ぐため）
- **全クエリに `storeScope(user)` を混ぜる**。ID を受け取る関数は `assertStoreAccess` で検証
- **認可を `src/proxy.ts` に置かない**（Edge で DB を見られず、ヘッダ細工のCVE前例があるため）
- **日付計算は `src/lib/business-day.ts` だけを使う**。営業日は `"YYYY-MM-DD"` 文字列（JST固定）
- **リマインドは CAS（compare-and-swap）で claim** してから送信（二重送信防止 + 再試行両立）
- **実績データは物理削除しない**（`voidedAt` による論理無効化）
- `src/lib/draft/anthropic.ts` の `import "server-only"` は**外さない**
  （スクリプトから使う場合は `scripts/probe-draft-quality.mts` のように読み込み側で差し替える）

## 主要コマンド

```bash
npm test                  # 単体・統合 224件（DB必要）
npm run typecheck && npm run lint
npm run build && PORT=3100 npm run start   # 本番サーバー
npm run e2e:all           # 通し確認 + 権限境界 + 文面作成
npm run docs:simulate     # LINE送信数の試算（資料の数値はここから取る）
npm run docs:shots        # 資料用スクリーンショット（要サーバー起動）
npm run docs:overview     # 1ページPDF
npm run docs:spec         # 5ページPDF
npm run draft:probe       # 文面作成の実地検証（要 ANTHROPIC_API_KEY）
```

**資料に載せる数値を手計算しないこと。** 過去に等間隔の更新を仮定して算出し、
曜日が偏る現実のパターンでは3倍ずれる誤りを出した。必ず `docs:simulate` を使う。

## 開発環境の注意（このサンドボックス）

- Postgres は落ちやすい。復旧は
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D <scratchpad>/pg/data -o '-p 55432 -k /tmp/pgs -c listen_addresses=127.0.0.1' -l <scratchpad>/pg/log start"`
  （先に祖先ディレクトリへ `chmod o+x` が必要）
- **dev サーバーと本番サーバーを同時に動かさない**（`.next` を共有して500になる）
- `pkill -f "next start"` は自分のシェルも巻き込む。PID 指定で kill すること
- 本物の API を叩かない検証には `npm run mock:anthropic`（:4599）

## 現在の状態

完成: 本体機能一式、文面作成機能、テスト224件、E2E3系統、
依頼者向け資料2種（`docs/仕様説明.pdf` 5ページ / `docs/仕様概要.pdf` 1ページ）、
導入手順書・運用ガイド・設計書・規約雛形。lint/typecheck/audit すべてクリーン。

### 未完了・要判断

1. **AIの実地検証** — `npm run draft:probe` を依頼者のAPIキーで実行してもらう。
   これまでの検証はすべてモック相手で、実際の文面の質は未確認
2. **LINE公式アカウントを店舗ごとに分けるか** — 現状は全店舗で1つを共用する実装
   （チャネル情報が環境変数のため）。送信上限も全店舗合計。分ける場合は
   店舗数 × 月5,000円 + 店舗単位でチャネルを持つ実装の追加が必要
3. **本物のLINEチャネルでの疎通確認** — 未実施
4. 法務テンプレートの専門家確認、1店舗での試験運用

### 規模の前提（2026-07 時点）

依頼者は複数店舗・キャスト約100名。この規模では月額約11,600円（1人あたり約116円）で
ほぼ固定（サーバー3,100 + DB2,900 + LINE5,000 + 文面作成626）。
**`LINE_MONTHLY_PUSH_LIMIT` は初期値180のままにしない。100名なら4,800に変更する。**
