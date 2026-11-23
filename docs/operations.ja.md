# 通知の運用とカスタマイズ

[English](operations.md) · **日本語** · [简体中文](operations.zh-CN.md)

## 届かない通知を調べる

Muse に「受付 ID … の配信状態を調べて」と頼みます。コネクタを設定する前でも、元と同じ `Idempotency-Key` で Webhook を再送すれば状態を確認できます。

| 状態 | 意味と確認先 |
| --- | --- |
| `queued` | Worker の配信待ちです。Muse の Secrets、端末認証の有効性、端末に貸与済みの VM があることを確認してください。 |
| `sending` | Worker がイベントの配信を開始し、接続または投稿中です。 |
| `sent` | Muse が投稿に受付応答を返しました。`MUSE_SESSION_ID` のサイドチャットで投稿と Muse の返答を確認できます。 |
| `suppressed` | 停止中、または許可した種別の対象外です。この通知の配信は終了しました。 |
| `expired` | 受付から1時間が経ち、配信待ちの期限が切れました。 |
| `unknown` | 送信後に結果を確認できなかったか、配信許可が2分で期限切れになりました。新しい通知を送る前にサイドチャットを確認してください。 |

投稿前と確定できた失敗は、配信上限と有効期限の範囲で再試行します。すでに Muse に届いた可能性があれば `unknown` として保留します。受付応答が失われた際の二重投稿を防ぐためです。[Gadget SDK の投稿経路](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/link_client.py)

## 端末認証を更新する

移行後は Worker が更新した端末認証情報を Durable Object に保存します。この ID は他の executor、ローカル開発環境、別の Worker と共有しないでください。Muse がペアリングを失効させた場合は、改めて端末を認証し、最新の状態を取り込んだうえで初期認証情報を再デプロイします。同じサイドチャットに投稿するには `MUSE_SESSION_ID` を引き継ぎます。

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

本文と変換後のテキストはそれぞれ最大32 KiB です。本文には Muse へ渡す情報だけを含めてください。投稿先のセッション ID と認証情報は Worker の設定に従います。

受付は送信元ごとに直近60秒で10件までです。超過時は HTTP `429` と `Retry-After: 60` を返します。配信の許可は全送信元を合わせて60秒に3回、同時に1件までです。再試行もこの枠を使います。重複判定と受付 ID の参照期間は受付から7日間です。期限の反映と履歴の削除は次のストア操作時に行います。しきい値は `src/store.ts` にあります。

## 送信元と本文形式を追加する

`src/index.ts` の `registerWebhook` に送信元名、認証を含む Hono ミドルウェアの配列、本文を読む関数を渡します。たとえば CI の通知からジョブ名だけを送るには、`WorkerEnv` の `Bindings` と `.dev.vars` に専用の乱数値 `CI_HOOK_TOKEN` を追加し、次のルートを登録します。

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
| `list_sources` | なし。受領履歴または配信ルールのある送信元を返します。 | 読み取り |
| `get_delivery_status` | `id`（受付 ID）。本文は含みません。 | 読み取り |
| `set_source_paused` | `source`、`paused`（真偽値） | 管理 |
| `set_event_filter` | `source`、`types`（許可する種別の配列）。空配列は全種別を許可します。 | 管理 |

Webhook や MCP のトークンを更新するときは `.dev.vars` の該当する値を変更し、`npm run deploy` を実行します。その値を使う送信元やコネクタにも新しいトークンを設定してください。

## SDK との互換性を検証する

Muse Gadget SDK のコミット `e17081a45941415d483642dbe21c2a2e6ef85a13` をチェックアウトし、Python 仮想環境に `linux[test]` パッケージをインストールします。`MUSE_PYTHON` にその環境の Python 実行ファイル、`MUSE_SDK_TESTS` に SDK の `linux/tests` ディレクトリの絶対パスを指定します。`npm test` を実行すると、テスト用の認証情報で Webhook の受付から Worker 経由で SDK のテストサーバーに届くまでをローカルで検証できます。
