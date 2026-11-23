# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

Webhook を受けると、自分の Muse のサイドチャットに通知が届きます。たとえばジョブの失敗を通知して、Muse に「この送信元からは失敗だけ届けて」と頼めます。

[クイックスタート](#クイックスタート) · [English](README.md) · **日本語** · [简体中文](README.zh-CN.md)

```text
外部サービス ── Webhook ──▶ Cloudflare Worker ──▶ 配信待ち (SQLite)
Muse ──────────── MCP ──▶        │                    ▲
                                └── 配信ルール        │ HTTPS で取得
Muse のサイドチャット ◀── Gadget SDK ◀──────────── Mac / Linux ブリッジ
```

## クイックスタート

Cloudflare アカウント、自分の Muse アカウントと Gadget SDK トークン、Node.js 22.12 以降、npm を用意します。ブリッジはオンラインの Mac または Linux で動かします。Mac ではアカウントでサインインでき、Bluetooth ペアリングも別の Linux 端末も不要です。

**1. 手元の実行環境を Muse に接続する。どちらか一方を選んでください。**

**macOS の場合。** `uv` をインストールし、コミュニティ製の Muse Desktop Bridge を使います。インストーラーが Python 3.13 を用意できます。自分の Muse アカウントで対話的にサインインし、本人確認を完了します。トークンは Mac 内に保存します。Muse には実行ユーザーの権限でシェル操作とファイルの読み書きが許可されるため、専用のユーザーで起動してください。通知を受ける間は Mac をスリープさせずに使います。[Muse Desktop Bridge の設定](https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/3b6d0e0665d40d5537b21b701c18327e288741d9/README.md#quick-start)

```sh
git clone https://github.com/chaitanyarahalkar/muse-desktop-bridge.git ~/muse-desktop-bridge
cd ~/muse-desktop-bridge
git checkout 3b6d0e0665d40d5537b21b701c18327e288741d9
./scripts/setup.sh
python3 muse-auth/muse_auth.py setup
./muse-executor/muse-executor start
./muse-executor/muse-executor status
```

`status` で接続を確認します。この場所にクローンすると MuseKnock がソケットを自動で選びます。別の場所を使う場合は `muse-executor/.runtime/muse.sock` の絶対パスを `.env.bridge` の `MUSEGADGET_SOCKET` に設定してください。

**Linux の場合。** Bluetooth LE 対応の 64 ビット Linux 端末に自分の Gadget SDK トークンで公式 Linux SDK をインストールし、スマホの **Settings → Devices** からペアリングします。Muse は SDK を設定した Linux ユーザーの権限で操作できます。通知用のユーザーを使ってください。SDK トークンは自分の Muse アカウントでの個人・非商用利用が対象です。[公式インストール手順](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md#install) · [SDK トークンの利用条件](https://gadgets.muse.ai/sdk-terms)

**2. MuseKnock の設定を作る。** このリポジトリを取得し、プロジェクトのディレクトリで実行します。

```sh
npm ci
npm run setup
```

Worker 用のトークンが `.dev.vars` に、ブリッジの接続設定と投稿先 ID が `.env.bridge` に作られます。どちらも所有者だけが読み書きできます。再実行しても既存の値を引き継ぎます。

**3. Worker を公開する。** README 冒頭の **Deploy to Cloudflare** を押し、Worker 名を選びます。デプロイコマンドには `npx wrangler deploy --minify` を指定してください。Secrets の4つの入力欄には、手順 2 で生成した `.dev.vars` の同名の値を入力してデプロイします。

CLI から公開する場合は、次のコマンドを実行します。既定の Worker 名は `museknock` です。同じアカウントでこの名前を使っている場合は、先に `wrangler.jsonc` の `name` を変更してください。

```sh
npx wrangler login
npm run deploy
```

公開した Worker の URL（`https://…workers.dev`）を `.env.bridge` の `WORKER_URL` に設定します。既存のガジェットのサイドチャットへ届ける場合は、そのセッション ID を `MUSE_SESSION_ID` に指定します。生成された ID を使うと、初回投稿で新しいサイドチャットが作られます。別の PC でデプロイした場合は、ブリッジを動かす端末にも MuseKnock と依存関係を用意し、`.env.bridge` を安全に転送してください。

**4. 通知を待ち受ける。** ソケットを利用できるユーザーで、実行端末の MuseKnock ディレクトリから起動します。executor とブリッジの両方を動かしておきます。

```sh
npm run bridge
```

**5. 別のターミナルから通知する。** 手順 2 のディレクトリで実行します。設定ファイルを違う端末に分けた場合は、送信側の `WORKER_URL` に公開 URL を設定してください。

```sh
. ./.dev.vars
. ./.env.bridge
curl -i "$WORKER_URL/hooks/default" \
  -H "Authorization: Bearer $HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Event-Type: build_failed' \
  -H 'Idempotency-Key: first-knock' \
  --data '{"project":"hello","message":"テストが失敗しました"}'
```

初回は HTTP `202` と受付 ID が返り、ブリッジが通常10秒以内に次の取得を始めます。Muse のサイドチャットで通知を確認してください。同じコマンドを再実行すると HTTP `200` で同じ ID と現在の状態が返ります。次の通知には新しいキーを使います。

## Muse から通知を管理する

Muse の **Settings → Connectors** でカスタムコネクタを作成し、URL に Worker の `/mcp`、認証方式に Bearer を指定します。トークン欄には `.dev.vars` の対応する値を入力します。カスタムコネクタの提供状況は利用アカウントで確認してください。[Meta のコネクタ設定](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

| 使うトークン | Muse への依頼例 |
| --- | --- |
| `MCP_TOKEN`（読み取り） | 「通知元を一覧にして」「受付 ID … の配信状態を調べて」 |
| `MCP_ADMIN_TOKEN`（読み書き） | 「default を一時停止して」「default は build_failed だけ許可して」「default を再開して」 |

停止すると配信待ちの通知も抑止されます。後で再開しても、抑止済みの通知は届きません。すでにブリッジへ引き渡した通知は届く場合があります。

## ローカルで試す

```sh
npm ci
npm run setup
npm run dev
```

`http://127.0.0.1:8787` で同じ Webhook を試せます。手順 5 の `WORKER_URL` をこのアドレスに設定してください。ペアリング済み端末がなくても、`npm test` はローカル Worker とテスト用の SDK ソケットで配信を検証できます。型検査は `npm run check`、公開前のバンドル確認は `npm run deploy -- --dry-run` です。

送信元の追加、任意形式への対応、レート制限と配信状態、届かないときの確認方法は[運用とカスタマイズ](docs/operations.ja.md)にまとめています。
