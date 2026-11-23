# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock は Cloudflare Workers で Webhook を受け取り、既存の Muse サイドチャットに通知を届けます。投稿先は Muse の MCP コネクタから選べます。パソコンの電源を切っても Worker が配信を続けます。

[クイックスタート](#クイックスタート) · [English](README.md) · **日本語** · [简体中文](README.zh-CN.md)

## クイックスタート

Cloudflare と GitHub のアカウント、認証済みの Muse 端末情報、ガジェットが既存のチャットで使っているセッション ID を用意します。SDK トークンは自分の Muse アカウントでの個人・非商用利用が対象です。[初回の端末認証](docs/operations.ja.md#初回の端末認証)・[SDK トークンの利用条件](https://gadgets.muse.ai/sdk-terms)

**1. Cloudflare からデプロイします。** 上の **Deploy to Cloudflare** を押し、Worker 名を選び、デプロイ画面の Worker シークレット欄に次の7項目を入力します。最初の3項目にはパスワードマネージャーで生成した、十分長いランダムな英数字をそれぞれ別に使います。[Cloudflare のデプロイボタンの仕様](https://developers.cloudflare.com/workers/platform/deploy-buttons/#worker-environment-variables-and-secrets)

| シークレット | 設定する値 |
| --- | --- |
| `HOOK_TOKEN` | Webhook 送信元用のトークン |
| `MCP_TOKEN` | Muse の閲覧用コネクタのトークン |
| `MCP_ADMIN_TOKEN` | 投稿先の設定やテスト送信に使う Muse の管理用トークン |
| `CREDENTIAL_ENCRYPTION_KEY` | 保存する認証情報を暗号化する32バイトの専用鍵。パスワードマネージャーで16進数（0〜9、a〜f）のランダムな64文字を生成し、控えを安全に保管します。 |
| `MUSE_NODE_ID` | 公式の `pairing.json` なら `node_id`、コミュニティ版の `state.json` なら `device.device_id` |
| `MUSE_REFRESH_TOKEN` | 公式なら `refresh_token`、コミュニティ版なら `device.refresh_token` |
| `MUSE_SDK_TOKEN` | 公式ならペアリングに使った SDK トークン、コミュニティ版なら `sdk_token` |

既存の Worker を更新する場合は、デプロイ前にこのシークレットを追加し、更新後に Muse で設定を確認してください。[保存済み認証情報の移行手順](docs/operations.ja.md#保存済みの認証情報を移行する)

引き渡し後は Worker が端末の認証情報を更新します。同じ端末 ID を使う executor や SDK デーモンが稼働中なら、事前に停止して自動起動を解除します。Cloudflare に転記する端末情報は表の3項目だけです。元のファイルとアカウントの認証情報は手元で保管してください。Worker をデプロイしたら、表示された HTTPS URL をコピーします。

**2. Muse にコネクタを追加します。** Muse の **Settings → Connectors** でカスタムコネクタを1つ追加します。デプロイ先の URL の末尾に `/mcp` を付け、認証方式に Bearer を選び、トークン欄に `MCP_ADMIN_TOKEN` を入力します。[Muse コネクタの設定手順](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

**3. Muse に投稿先の登録とテストを頼みます。** 次の順に依頼してください。

1. 「MuseKnock の設定を確認して」。`get_setup_status` は Worker 内の設定を確認します。実際に届くかはテスト投稿で確かめます。
2. 「既存のセッション `既存のセッションID` を『ビルド通知』として登録し、通知先にして」。ID にはガジェットの `--session-id`、または旧環境の `MUSE_SESSION_ID` の正確な値を使います。`register_side_chat` が登録する名前は MuseKnock 内のものです。未知の ID を使うと初回の投稿で新しいチャットが作られる場合があります。[Gadget SDK のサイドチャット](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md)
3. 「テスト通知を1件送り、配信状態を確認して」。Muse は新しい UUID を `requestId` として `send_test_notification` を呼び、返った受付 ID を `get_delivery_status` に渡します。`sent` になったら選んだチャットを開きます。同じテストを再試行するときは同じリクエスト ID を使います。

**4. 送信元サービスを接続します。** Slack、LINE、Twilio、Telegram、企業微信、GitHub、X には[サービス別の設定手順](#サービスを直接接続する)を使います。Bluesky と Discord の設定は [Bluesky を接続する](#bluesky-を接続する)と [Discord を接続する](#discord-を接続する)を参照してください。Gmail の設定は [Gmail 接続ガイド](docs/gmail.ja.md)を参照してください。Bearer ヘッダーを指定できる送信元には、次の汎用 Webhook が使えます。

送信元の Webhook 設定で、同じ Worker の `/hooks/custom` に `POST` を指定します。ヘッダーを `Authorization: Bearer YOUR_HOOK_TOKEN`、`Content-Type: application/json` とし、例えば `{"message":"ビルドが完了しました"}` を送ると受付 ID が返ります。以降は Muse から配信状態の確認、通知元の一時停止、イベント種別の絞り込みができます。

旧 URL の `/hooks/default` を使っている場合は、送信元の設定を `/hooks/custom` に更新してください。

## サービスを直接接続する

Cloudflare で対象の Worker を開き、**Settings → Variables and Secrets** に利用するサービスの値を Secret として追加し、変更をデプロイします。登録する URL は、Worker の公開 HTTPS URL の末尾に下表のパスを付けたものです。各サービスは独自の方式で認証するため、`HOOK_TOKEN` は `/hooks/custom` 用に保管します。

| サービス | Worker に登録する Secret | URL の登録と動作確認 |
| --- | --- | --- |
| Slack Events API | **Basic Information → App Credentials** の Signing Secret を `SLACK_SIGNING_SECRET` に設定 | **Event Subscriptions** を有効にし、Request URL に `/hooks/slack` を登録します。**Verified** と表示されたら `app_mention` などの Bot Event を購読し、必要な権限を承認してアプリをインストールまたは再インストールします。チャンネルに招待してメンションを送ります。[Slack の URL 設定](https://docs.slack.dev/apis/events-api/using-http-request-urls/) |
| LINE Messaging API | チャネルの **チャネル基本設定** にあるチャネルシークレットを `LINE_CHANNEL_SECRET` に設定 | **Messaging API 設定** の Webhook URL に `/hooks/line` を登録し、**検証** を押して **Webhook の利用** を有効にします。受信エラー時の再送は **Webhook の再送** で有効にできます。公式アカウントにメッセージを送ります。検証時に届く署名付きの空イベントは投稿されません。[LINE の接続確認](https://developers.line.biz/ja/docs/messaging-api/verify-webhook-url/) |
| Twilio の SMS・MMS 着信 | 番号を所有するアカウントの Primary Auth Token を `TWILIO_AUTH_TOKEN` に設定 | **Active Numbers** で対象番号を開き、Messaging の **A message comes in → Webhook → HTTP POST** に `/hooks/twilio` で終わる公開 URL を正確に入力して保存します。その番号に SMS を送って確認します。Worker は空の TwiML を返すため、自動返信は送信されません。[Twilio の着信 Webhook](https://www.twilio.com/docs/messaging/guides/webhook-request) |
| 企業微信（WeCom）の自建アプリ | **我的企业** の企業 ID を `WECOM_CORP_ID` に、コールバックの Token と EncodingAESKey を `WECOM_TOKEN` と `WECOM_ENCODING_AES_KEY` に設定 | **应用管理 → 自建 → 接收消息 → 设置 API 接收** で `/hooks/wecom` と同じ Token、EncodingAESKey を入力します。管理画面で企業名義の登録済みドメインを求められた場合は、その条件を満たすカスタムドメインを Worker に設定します。保存時に暗号化されたチャレンジで接続を確認します。その後、アプリにメッセージを送ります。[企業微信のコールバック](https://developer.work.weixin.qq.com/document/path/90930) |

**Telegram Bot API** は @BotFather で Bot を作成します。英数字、アンダースコア、ハイフンからなるランダムな値（1〜256 文字）を別途生成し、Cloudflare の `TELEGRAM_WEBHOOK_SECRET` に保存します。HTTPS クライアントから次の値で `setWebhook` を呼びます。シェルで実行する場合、`BOT_TOKEN` は BotFather のトークン、`WORKER_URL` は末尾のスラッシュを除いた Worker の URL です。Bot トークンは Telegram API の呼び出しにだけ使います。登録すると、その Bot の既存の Webhook URL は置き換わります。[Telegram の Webhook 設定](https://core.telegram.org/bots/api#setwebhook)

```sh
curl --fail-with-body -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/hooks/telegram" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","edited_message","channel_post","edited_channel_post"]'
curl --fail-with-body "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

`getWebhookInfo` で登録した URL が返ったら、Bot との個人チャットにメッセージを送ります。通常のメッセージ、チャンネル投稿、これらの編集を受け付け、テキストやキャプションがあれば転送します。選択した Muse サイドチャットに届けば、配信まで確認できています。この Bot にメッセージを送れる人は誰でも通知を発生させられます。

### GitHub のリポジトリイベント

1. ランダムなシークレットを生成し、Worker の `GITHUB_WEBHOOK_SECRET` に保存します。対象リポジトリで **Settings → Webhooks → Add webhook** を開き、Payload URL に `https://YOUR-WORKER/hooks/github`、Content type に `application/json`、Secret に同じ値を設定します。SSL 検証は有効にします。
2. **Let me select individual events** で `push`、`issues`、`pull_request`、`release`、`workflow_run` から必要なイベントを選び、有効化します。Worker は GitHub の SHA-256 署名を検証します。登録時の `ping` は接続確認のみで、選択したイベントが発生するとチャットに概要が届きます。[GitHub の Webhook 作成手順](https://docs.github.com/ja/webhooks/using-webhooks/creating-webhooks)
3. 届かない場合は **Recent Deliveries** を開きます。GitHub は失敗した配信を自動再送しません。Worker の上限はリクエスト本文が 512 KiB、送信元ごとの新規イベントが毎分 10 件です。`429` の場合は 1 分待ち、**Redeliver** を押します。7 日以内に同じ本文を再送しても、通知は重複しません。[失敗した配信の処理](https://docs.github.com/ja/webhooks/testing-and-troubleshooting-webhooks/handling-failed-webhook-deliveries)

### X の公開投稿

X Activity API を利用できる承認済みの開発者アプリを用意します。OAuth 2.0 の **Client Secret** を Worker の `X_OAUTH2_CLIENT_SECRET` に保存します。Worker はこの値で登録時のチャレンジ（CRC）に応答し、配信の署名を検証します。X は削除を含む投稿イベントの配信ごとに課金します。[X Activity API](https://docs.x.com/x-api/activity/introduction)

次の 2 回の X API 呼び出しにはアプリ専用 Bearer Token を使います。ヘッダーを `Authorization: Bearer YOUR_APP_BEARER_TOKEN` と `Content-Type: application/json` にして JSON を送信します。

1. `POST https://api.x.com/2/webhooks` に `{"url":"https://YOUR-WORKER/hooks/x"}` を送ります。X が接続を確認したら、応答から Webhook ID を控えます。[Webhook の登録](https://docs.x.com/x-api/webhooks/quickstart)
2. `POST https://api.x.com/2/activity/subscriptions` に `{"event_type":"post.create","filter":{"user_id":"NUMERIC_X_USER_ID"},"webhook_id":"WEBHOOK_ID"}` を送ります。削除通知も必要なら、`post.delete` でもう一件登録します。[イベント購読の設定](https://docs.x.com/x-api/activity/quickstart)

対象の公開アカウントで投稿し、サイドチャットへの配信を確認します。新しい投稿は投稿 ID、URL、本文の先頭 4,000 文字までを転送します。MCP の絞り込みには `post_create` と `post_delete` を使います。同じ X イベント ID の再送は 7 日間重複排除されます。

## Gmail を接続する

Google Pub/Sub が署名付きの通知を `/hooks/gmail` に直接送ります。Worker が Gmail アカウント 1 件の新着メールを読み取り、選択したサイドチャットに投稿します。初回のみ Cloud Shell で Google 側を設定します。Worker の設定と投稿先の選択が済むと、5 分おきの Cron が監視を開始します。すぐに開始するには Muse から `sync_gmail` を呼び出してください。[Gmail 接続ガイド](docs/gmail.ja.md)

## Bluesky を接続する

Muse の投稿先を選んだら、Worker の **Settings → Variables and Secrets** を開きます。以下の片方または両方を設定してデプロイすると、Worker が5分おきに公式 API を読み取ります。

| 受け取る内容 | Worker に設定する値 | Muse での送信元名 |
| --- | --- | --- |
| 指定アカウントの新しい公開投稿と返信 | `BLUESKY_DID` に対象の DID を設定します。[プロフィール照会](https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=bsky.app) の URL 末尾の `bsky.app` を対象のハンドルに置き換え、結果から `did` をコピーできます。ログインは不要です。 | `bluesky` |
| Bluesky がホストする自分のアカウントへのメンション、いいね、フォローなど | `BLUESKY_IDENTIFIER` に自分のハンドルを設定します。DM へのアクセスを無効にした専用のアプリパスワードを作成し、Worker の Secret `BLUESKY_APP_PASSWORD` に保存します。[アプリパスワードの作成](https://bsky.app/settings/app-passwords) | `bluesky-notifications` |

各アカウントの初回取得で開始位置を記録します。動作確認はその後に、新しく公開投稿するか、別のアカウントからメンションを送ってください。次の取得後に選択したサイドチャットで確認できます。1回に取得するのは各送信元につき最大10件で、続きは次回以降に取得します。通知を取得しても Bluesky 上の既読状態は変わりません。[公開投稿の API](https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/feed/getAuthorFeed.json) · [アカウント通知の API](https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/notification/listNotifications.json)

## Discord を接続する

Worker が Discord サーバーのテキストチャンネルを 1 つ、5 分ごとに確認します。初回はその時点の最新メッセージを記録し、次回から新着を毎回最大 10 件、古い順に読み取ります。通常のメッセージと返信について、投稿者、本文の先頭 2,000 文字、添付ファイルの名前・サイズ・種類が Muse に届きます。

1. Discord Developer Portal でアプリを作成し、**Bot** で **Message Content Intent** を有効にします。認証済みアプリにはこの権限の承認が必要です。Bot トークンをコピーし、Worker の Secret `DISCORD_BOT_TOKEN` に保存します。[メッセージ本文へのアクセス](https://docs.discord.com/developers/events/gateway#message-content-intent)
2. **Installation** の **Guild Install** に `bot` スコープを設定し、インストールリンクから Bot をサーバーに追加します。対象チャンネルで Bot に **チャンネルを見る** と **メッセージ履歴を読む** 権限を付与します。そのチャンネルに投稿できる人の発言が、選択した Muse チャットに届きます。[Discord アプリのインストール](https://docs.discord.com/developers/resources/application#installation-context)・[チャンネル履歴の権限](https://docs.discord.com/developers/resources/message#get-channel-messages)
3. Discord の **ユーザー設定 → 詳細設定 → 開発者モード** を有効にします。対象チャンネルを右クリックし、**チャンネル ID をコピー** します。Worker の `DISCORD_CHANNEL_ID` にその ID を設定してデプロイします。初回の定期確認が終わってからメッセージを送り、次の確認後に Muse を開きます。MCP の送信元名は `discord`、イベント種別は `message` です。対象チャンネルを変更すると、新しいチャンネルの最新位置から開始します。

## 投稿先を切り替える

管理用コネクタに別の登録名とセッション ID を伝え、「そのチャットを通知先にして」と頼みます。投稿先が未設定なら最初の登録が自動で選ばれます。切り替えは次に受け付ける通知から有効です。配信待ちや再送の通知には、受付時の投稿先を使います。既存の構成で `MUSE_SESSION_ID` を設定済みなら、そのチャットを `default` として引き継ぎます。

`MCP_TOKEN` を使う閲覧用コネクタでは、登録済みチャットや配信状態を確認できます。管理用コネクタでは通知元の一時停止やイベント種別の絞り込みもできます。CLI でのセットアップ、Webhook の形式、配信の調査については[運用ガイド](docs/operations.ja.md)を参照してください。
