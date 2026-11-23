# 通知の運用とカスタマイズ

[English](operations.md) · **日本語** · [简体中文](operations.zh-CN.md)

## 届かない通知を調べる

Muse に「受付 ID … の配信状態を調べて」と頼みます。コネクタを設定する前でも、元と同じ `Idempotency-Key` で Webhook を再送すれば状態を確認できます。

| 状態 | 意味と確認先 |
| --- | --- |
| `queued` | 配信待ちです。ブリッジの起動、`WORKER_URL`、executor と Muse の接続を確認してください。 |
| `sending` | ブリッジが投稿を試みています。 |
| `sent` | Gadget SDK が投稿受付を返しました。Muse の応答はアプリで確認できます。投稿先は `.env.bridge` の `MUSE_SESSION_ID` です。 |
| `suppressed` | 停止中、または許可した種別の対象外です。この通知の配信は終了しました。 |
| `expired` | 受付から1時間が経ち、配信待ちの期限が切れました。 |
| `unknown` | 送信後の切断や、配信許可から2分以内に結果が戻らなかった場合です。サイドチャットの履歴を確認してから、新しい通知を送るか判断してください。 |

SDK への書き込み前に接続が失敗した場合や、SDK が Muse への未接続を明示した場合は、最新のルールと有効期限に従って再試行します。`unknown` の自動再送は行いません。Gadget SDK の送信操作には、同じ投稿を識別する再送キーがありません。[SDK のローカル送信経路](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/service.py#L277-L302)

ソケットが見つからない場合、macOS では Muse Desktop Bridge のディレクトリで `./muse-executor/muse-executor status` を実行します。Linux では `sudo musegadget doctor` でデーモンとユーザーを確認します。既定のソケットは macOS が `~/muse-desktop-bridge/muse-executor/.runtime/muse.sock`、Linux が `/run/musegadget/musegadget.sock` です。場所を変更した場合は `.env.bridge` の `MUSEGADGET_SOCKET` に絶対パスを指定します。executor と MuseKnock のブリッジの両方を動かしておいてください。

## Linux の再起動後も配信する

systemd のユーザーサービスとして登録できます。手順は、SDK のソケットを使えるユーザーで実行します。先に `.env.bridge` の `WORKER_URL` を本番 URL に設定し、手動起動したブリッジを Ctrl+C で終了してください。

プロジェクトのディレクトリで次を実行すると、現在のディレクトリと Node.js の場所がユニットに入ります。

```sh
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/museknock.service <<EOF
[Unit]
Description=MuseKnock bridge

[Service]
WorkingDirectory=$(pwd -P)
ExecStart="$(node -p 'process.execPath')" --env-file=.env.bridge --import tsx bridge/main.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now museknock.service
systemctl --user status museknock.service
```

ログは `journalctl --user -u museknock.service -f` で確認できます。ログイン前から起動するには、Linux の管理者が `loginctl enable-linger ユーザー名` を実行します。停止と自動起動の解除は `systemctl --user disable --now museknock.service` です。

## Webhook の送信仕様

標準の送信先は `POST /hooks/default` です。`HOOK_TOKEN` で Bearer 認証します。

| 入力 | 処理 |
| --- | --- |
| `application/json` または `+json` | JSON の構文を検証し、整数や空白を含めて原文を届けます。 |
| `text/plain` または Content-Type なし | テキストを届けます。 |
| `application/x-www-form-urlencoded` | 重複するフィールドを保持するため、名前と値の組の配列に変換します。 |
| `X-Event-Type` | フィルターで照合する種別です。省略時は `notification` です。送信元・種別は小文字英数字で始まる1〜64文字で、残りには `_` と `-` も使えます。 |
| `Idempotency-Key` | 送信元内で一意のイベント識別子です。空白を除く印字可能な ASCII 文字で最大128文字です。省略すると POST ごとに新規受付になります。 |

本文と変換後のテキストはそれぞれ最大32 KiB です。本文には Muse へ渡す情報だけを含めてください。Webhook の本文が投稿先のセッション ID や認証情報を変更することはありません。

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

Worker の認証情報を更新するときは `.dev.vars` を編集して `npm run deploy` を実行します。変更したトークンを使う送信元・ブリッジ・コネクタにも新しい値を設定してください。
