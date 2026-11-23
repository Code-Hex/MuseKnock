# 通知の運用とカスタマイズ

[English](operations.md) · **日本語** · [简体中文](operations.zh-CN.md)

## 初回の端末認証

Worker 専用の端末 ID を1つ用意してください。自分の SDK トークンは [Muse Gadgets](https://gadgets.muse.ai/) の **Account → SDK tokens** で取得できます。

- **公式のペアリング。** 専用のガジェットを Muse アプリでペアリングし、SDK デーモンを停止してから `pairing.json` の最新値を確認します。Linux SDK の標準の保存先は `/var/lib/musegadget/` です。`node_id`、`refresh_token`、ペアリングに使った SDK トークンを用意します。[公式のペアリング手順](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md#install)
- **ブラウザからコミュニティ版で認証。** ペアリング済み機器がなく、サードパーティ製ツールでのサインインを選ぶ場合は、自分専用の GitHub Codespace で Muse Desktop Bridge リポジトリを開きます。ブラウザ内の端末で `git checkout 3b6d0e0665d40d5537b21b701c18327e288741d9`、続いて `python3 muse-auth/muse_auth.py setup` を実行します。自分のアカウントでワンタイムコードや二要素認証などの手順を完了し、SDK トークンを入力します。Muse から本人確認を求められた場合は Muse アプリが必要になることがあります。Codespaces 上での実アカウント認証は未検証です。[コミュニティ版の認証手順](https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/3b6d0e0665d40d5537b21b701c18327e288741d9/muse-auth/README.md) · [Muse Desktop Bridge の Codespace を開く](https://codespaces.new/chaitanyarahalkar/muse-desktop-bridge) · [GitHub Codespaces の手順](https://docs.github.com/en/codespaces/developing-in-a-codespace/creating-a-codespace-for-a-repository)

コミュニティ版を使った場合は、自分専用の Codespace のエディターで `muse-auth/.state/state.json` を開き、`sdk_token`、`device.device_id`、`device.refresh_token` の3項目だけを Cloudflare のデプロイ画面の対応するシークレット欄に転記します。ファイル本体とアカウントのセッション情報は Codespace 内に留めます。端末情報を引き渡したら Codespace は削除できます。[デプロイの手順](../README.ja.md#クイックスタート)

初回デプロイで必要な Worker シークレットは5つです。`MCP_ADMIN_TOKEN` にはランダムな管理用トークン、`CREDENTIAL_ENCRYPTION_KEY` には別に生成した32バイトの乱数（16進数64桁）を設定します。端末情報は `MUSE_NODE_ID`、`MUSE_SDK_TOKEN`、`MUSE_REFRESH_TOKEN` の3つをまとめて Cloudflare に入力します。管理用コネクタの設定には Worker の `/mcp` URL と既存のサイドチャットのセッション ID も使います。

管理用コネクタでサイドチャットを登録し、テスト通知がそのチャットに届いたことを確認します。その後、1回のデプロイで端末のシークレット3つをまとめて削除できます。`MCP_ADMIN_TOKEN` と元の `CREDENTIAL_ENCRYPTION_KEY` は残してください。次回起動時は Durable Object に保存した暗号化済みのペアリングを使います。端末の3項目を一部だけ残すと、3項目をそろえるかすべて削除するまで配信が停止します。

`/v1/hooks/custom` を使うショートカットや自動化には、専用のランダムな Worker シークレット `HOOK_TOKEN` を追加します。閲覧専用 MCP コネクタを使う場合は、別のランダムな値を `MCP_TOKEN` に設定します。

## 届かない通知を調べる

Muse に「受付 ID … の配信状態を調べて」と頼みます。コネクタを設定する前でも、元と同じ `Idempotency-Key` で Webhook を再送すれば状態を確認できます。

| 状態 | 意味と確認先 |
| --- | --- |
| `queued` | Worker の配信待ちです。保存済みのペアリング、端末認証の有効性、端末に貸与済みの VM を確認してください。 |
| `sending` | Worker がイベントの配信を開始し、接続または投稿中です。 |
| `sent` | Muse が投稿に受付応答を返しました。Worker が通知を受け付けた時点の投稿先を開いてください。 |
| `suppressed` | 通知元のルール、メッセージの取り消し、ブレーカーなどで配信を抑止しました。`message_retracted` は配信前に Slack または X の投稿が削除されたか、LINE のメッセージが取り消されたことを示します。受付情報の `reason` が `source_open` ならその通知元が上限に達し、`circuit_open` なら全体の上限に達しています。 Worker は投稿直前にチャットの存在を確認します。`side_chat_missing` は Muse が 404 を返したことを示します。新着通知を再開するには、MCP で既存のチャットを選択してください。抑止済みの通知は再送されません。 |
| `expired` | 受付から1時間が経ち、配信待ちの期限が切れました。 |
| `unknown` | 送信後に結果を確認できなかったか、配信許可が2分で期限切れになりました。新しい通知を送る前にサイドチャットを確認してください。 |

投稿前に失敗した通知が再試行を待つ間も、ほかのチャットには配信できます。すでに Muse に届いた可能性があれば `unknown` として保留します。受付応答が失われた際の二重投稿を防ぐためです。[Gadget SDK の投稿経路](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/link_client.py)

通知の宛先は、受付時のペアリング・VM・セッション ID で決まります。ペアリングや VM の設定変更で配信が保留された場合は、期限内に元の設定へ戻すと配信を再開します。新しくペアリングしたら MCP から宛先を登録してください。

## 認証情報の暗号鍵を復元する

Worker は Muse の端末トークンと Bluesky のセッションを AES-256-GCM で暗号化して保存します。`CREDENTIAL_ENCRYPTION_KEY` をパスワードマネージャーに控え、同じ Worker を再デプロイするときは元の鍵を使ってください。`get_setup_status` で `credentialStorageReady` が `false` の場合は、Worker のシークレットを確認し、控えておいた鍵を復元してください。元の鍵を紛失した場合、その鍵で暗号化した情報は復号できません。新しいストレージを使う Worker をデプロイし、新しく認証した端末情報で初回設定を行ってください。

## 端末認証を更新する

Muse がペアリングを失効させたら、専用の端末を再認証し、新しい端末情報3つをまとめて設定してデプロイします。新しいペアリングで投稿先を登録し、テスト通知が届いたら3項目をまとめて削除できます。Durable Object を新設した場合も初回設定が必要です。同じ端末 ID を使う Worker や SDK デーモンは同時に動かさないでください。

Worker は標準の端末 API `api.muse.ai` と暗号化された Link ゲートウェイ `hatch.metaaivm.com` を使用します。`MUSE_VM_ID` を指定した場合は、その VM が端末に貸与されていることを確認してください。指定がなければ、登録時に既定の VM を選び、既定がなければ一覧の先頭を使います。登録済みの名前を選び直すと、登録時の VM でチャットを確認します。現在の既定 VM に移すには、同じ名前とセッション ID で `register_side_chat` を呼び出してください。[Gadget SDK の端末 API](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/muse_api.py)

## Webhook の送信仕様

`POST /v1/hooks/custom` に `HOOK_TOKEN` を Bearer トークンとして送ります。MCP で一時停止やフィルターを設定するときの送信元名は `custom` です。

| 入力 | 処理 |
| --- | --- |
| `application/json` または `+json` | JSON の構文を検証し、整数や空白を含めて原文を届けます。 |
| `text/plain` または Content-Type なし | テキストを届けます。 |
| `application/x-www-form-urlencoded` | 重複するフィールドを保持するため、名前と値の組の配列に変換します。 |
| `X-Event-Type` | フィルターで照合する種別です。省略時は `notification` です。送信元・種別は小文字英数字で始まる1〜64文字で、残りには `_` と `-` も使えます。 |
| `Idempotency-Key` | 送信元内で一意のイベント識別子です。空白を除く印字可能な ASCII 文字で最大128文字です。省略すると POST ごとに新規受付になります。 |

本文と変換後のテキストはそれぞれ最大32 KiB です。本文には Muse へ渡す情報だけを含めてください。新しいイベントを受け付けた時点で、Worker はそのとき選択されていた投稿先を記録します。

サービス別のエンドポイントでは、リクエスト本文の上限は 512 KiB、取り出した通知テキストの上限は 1 件あたり 32 KiB です。応答にはサービス固有の形式を使います。MCP で一時停止や絞り込みを指定する際は URL にある送信元名（例 `telegram`）とイベント種別（例 `edited_message`）を使います。[サービス別の設定](../README.ja.md#サービスを直接接続する)

受付は送信元ごとに直近60秒で10件までです。超過時は HTTP `429` と `Retry-After: 60` を返します。配信の許可は全送信元を合わせて60秒に3回、同時に1件までです。再試行もこの枠を使います。重複判定と受付 ID の参照期間は受付から7日間です。期限の反映と履歴の削除は次のストア操作時に行います。しきい値は `src/store.ts` にあります。

## 送信元と本文形式を追加する

`src/index.ts` の `registerWebhook` に送信元名、認証を含む Hono ミドルウェアの配列、本文を読む関数を渡します。たとえば CI の通知からジョブ名だけを送るには、`WorkerEnv` の `Bindings` に `CI_HOOK_TOKEN` を追加して専用のランダムな値を Worker のシークレットに設定し、次のルートを登録します。

```ts
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

const build = z.object({ job: z.string().min(1).max(128) })

registerWebhook(app, 'ci', [
  bearerAuth({ verifyToken: (token, c) => matches(token, c.env.CI_HOOK_TOKEN) }),
], async request => {
  const result = build.safeParse(await request.json().catch(() => null))
  if (!result.success) throw new HTTPException(400, { message: 'Expected a job name' })
  return result.data.job
})
```

再デプロイ後は `POST /v1/hooks/ci` に通知できます。送信元独自の署名検証は、この配列のミドルウェアで変換前の `c.req.raw.clone()` を読みます。認証後に独自のレート制限やフィルターを追加できます。拠点共通の配信上限は Durable Object が適用します。[Hono ミドルウェア](https://hono.dev/docs/guides/middleware) · [Durable Object の SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## MCP ツール

| ツール | 引数 | 権限 |
| --- | --- | --- |
| `get_setup_status` | Worker 内の設定から `deviceConfigured`、`credentialStorageReady`、`active`、`ready` を返します。 | 閲覧 |
| `send_test_notification` | `requestId`（UUID）。選択中の投稿先に固定文のテスト通知を登録し、受付 ID を返します。通知元は `museknock-test`、イベント種別は `test` です。 | 管理 |
| `list_side_chats` | MuseKnock の登録名とセッション ID の一覧、選択中の投稿先を返します。 | 閲覧 |
| `register_side_chat` | `name` と `sessionId` を登録・更新します。投稿先が未設定なら最初の登録を選びます。 | 管理 |
| `set_active_side_chat` | `name` で登録済みのチャットを選び、次の通知から適用します。 | 管理 |
| `list_sources` | なし。受領履歴または配信ルールのある送信元を返します。 | 読み取り |
| `get_delivery_status` | `id`（受付 ID）。本文は含みません。 | 読み取り |
| `get_delivery_breaker` | 全体の残り枠と通知元別の試行数を返します。 | 読み取り |
| `rearm_delivery_breaker` | `expectedGeneration`。いずれかの上限に達し、送信中の試行が終了した後で両方の枠をリセットします。 | 復旧 |
| `set_source_paused` | `source`、`paused`（真偽値） | 管理 |
| `set_event_filter` | `source`、`types`（許可する種別の配列）。空配列は全種別を許可します。 | 管理 |

登録名は前後の空白を除いて1〜64文字で、大文字と小文字を区別します。先頭は Unicode の文字または数字、以降は文字・数字・結合文字・半角スペース・ピリオド・アンダースコア・ハイフンを使えます。セッション ID は大文字と小文字を区別し、1〜64文字の半角英数字とハイフンが使えます。登録・切替時は投稿せずに Muse に問い合わせ、指定したセッションの存在を確認します。既存のチャットを使うには、ガジェットが投稿に使ったセッション ID を指定してください。ペアリングを読み込めない場合や投稿先が未設定の場合、認証済みの通知リクエストは HTTP `503` を返します。

Webhook や MCP のトークンを更新するときは、Cloudflare で該当する Worker シークレットを変更してデプロイします。その値を使う送信元やコネクタにも新しいトークンを設定してください。

## SDK との互換性を検証する

Muse Gadget SDK のコミット `e17081a45941415d483642dbe21c2a2e6ef85a13` をチェックアウトし、Python 仮想環境に `linux[test]` パッケージをインストールします。`MUSE_PYTHON` にその環境の Python 実行ファイル、`MUSE_SDK_TESTS` に SDK の `linux/tests` ディレクトリの絶対パスを指定します。`npm test` を実行すると、テスト用の認証情報で Webhook の受付から Worker 経由で SDK のテストサーバーに届くまでをローカルで検証できます。

## CLI でセットアップする場合

Node.js 22.12 以降で `npm ci`、`npm run setup -- --pairing /path/to/pairing.json` を実行します。コミュニティ版は代わりに `--device-state /path/to/state.json` を使います。生成された `.dev.vars` で端末の認証情報を補います。スクリプトはカスタム Webhook と閲覧専用 MCP のトークンも個別に生成します。新規の Worker では生成された `CREDENTIAL_ENCRYPTION_KEY` をパスワードマネージャーに保管します。既存の Worker をデプロイする場合は元の鍵を使ってください。`npx wrangler login` の後に `npm run deploy:local` を実行すると、この設定をアップロードできます。デプロイ後に MCP から投稿先を登録してください。検証には `npm test`、`npm run check`、`npm run deploy -- --dry-run` を使います。`npm run dev` で実際に投稿するときは別の端末 ID を使用してください。実際の Muse アカウントへの投稿は未検証です。

Cloudflare で端末の3項目を削除した場合は、次回ローカルからデプロイする前に `.dev.vars` からもその3項目を削除してください。
