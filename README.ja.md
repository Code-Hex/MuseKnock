# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock は外部 Webhook を Cloudflare Worker で受け取り、自分の Muse のサイドチャットへ直接届けます。Worker が通知を保存し、配信ルールを確認して Gadget プロトコルで投稿します。デプロイ後は設定に使ったパソコンを停止できます。

[クイックスタート](#クイックスタート) · [English](README.md) · **日本語** · [简体中文](README.zh-CN.md)

```text
外部サービス ──Webhook──▶ Worker + Durable Object ──Gadget Link──▶ Muse サイドチャット
Muse ──MCP──▶ Worker（配信停止・フィルター・状態の確認）
```

## クイックスタート

Cloudflare アカウント、自分の Muse アカウント、Gadget SDK トークンを用意します。初回設定には Node.js 22.12 以降と npm を使います。SDK トークンは自分の Muse アカウントでの個人・非商用利用が対象です。[SDK トークンの利用条件](https://gadgets.muse.ai/sdk-terms)

**1. Worker 専用の端末 ID を一度だけ認証します。** 次のどちらかを選んでください。移行後は Worker がこの端末の認証情報を更新します。同じ ID を使う executor や SDK デーモンがある場合は、認証情報を取り込む前に停止し、自動起動も解除します。

- **Bluetooth 機器を使わない場合。** Mac ではコミュニティ製の Muse Desktop Bridge でサインインできます。自分のアカウントと SDK トークンを使って認証し、executor を起動する前に手順を終えます。次の手順でローカルの状態ファイルから端末の認証情報を取り込みます。[コミュニティ版のサインイン手順](https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/3b6d0e0665d40d5537b21b701c18327e288741d9/muse-auth/README.md)
- **公式 Gadget SDK を使う場合。** 専用のガジェットを Muse アプリとペアリングし、SDK デーモンを停止します。その端末の `pairing.json` を用意してください。Linux SDK の標準の保存先は `/var/lib/musegadget/` です。[公式のペアリング手順](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md#install)

**2. Worker の設定を作ります。** MuseKnock をクローンして、プロジェクトのルートで `npm ci` を実行します。次のうち認証方法に合うコマンドを実行してください。パスは自分のファイルの絶対パスに置き換えます。

```sh
# コミュニティ版のサインイン状態
npm run setup -- --device-state /path/to/muse-desktop-bridge/muse-auth/.state/state.json
```

```sh
# 公式 SDK のペアリング
npm run setup -- --pairing /path/to/pairing.json
```

セットアップは所有者だけが読み書きできる `.dev.vars` を作成します。コミュニティ版の取り込み対象は端末 ID、端末リフレッシュトークン、SDK トークンのみです。公式 SDK の場合は `.dev.vars` の `MUSE_SDK_TOKEN` を自分で入力します。ユーザーセッションの認証情報を含む元ファイルはローカルに保管します。

手動で設定する場合は `npm run setup` を実行し、同じ端末認証の `MUSE_NODE_ID`、`MUSE_REFRESH_TOKEN`、`MUSE_SDK_TOKEN` を入力します。`HOOK_TOKEN`、`MCP_TOKEN`、`MCP_ADMIN_TOKEN`、`MUSE_SESSION_ID` は自動生成されます。既存のサイドチャットを使う場合は、そのセッション ID を `MUSE_SESSION_ID` に指定します。生成された値を使うと、初回投稿で新しいサイドチャットが作られます。特定の貸与済み VM を使う場合は `MUSE_VM_ID` を設定できます。

**3. Worker を公開します。** 上の **Deploy to Cloudflare** を押し、Worker 名を選びます。デプロイコマンドは `npx wrangler deploy --minify` に設定し、Secrets の各欄には `.dev.vars` の同名の値を入力します。CLI を使う場合は、プロジェクトのルートで次を実行してください。既定の Worker 名は `museknock` です。自分のアカウントでこの名前を使っている場合は、先に `wrangler.jsonc` の `name` を変更します。

```sh
npx wrangler login
npm run deploy
```

**4. 通知を送ります。** 次の URL をデプロイ時に表示された HTTPS URL に置き換えてください。送信元が必要とするのは Webhook 用トークンだけです。

```sh
WORKER_URL=https://your-worker.your-subdomain.workers.dev
HOOK_TOKEN=$(node --env-file=.dev.vars -p 'process.env.HOOK_TOKEN')
curl -i "$WORKER_URL/hooks/default" \
  -H "Authorization: Bearer $HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Event-Type: build_failed' \
  -H 'Idempotency-Key: first-knock' \
  --data '{"project":"hello","message":"テストが失敗しました"}'
```

初回は HTTP `202` と受付 ID が返ります。Worker が配信を予約し、`MUSE_SESSION_ID` のサイドチャットに投稿します。Muse で通知を確認してください。同じ `Idempotency-Key` で再送すると HTTP `200`、元の受付 ID、現在の配信状態が返ります。新しい通知には新しいキーを使います。

## Muse から通知を管理する

Muse の **Settings → Connectors** でカスタムコネクタを作成し、URL に Worker の `/mcp`、認証方式に Bearer を指定します。トークン欄には `.dev.vars` の対応する値を入力します。カスタムコネクタの提供状況は利用アカウントで確認してください。[Meta のコネクタ設定](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

| 使うトークン | Muse への依頼例 |
| --- | --- |
| `MCP_TOKEN`（読み取り） | 「通知元を一覧にして」「受付 ID … の配信状態を調べて」 |
| `MCP_ADMIN_TOKEN`（読み書き） | 「default を一時停止して」「default は build_failed だけ許可して」「default を再開して」 |

送信元を停止すると、その送信元の配信待ち通知も抑止されます。再開は今後の配信に適用されます。すでに投稿中の通知は届く場合があります。

## ローカルで試す

`npm ci`、`npm test`、`npm run check` でローカル Worker のテストと型検査を実行します。バンドルの確認には `npm run deploy -- --dry-run` を使います。実際の認証情報で `npm run dev` を試す場合は、デプロイ済み Worker とのトークン更新の競合を避けるため、別途認証した端末 ID を使ってください。テスト対象はローカルの配信プロトコルです。実際の Muse アカウントへの投稿は未検証です。

送信元の追加、任意形式への対応、レート制限と配信状態、届かないときの確認方法は[運用とカスタマイズ](docs/operations.ja.md)にまとめています。
