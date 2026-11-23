# 将 Gmail 新邮件发送到 Muse 侧边对话

[English](gmail.md) · [日本語](gmail.ja.md) · [简体中文](gmail.zh-CN.md)

先完成[快速开始](../README.zh-CN.md#快速开始)中的测试通知。你需要一个已部署的 Worker、一台已授权的 Muse 设备、加密密钥和一个已选定的侧边对话。每个 Worker 可以监听一个邮箱。配置完成后即可关闭 Cloud Shell。Google Pub/Sub 会直接调用 Worker，Cloudflare Cron 会定期续订 Gmail 监听。

## 1. 将 Pub/Sub 连接到 Worker

准备一个专用 Google Cloud 项目，步骤 2 中的 OAuth 客户端也要使用同一项目。在浏览器中打开 Cloud Shell，将下面两条脚本命令中的项目 ID 和 Worker 地址换成自己的值。`--dry-run` 只显示操作，不会连接到 Google。[打开 Cloud Shell](https://shell.cloud.google.com/)

```sh
git clone --depth 1 https://github.com/Code-Hex/MuseKnock.git
cd MuseKnock
./scripts/setup-gmail.sh --dry-run YOUR_PROJECT_ID https://YOUR-WORKER.workers.dev
./scripts/setup-gmail.sh YOUR_PROJECT_ID https://YOUR-WORKER.workers.dev
```

脚本会启用所需的 API，授予 Gmail 向主题发布消息的权限，并创建将消息推送到 `/hooks/gmail` 的订阅。Pub/Sub 服务代理会获得为专用推送服务账号签发 OIDC 令牌的权限。记下脚本输出的四项 `GMAIL_*` 设置。重复运行会复用同名资源，并更新订阅的推送地址。[Gmail 推送配置](https://developers.google.com/workspace/gmail/api/guides/push) · [Pub/Sub 推送身份验证](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

运行脚本的账号需要有权启用 API、管理 Pub/Sub、创建服务账号并授予上述 IAM 权限。如果创建订阅时报 `iam.serviceAccounts.actAs` 错误，请让管理员在 `museknock-gmail-push@YOUR_PROJECT_ID.iam.gserviceaccount.com` 上向运行脚本的账号授予 **Service Account User** 角色，再次运行脚本。如果组织政策阻止了对 Gmail 的发布授权，请让管理员为该主题设置例外。[Pub/Sub 权限](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

## 2. 授权读取邮箱

1. 在 Google Auth Platform 配置同意屏幕，在 **Data Access** 添加 `https://www.googleapis.com/auth/gmail.readonly`。如果外部应用处于 **Testing** 状态，请在 **Audience → Test users** 添加自己的 Gmail 地址。即使只选一个标签，Google 授予的读取权限也覆盖整个邮箱。[Google Auth Platform](https://console.cloud.google.com/auth/overview)
2. 在 **Clients** 创建 **Web application** 类型的 OAuth 客户端。将 `https://developers.google.com/oauthplayground`（末尾没有斜杠）添加为已获授权的重定向 URI，保存客户端 ID 和密钥。[创建 OAuth 凭据](https://developers.google.com/workspace/guides/create-credentials#web-application)
3. 在 OAuth 2.0 Playground 打开齿轮设置，选中 **Use your own OAuth credentials**，填入客户端 ID 和密钥，选择 **Offline** 和 **Consent**。输入步骤 1 中的 Gmail 只读权限范围，点击 **Authorize APIs**，登录你要监听的邮箱。点击 **Exchange authorization code for tokens**，复制 **Refresh token**。[OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
4. 外部应用处于 **Testing** 状态时，此刷新令牌会在七天后过期。如需长期运行，请选择适合该账号的发布状态，并在更改状态后重新获取刷新令牌。[刷新令牌过期条件](https://developers.google.com/identity/protocols/oauth2#expiration)

## 3. 配置 Worker 并开始监听

在 Cloudflare 打开 Worker 的 **Settings → Variables and Secrets**，设置以下值并部署更改。请直接在 Cloudflare 中输入 Google 的 OAuth 凭据。

| 类型 | 设置 | 值 |
| --- | --- | --- |
| Secret | `GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`、`GMAIL_REFRESH_TOKEN` | OAuth 客户端 ID、客户端密钥和邮箱的刷新令牌 |
| Text | `GMAIL_ACCOUNT` | 已授权邮箱的主电子邮件地址 |
| Text | `GMAIL_TOPIC`、`GMAIL_SUBSCRIPTION` | 脚本输出的完整资源名称，包含 `projects/…` |
| Text | `GMAIL_PUSH_SERVICE_ACCOUNT`、`GMAIL_PUSH_AUDIENCE` | 脚本输出的服务账号电子邮件地址和完整 HTTPS 地址 |
| Text，可选 | `GMAIL_LABEL_ID` | Gmail 标签 ID，默认为 `INBOX`。自定义标签的 ID 可通过 `users.labels.list` 获取。 |
| Text，可选 | `GMAIL_INCLUDE_BODY`、`GMAIL_MAX_BYTES` | 默认值为 `false`，此时发送发件人、收件人、主题等元数据。设为 `true` 后会附上邮件中可用的纯文本正文。正文大小限制可设为 1 至 20,000 字节，默认 20,000。 |

1. 配置好 Worker 和 Muse 目标对话后，每五分钟运行一次的 Cron 会自动启动监听。如需立即启动，请通过管理连接器调用 `sync_gmail`。首次同步会登记监听，并将当前历史位置保存为起点。之前的邮件不会转发。调用 `get_gmail_status`，检查 `ready`、`historyId` 和 `watchExpiresAt`。
2. 从其他账号发一封符合所选标签条件的新邮件，在选定的 Muse 侧边对话中查看通知。Gmail 对每个邮箱的推送上限为每秒一条。Worker 每五分钟检查一次 Gmail 历史，以补回延迟或丢失的通知。每次同步最多处理十封，余下的留待后续同步。Worker 每天续订监听。[Gmail 通知限制](https://developers.google.com/workspace/gmail/api/guides/push#limitations)
3. 若通知停止，请调用 `get_gmail_status` 检查 `lastSyncAt` 和 `watchExpiresAt`，再调用 `sync_gmail` 重试。如果 `lastGapAt` 有新的时间戳，说明上次保存的历史已在 Gmail 中过期。请打开邮箱检查该时段的邮件。[Gmail 历史同步](https://developers.google.com/workspace/gmail/api/guides/sync)

## 断开 Gmail

在 Cloudflare 中移除 Gmail 配置并重新部署以停止同步。如需立即停止推送，请在 Google Cloud 删除专用订阅 `museknock-gmail-push`。停止续订后，Gmail 监听将在七天内失效。如不再使用此集成，请撤销该应用的 Google 账号访问权限，并删除专用主题和推送服务账号。[管理 Google 账号关联](https://myaccount.google.com/connections)
