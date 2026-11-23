# 通知の運用とカスタマイズ

[English](operations.md) · **日本語** · [简体中文](operations.zh-CN.md)

## 初回の端末認証

認証済み端末の最新情報が手元にあれば、[ブラウザでのセットアップ](../README.ja.md#クイックスタート)に進みます。この端末 ID は Worker 専用にしてください。自分の SDK トークンは [Muse Gadgets](https://gadgets.muse.ai/) の **Account → SDK tokens** で取得できます。

- **公式のペアリング。** 専用のガジェットを Muse アプリでペアリングします。SDK デーモンを停止してから、自分の Worker の `/setup` でその端末の `pairing.json` を選びます。Linux SDK の標準の保存先は `/var/lib/musegadget/` です。ペアリングに使った SDK トークンは別途入力します。[公式のペアリング手順](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md#install)
- **ブラウザからコミュニティ版で認証。** ペアリング済み機器がなく、サードパーティ製ツールでのサインインを選ぶ場合は、自分専用の GitHub Codespace で Muse Desktop Bridge リポジトリを開きます。ブラウザ内の端末で `git checkout 3b6d0e0665d40d5537b21b701c18327e288741d9`、続いて `python3 muse-auth/muse_auth.py setup` を実行します。自分のアカウントでワンタイムコードや二要素認証などの手順を完了し、SDK トークンを入力します。Muse から本人確認を求められた場合は Muse アプリが必要になることがあります。Codespaces 上での実アカウント認証は未検証です。[コミュニティ版の認証手順](https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/3b6d0e0665d40d5537b21b701c18327e288741d9/muse-auth/README.md) · [Muse Desktop Bridge の Codespace を開く](https://codespaces.new/chaitanyarahalkar/muse-desktop-bridge) · [GitHub Codespaces の手順](https://docs.github.com/en/codespaces/developing-in-a-codespace/creating-a-codespace-for-a-repository)

Codespace を使った場合は、ダウンロードの前に同じブラウザ内の端末で次のコマンドを実行します。端末情報の3項目だけが、所有者専用のファイルに保存されます。

```sh
python3 - <<'PYTHON'
import json, os, tempfile
from pathlib import Path

directory = Path("muse-auth/.state")
state = json.loads((directory / "state.json").read_text())
device = {key: state["device"][key] for key in ("device_id", "refresh_token")}
with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as out:
    json.dump({"sdk_token": state["sdk_token"], "device": device}, out)
os.replace(out.name, directory / "museknock-device.json")
PYTHON
```

ブラウザのファイル一覧から `muse-auth/.state/museknock-device.json` をダウンロードし、自分の Worker の `/setup` で選びます。このファイルは非公開で保管してください。元のアカウント認証情報は Codespace 内に残ります。端末情報の移行後、Codespace は削除できます。

公式の端末ペアリングには Muse アプリを使います。Deploy to Cloudflare ボタンで作成するのは Worker で、端末の認証は Muse 側で行います。


## 届かない通知を調べる

Muse に「受付 ID … の配信状態を調べて」と頼みます。コネクタを設定する前でも、元と同じ `Idempotency-Key` で Webhook を再送すれば状態を確認できます。

| 状態 | 意味と確認先 |
| --- | --- |
| `queued` | Worker の配信待ちです。Muse の Secrets、端末認証の有効性、端末に貸与済みの VM があることを確認してください。 |
| `sending` | Worker がイベントの配信を開始し、接続または投稿中です。 |
| `sent` | Muse が投稿に受付応答を返しました。Worker が通知を受け付けた時点の投稿先を開いてください。 |
| `suppressed` | 停止中、または許可した種別の対象外です。この通知の配信は終了しました。 |
| `expired` | 受付から1時間が経ち、配信待ちの期限が切れました。 |
| `unknown` | 送信後に結果を確認できなかったか、配信許可が2分で期限切れになりました。新しい通知を送る前にサイドチャットを確認してください。 |

投稿前と確定できた失敗は、配信上限と有効期限の範囲で再試行します。すでに Muse に届いた可能性があれば `unknown` として保留します。受付応答が失われた際の二重投稿を防ぐためです。[Gadget SDK の投稿経路](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/link_client.py)

## 端末認証を更新する

移行後は Worker が更新した端末認証情報を Durable Object に保存します。この ID は他の executor、ローカル開発環境、別の Worker と共有しないでください。Muse がペアリングを失効させた場合は、改めて端末を認証し、最新の状態を取り込んだうえで初期認証情報を再デプロイします。投稿先の登録は Durable Object に残ります。

Worker は標準の端末 API `api.muse.ai` と暗号化された Link ゲートウェイ `hatch.metaaivm.com` を使用します。`MUSE_VM_ID` を指定した場合は、その VM が端末に貸与されていることを確認してください。指定がなければ既定の貸与済み VM を選び、既定がなければ一覧の先頭を使います。[Gadget SDK の端末 API](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/muse_api.py)

## Webhook の送信仕様

標準の送信先は `POST /hooks/default` です。`HOOK_TOKEN` で Bearer 認証します。

| 入力 | 処理 |
| --- | --- |
| `application/json` または `+json` | JSON の構文を検証し、整数や空白を含めて原文を届けます。 |
| `text/plain` または Content-Type なし | テキストを届けます。 |
| `application/x-www-form-urlencoded` | 重複するフィールドを保持するため、名前と値の組の配列に変換します。 |
| `X-Event-Type` | フィルターで照合する種別です。省略時は `notification` です。送信元・種別は小文字英数字で始まる1〜64文字で、残りには `_` と `-` も使えます。 |
| `Idempotency-Key` | 送信元内で一意のイベント識別子です。空白を除く印字可能な ASCII 文字で最大128文字です。省略すると POST ごとに新規受付になります。 |

本文と変換後のテキストはそれぞれ最大32 KiB です。本文には Muse へ渡す情報だけを含めてください。新しいイベントを受け付けた時点で、Worker はそのとき選択されていた投稿先を記録します。

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

再デプロイ後は `POST /hooks/ci` に通知できます。送信元独自の署名検証は、この配列のミドルウェアで変換前の `c.req.raw.clone()` を読みます。認証後に独自のレート制限やフィルターを追加できます。拠点共通の配信上限は Durable Object が適用します。[Hono ミドルウェア](https://hono.dev/docs/guides/middleware) · [Durable Object の SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## MCP ツール

| ツール | 引数 | 権限 |
| --- | --- | --- |
| `list_side_chats` | MuseKnock の登録名とセッション ID の一覧、選択中の投稿先を返します。 | 閲覧 |
| `register_side_chat` | `name` と `sessionId` を登録・更新します。投稿先が未設定なら最初の登録を選びます。 | 管理 |
| `set_active_side_chat` | `name` で登録済みのチャットを選び、次の通知から適用します。 | 管理 |
| `list_sources` | なし。受領履歴または配信ルールのある送信元を返します。 | 読み取り |
| `get_delivery_status` | `id`（受付 ID）。本文は含みません。 | 読み取り |
| `set_source_paused` | `source`、`paused`（真偽値） | 管理 |
| `set_event_filter` | `source`、`types`（許可する種別の配列）。空配列は全種別を許可します。 | 管理 |

登録名は1〜64文字で、英小文字または数字で始め、以降は英小文字・数字・アンダースコア・ハイフンを使えます。セッション ID は大文字と小文字を区別し、1〜64文字の半角英数字とハイフンが使えます。登録処理は指定された ID を保存し、テスト投稿は行いません。既存のチャットを使うには、ガジェットが投稿に使ったセッション ID を指定してください。旧設定の有効な `MUSE_SESSION_ID` は `default` として引き継ぎます。端末のシークレットまたは投稿先が未設定のとき、認証済み Webhook は HTTP `503` を返します。

Webhook や MCP のトークンを更新するときは、Cloudflare で該当する Worker シークレットを変更してデプロイします。その値を使う送信元やコネクタにも新しいトークンを設定してください。

## SDK との互換性を検証する

Muse Gadget SDK のコミット `e17081a45941415d483642dbe21c2a2e6ef85a13` をチェックアウトし、Python 仮想環境に `linux[test]` パッケージをインストールします。`MUSE_PYTHON` にその環境の Python 実行ファイル、`MUSE_SDK_TESTS` に SDK の `linux/tests` ディレクトリの絶対パスを指定します。`npm test` を実行すると、テスト用の認証情報で Webhook の受付から Worker 経由で SDK のテストサーバーに届くまでをローカルで検証できます。

## CLI でセットアップする場合

Node.js 22.12 以降で `npm ci`、`npm run setup -- --pairing /path/to/pairing.json` を実行します。コミュニティ版は代わりに `--device-state /path/to/state.json` を使います。生成された `.dev.vars` で端末の認証情報を補います。既存のチャットを使う場合、生成済みの `MUSE_SESSION_ID` はそのチャットの ID に変更するか、設定から外して MCP から登録してください。`npx wrangler login` の後に `npm run deploy:local` を実行すると、この設定をアップロードできます。検証には `npm test`、`npm run check`、`npm run deploy -- --dry-run` を使います。`npm run dev` で実際に投稿するときは別の端末 ID を使用してください。実際の Muse アカウントへの投稿は未検証です。
