# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock は Cloudflare Workers で Webhook を受け取り、既存の Muse サイドチャットに通知を届けます。投稿先は Muse の MCP コネクタから選べます。パソコンの電源を切っても Worker が配信を続けます。

[クイックスタート](#クイックスタート) · [English](README.md) · **日本語** · [简体中文](README.zh-CN.md)

## クイックスタート

デプロイと設定はブラウザで完結します。Cloudflare と GitHub のアカウント、認証済みの Muse 端末情報、ガジェットが既存のチャットで使っている正確なセッション ID を用意してください。端末をまだ認証していない場合は、[初回の端末認証](docs/operations.ja.md#初回の端末認証)を参照してください。Gadget SDK トークンは自分の Muse アカウントでの個人・非商用利用が対象です。[SDK トークンの利用条件](https://gadgets.muse.ai/sdk-terms)

**1. Worker をデプロイします。** 上の **Deploy to Cloudflare** を押し、Worker 名を選びます。デプロイコマンドは初期値のままで進めてください。発行された Worker の HTTPS URL に `/setup` を付けて開くと、3種類のアクセストークンを生成できます。公式 SDK の `pairing.json` またはコミュニティ版の `state.json` を選ぶと、ブラウザ内で端末情報を読み取ります。ファイルは送信されません。

**2. Worker のシークレットを6個設定します。** Cloudflare の **Workers & Pages → 対象の Worker → Settings → Variables and Secrets** で、下の値をそれぞれ **Secret** として追加し、**Deploy** を押します。3種類のアクセストークンはパスワードマネージャーに保存してください。[Cloudflare のシークレット設定](https://developers.cloudflare.com/workers/configuration/secrets/)

| シークレット | 設定する値 |
| --- | --- |
| `HOOK_TOKEN` | Webhook 送信元専用のランダムなトークン |
| `MCP_TOKEN` | 閲覧用の Muse コネクタ専用のランダムなトークン |
| `MCP_ADMIN_TOKEN` | 投稿先を管理するコネクタ専用のランダムなトークン |
| `MUSE_NODE_ID` | 認証済み端末のノード ID |
| `MUSE_REFRESH_TOKEN` | その端末の現在のリフレッシュトークン |
| `MUSE_SDK_TOKEN` | その端末の認証に使った Gadget SDK トークン。公式のペアリングファイルを使う場合は別途入力します。 |

アクセストークンは、パスワードマネージャーで長いランダムな英数字を3個生成してもかまいません。移行後は Worker が端末トークンを更新します。同じ端末 ID を使う executor や SDK デーモンが稼働中なら、引き渡し前に停止し、自動起動を解除してください。

**3. Muse から既存のチャットを登録します。** **Settings → Connectors** でカスタムコネクタを作り、URL に `https://YOUR-WORKER.workers.dev/mcp`、認証方式に Bearer を指定します。自分の Worker の正確な接続 URL は `/setup` に表示されます。コネクタのトークン欄に `MCP_ADMIN_TOKEN` を入力してください。[Muse コネクタの設定手順](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

Muse に「セッション ID が `既存のセッションID` のサイドチャットを `builds` として登録して。通知先に選んで、現在の投稿先を表示して」と頼みます。セッション ID には、ガジェットが投稿時に `--session-id` に指定した値、または旧 MuseKnock の `MUSE_SESSION_ID` を使います。`builds` は MuseKnock 内の登録名です。会話タイトルからセッション ID を検索する機能はなく、未知の ID に投稿すると新しいチャットが作られる場合があります。[Gadget SDK のサイドチャット](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md)

**4. 通知を送ります。** 送信元サービスの Webhook 設定で、Worker の `/hooks/default` 宛てに `POST` を指定します。ヘッダーは `Authorization: Bearer YOUR_HOOK_TOKEN` と `Content-Type: application/json`、本文は例えば `{"message":"ビルドが完了しました"}` です。テストには `Idempotency-Key: first-knock` を設定してください。HTTP `202` と受付 ID が返ったら、Muse にその ID の配信状態を尋ね、投稿先のチャットを開きます。同じキーで再送すると現在の配信状態が返ります。

## 投稿先を切り替える

管理用コネクタに別の登録名とセッション ID を伝え、「そのチャットを通知先にして」と頼みます。投稿先が未設定なら最初の登録が自動で選ばれます。切り替えは次に受け付ける通知から有効です。配信待ちや再送の通知には、受付時の投稿先を使います。既存の構成で `MUSE_SESSION_ID` を設定済みなら、そのチャットを `default` として引き継ぎます。

`MCP_TOKEN` を使う閲覧用コネクタでは、登録済みチャットや配信状態を確認できます。管理用コネクタでは通知元の一時停止やイベント種別の絞り込みもできます。CLI でのセットアップ、Webhook の形式、配信の調査については[運用ガイド](docs/operations.ja.md)を参照してください。
