# Gmail の新着メールを Muse のサイドチャットに送る

[English](gmail.md) · [日本語](gmail.ja.md) · [简体中文](gmail.zh-CN.md)

[クイックスタート](../README.ja.md#クイックスタート)のテスト通知まで完了してください。デプロイ済みの Worker、認証済みの Muse デバイス、暗号鍵、投稿先のサイドチャットが必要です。Worker 1 つにつきメールボックスを 1 件監視できます。初回設定後は Cloud Shell を閉じて構いません。Google Pub/Sub が Worker を直接呼び出し、Cloudflare の Cron が Gmail の監視を更新します。

## 1. Pub/Sub を Worker に接続する

専用の Google Cloud プロジェクトを用意し、手順 2 の OAuth クライアントも同じプロジェクトに作成します。ブラウザで Cloud Shell を開き、次の 2 つのコマンドのプロジェクト ID と Worker の URL を置き換えてください。`--dry-run` は Google に接続せずに実行内容を表示します。[Cloud Shell を開く](https://shell.cloud.google.com/)

```sh
git clone --depth 1 https://github.com/Code-Hex/MuseKnock.git
cd MuseKnock
./scripts/setup-gmail.sh --dry-run YOUR_PROJECT_ID https://YOUR-WORKER.workers.dev
./scripts/setup-gmail.sh YOUR_PROJECT_ID https://YOUR-WORKER.workers.dev
```

スクリプトが必要な API を有効にし、トピックへの公開権限を Gmail に付与して、`/hooks/gmail` を宛先とする push サブスクリプションを作成します。Pub/Sub のサービスエージェントには、専用の push サービスアカウントとして OIDC トークンを発行する権限を付与します。最後に表示される 4 つの `GMAIL_*` 設定を控えてください。再実行時は同名のリソースを再利用し、サブスクリプションの送信先を更新します。[Gmail の push 設定](https://developers.google.com/workspace/gmail/api/guides/push) · [Pub/Sub の push 認証](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

実行には、プロジェクトで API の有効化、Pub/Sub の管理、サービスアカウントの作成、上記の IAM 権限の付与ができるアカウントを使います。`iam.serviceAccounts.actAs` エラーが出た場合は、管理者に `museknock-gmail-push@YOUR_PROJECT_ID.iam.gserviceaccount.com` に対する **Service Account User** ロールを実行者に付与してもらい、再実行してください。組織のポリシーで Gmail への公開権限の付与が拒否される場合は、対象トピックの例外設定を管理者に依頼してください。[Pub/Sub の権限](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

## 2. メールボックスへのアクセスを許可する

1. Google Auth Platform で同意画面を設定し、**Data Access** に `https://www.googleapis.com/auth/gmail.readonly` を追加します。外部向けアプリが **Testing** の場合は、**Audience → Test users** に自分の Gmail アドレスを追加します。MuseKnock 側でラベルを 1 つ選んでも、Google に許可する読み取り権限はメールボックス全体に及びます。[Google Auth Platform](https://console.cloud.google.com/auth/overview)
2. **Clients** で種類 **Web application** の OAuth クライアントを作成します。承認済みのリダイレクト URI に `https://developers.google.com/oauthplayground`（末尾のスラッシュなし）を登録し、クライアント ID とシークレットを控えます。[OAuth 認証情報の作成](https://developers.google.com/workspace/guides/create-credentials#web-application)
3. OAuth 2.0 Playground の歯車から **Use your own OAuth credentials** を選び、自分のクライアント ID とシークレットを入力します。**Offline** と **Consent** を選び、手順 1 の Gmail 読み取りスコープを入力して **Authorize APIs** を押します。監視するメールボックスのアカウントでログインし、**Exchange authorization code for tokens** を押して **Refresh token** をコピーします。[OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
4. 外部向けアプリが **Testing** の場合、このリフレッシュトークンは 7 日で失効します。継続運用には用途に適した公開ステータスを選び、変更後にトークンを再発行してください。[リフレッシュトークンの失効条件](https://developers.google.com/identity/protocols/oauth2#expiration)

## 3. Worker を設定して監視を開始する

Cloudflare で対象 Worker の **Settings → Variables and Secrets** を開き、以下の値を設定してデプロイします。Google の OAuth 認証情報は Cloudflare に直接入力してください。

| 種類 | 設定 | 値 |
| --- | --- | --- |
| Secret | `GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`、`GMAIL_REFRESH_TOKEN` | OAuth クライアント ID、シークレット、メールボックスのリフレッシュトークン |
| Text | `GMAIL_ACCOUNT` | 認可したメールボックスのメインのメールアドレス |
| Text | `GMAIL_TOPIC`、`GMAIL_SUBSCRIPTION` | スクリプトが表示した `projects/…` から始まるリソース名 |
| Text | `GMAIL_PUSH_SERVICE_ACCOUNT`、`GMAIL_PUSH_AUDIENCE` | スクリプトが表示したサービスアカウントのメールアドレスと完全な HTTPS URL |
| Text、任意 | `GMAIL_LABEL_ID` | Gmail のラベル ID。既定は `INBOX`。自分で作ったラベルの ID は `users.labels.list` で確認できます。 |
| Text、任意 | `GMAIL_INCLUDE_BODY`、`GMAIL_MAX_BYTES` | 既定の `false` では、差出人・宛先・件名などのメタデータを送ります。`true` にすると利用可能なプレーンテキストの本文も送ります。本文の上限は 1〜20,000 バイトで、既定は 20,000 です。 |

1. Worker の設定と Muse の投稿先が揃うと、5 分おきの Cron が自動的に監視を開始します。すぐに開始するには管理用コネクターから `sync_gmail` を実行してください。初回は監視を登録し、その時点の履歴を開始位置として記録します。過去のメールは転送しません。`get_gmail_status` で `ready`、`historyId`、`watchExpiresAt` を確認します。
2. 別のアカウントから、選択したラベルが付くメールを新しく送信し、Muse のサイドチャットを確認します。Gmail の push 通知の上限はメールボックスごとに毎秒 1 件です。遅延や通知の欠落に備えて Worker が 5 分おきに Gmail の履歴を確認します。1 回に最大 10 件を処理し、残りは次回以降に処理します。監視の登録は毎日更新します。[Gmail の通知制限](https://developers.google.com/workspace/gmail/api/guides/push#limitations)
3. 通知が届かなくなったら、`get_gmail_status` で `lastSyncAt` と `watchExpiresAt` を確認し、`sync_gmail` で再試行します。`lastGapAt` が更新された場合は、保存していた履歴の保持期限が切れています。その期間のメールを Gmail 上で確認してください。[Gmail の履歴同期](https://developers.google.com/workspace/gmail/api/guides/sync)

## 接続を解除する

Cloudflare から Gmail の設定を削除し、変更をデプロイすると同期が止まります。push 配信を直ちに止めるには、Google Cloud で専用のサブスクリプション `museknock-gmail-push` を削除します。監視は更新を止めてから 7 日以内に失効します。連携を廃止する場合は Google アカウントでアプリのアクセス権を取り消し、専用のトピックと push サービスアカウントを削除してください。[Google アカウントの接続管理](https://myaccount.google.com/connections)
