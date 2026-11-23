# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock は Cloudflare Workers で Webhook を受け取り、既存の Muse サイドチャットに通知を届けます。投稿先は Muse の MCP コネクタから選べます。パソコンの電源を切っても Worker が配信を続けます。

[クイックスタート](#クイックスタート) · [English](README.md) · **日本語** · [简体中文](README.zh-CN.md)

## クイックスタート

Cloudflare と GitHub のアカウント、認証済みの Muse 端末情報、ガジェットが既存のチャットで使っているセッション ID を用意します。SDK トークンは自分の Muse アカウントでの個人・非商用利用が対象です。[初回の端末認証](docs/operations.ja.md#初回の端末認証)・[SDK トークンの利用条件](https://gadgets.muse.ai/sdk-terms)

**1. Cloudflare からデプロイします。** 上の **Deploy to Cloudflare** を押し、Worker 名を選び、デプロイ画面の Worker シークレット欄に次の6項目を入力します。最初の3項目にはパスワードマネージャーで生成した、十分長いランダムな英数字をそれぞれ別に使います。[Cloudflare のデプロイボタンの仕様](https://developers.cloudflare.com/workers/platform/deploy-buttons/#worker-environment-variables-and-secrets)

| シークレット | 設定する値 |
| --- | --- |
| `HOOK_TOKEN` | Webhook 送信元用のトークン |
| `MCP_TOKEN` | Muse の閲覧用コネクタのトークン |
| `MCP_ADMIN_TOKEN` | 投稿先の設定やテスト送信に使う Muse の管理用トークン |
| `MUSE_NODE_ID` | 公式の `pairing.json` なら `node_id`、コミュニティ版の `state.json` なら `device.device_id` |
| `MUSE_REFRESH_TOKEN` | 公式なら `refresh_token`、コミュニティ版なら `device.refresh_token` |
| `MUSE_SDK_TOKEN` | 公式ならペアリングに使った SDK トークン、コミュニティ版なら `sdk_token` |

引き渡し後は Worker が端末の認証情報を更新します。同じ端末 ID を使う executor や SDK デーモンが稼働中なら、事前に停止して自動起動を解除します。Cloudflare に転記する端末情報は表の3項目だけです。元のファイルとアカウントの認証情報は手元で保管してください。Worker をデプロイしたら、表示された HTTPS URL をコピーします。

**2. Muse にコネクタを追加します。** Muse の **Settings → Connectors** でカスタムコネクタを1つ追加します。デプロイ先の URL の末尾に `/mcp` を付け、認証方式に Bearer を選び、トークン欄に `MCP_ADMIN_TOKEN` を入力します。[Muse コネクタの設定手順](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

**3. Muse に投稿先の登録とテストを頼みます。** 次の順に依頼してください。

1. 「MuseKnock の設定を確認して」。`get_setup_status` は Worker 内の設定を確認します。実際に届くかはテスト投稿で確かめます。
2. 「既存のセッション `既存のセッションID` を『ビルド通知』として登録し、通知先にして」。ID にはガジェットの `--session-id`、または旧環境の `MUSE_SESSION_ID` の正確な値を使います。`register_side_chat` が登録する名前は MuseKnock 内のものです。未知の ID を使うと初回の投稿で新しいチャットが作られる場合があります。[Gadget SDK のサイドチャット](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md)
3. 「テスト通知を1件送り、配信状態を確認して」。Muse は新しい UUID を `requestId` として `send_test_notification` を呼び、返った受付 ID を `get_delivery_status` に渡します。`sent` になったら選んだチャットを開きます。同じテストを再試行するときは同じリクエスト ID を使います。

**4. 送信元サービスを接続します。** 送信元の Webhook 設定で、同じ Worker の `/hooks/default` に `POST` を指定します。ヘッダーを `Authorization: Bearer YOUR_HOOK_TOKEN`、`Content-Type: application/json` とし、例えば `{"message":"ビルドが完了しました"}` を送ると受付 ID が返ります。以降は Muse から配信状態の確認、通知元の一時停止、イベント種別の絞り込みができます。

## 投稿先を切り替える

管理用コネクタに別の登録名とセッション ID を伝え、「そのチャットを通知先にして」と頼みます。投稿先が未設定なら最初の登録が自動で選ばれます。切り替えは次に受け付ける通知から有効です。配信待ちや再送の通知には、受付時の投稿先を使います。既存の構成で `MUSE_SESSION_ID` を設定済みなら、そのチャットを `default` として引き継ぎます。

`MCP_TOKEN` を使う閲覧用コネクタでは、登録済みチャットや配信状態を確認できます。管理用コネクタでは通知元の一時停止やイベント種別の絞り込みもできます。CLI でのセットアップ、Webhook の形式、配信の調査については[運用ガイド](docs/operations.ja.md)を参照してください。
