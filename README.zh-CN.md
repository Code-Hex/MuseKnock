# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock 通过 Cloudflare Workers 把 Webhook 通知发送到已有的 Muse 侧边对话。你可以在 Muse 中通过 MCP 连接器选择目标对话。关闭电脑后，Worker 会继续投递通知。

[快速开始](#快速开始) · [English](README.md) · [日本語](README.ja.md) · **简体中文**

## 快速开始

请准备 Cloudflare 和 GitHub 账户、已获授权的 Muse 设备凭据，以及设备向现有对话发消息时使用的确切会话 ID。SDK 令牌仅供你在自己的 Muse 账户中用于个人、非商业用途。[首次授权设备](docs/operations.zh-CN.md#首次授权设备) · [SDK 令牌使用条款](https://gadgets.muse.ai/sdk-terms)

**1. 从 Cloudflare 部署。** 点击上方的 **Deploy to Cloudflare**，选择 Worker 名称，在部署表单的 Worker 密钥栏填写以下七项。在密码管理器中为前三项分别生成足够长的随机字母数字串。[Cloudflare 部署按钮说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/#worker-environment-variables-and-secrets)

| Worker 密钥 | 值 |
| --- | --- |
| `HOOK_TOKEN` | Webhook 发送端使用的令牌 |
| `MCP_TOKEN` | Muse 只读连接器使用的令牌 |
| `MCP_ADMIN_TOKEN` | Muse 管理连接器使用的令牌，可配置目标对话和发送测试通知 |
| `CREDENTIAL_ENCRYPTION_KEY` | 用于加密凭据的独立 32 字节密钥。在密码管理器中随机生成 64 个十六进制字符（0–9、a–f），并妥善备份。 |
| `MUSE_NODE_ID` | 官方 `pairing.json` 中的 `node_id`，或社区版 `state.json` 中的 `device.device_id` |
| `MUSE_REFRESH_TOKEN` | 官方文件中的 `refresh_token`，或社区版文件中的 `device.refresh_token` |
| `MUSE_SDK_TOKEN` | 官方设备配对时使用的 SDK 令牌，或社区版文件中的 `sdk_token` |

升级现有 Worker 时，请先添加该密钥，再部署更新并通过 Muse 检查配置。[迁移已保存的凭据](docs/operations.zh-CN.md#迁移已保存的凭据)

如果已有执行器或 SDK 守护进程使用相同的设备身份，请先将其停止并关闭自动重启。移交后 Worker 会刷新设备凭据。只将表中指定的三项设备信息复制到 Cloudflare，原始文件和账户凭据应保留在你自己手中。部署 Worker，复制部署完成后显示的 HTTPS 地址。

**2. 连接 Muse。** 在 Muse 的 **Settings → Connectors** 中添加一个自定义连接器。在已部署 Worker 的 URL 后加上 `/mcp`，选择 Bearer 身份验证，将 `MCP_ADMIN_TOKEN` 填入令牌栏。[Muse 连接器指南](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

**3. 通过 Muse 注册对话并测试投递。** 可以按顺序向连接器提出以下请求。

1. “检查我的 MuseKnock 配置。” `get_setup_status` 检查 Worker 中的配置。下面的测试消息用于验证实际投递。
2. “将现有会话 `已有会话ID` 注册为‘构建通知’，并设为通知目标。”请使用设备原来的 `--session-id`，或旧部署中的 `MUSE_SESSION_ID`。`register_side_chat` 保存的是 MuseKnock 中的名称。使用陌生的 ID，首次投递时可能会创建新对话。[Gadget SDK 侧边对话说明](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md)
3. “发送一条测试通知并检查回执。”Muse 使用新的 UUID 作为 `requestId` 调用 `send_test_notification`，然后用返回的回执 ID 调用 `get_delivery_status`。当状态为 `sent` 时，打开所选对话查看消息。重试同一次测试时，请使用相同的请求 ID。

**4. 连接事件来源。** 如需接入 Slack、LINE、Twilio、Telegram、企业微信、GitHub 或 X，请参阅[直接连接服务](#直接连接服务)。Bluesky 和 Discord 的设置见[连接 Bluesky](#连接-bluesky)和[连接 Discord](#连接-discord)。Gmail 的设置见 [Gmail 接入指南](docs/gmail.zh-CN.md)。支持自定义 Bearer 请求头的服务可以使用下面的通用 Webhook。

在发送服务的 Webhook 设置中，将请求设为发往同一 Worker 的 `/hooks/custom` 的 `POST`，添加 `Authorization: Bearer YOUR_HOOK_TOKEN` 和 `Content-Type: application/json`。发送 `{"message":"构建完成"}` 等正文后会收到回执 ID。之后可以在 Muse 中查看投递状态、暂停来源或筛选事件类型。

如果发送端之前使用 `/hooks/default`，请将 URL 更新为 `/hooks/custom`。

## 直接连接服务

在 Cloudflare 中打开 Worker，进入 **Settings → Variables and Secrets**，按需将下表中的值添加为 Secret 并部署更改。将相应路径附加到 Worker 的公开 HTTPS 地址，得到要注册的完整 URL。各服务使用自身的认证机制，`HOOK_TOKEN` 仅供 `/hooks/custom` 使用。

| 服务 | Worker Secret | 注册 URL 并验证投递 |
| --- | --- | --- |
| Slack Events API | 将 **Basic Information → App Credentials** 中的 Signing Secret 保存为 `SLACK_SIGNING_SECRET` | 启用 **Event Subscriptions**，将 `/hooks/slack` 注册为 Request URL。显示 **Verified** 后，订阅 `app_mention` 等机器人事件，授权所需权限并安装或重新安装应用。将机器人邀请到频道并 @ 它。[Slack URL 设置](https://docs.slack.dev/apis/events-api/using-http-request-urls/) |
| LINE Messaging API | 将频道 **Basic settings** 中的 Channel secret 保存为 `LINE_CHANNEL_SECRET` | 在 **Messaging API** 中将 Webhook URL 设为 `/hooks/line`，点击 **Verify**，启用 **Use webhook**，并按需开启 **Webhook redelivery** 以便在接收失败时重试，然后向官方账号发送消息。验证请求带有签名和空事件列表，不会生成通知。[LINE 连接验证](https://developers.line.biz/en/docs/messaging-api/verify-webhook-url/) |
| Twilio 入站短信和彩信 | 将号码所属账号的 Primary Auth Token 保存为 `TWILIO_AUTH_TOKEN` | 在 **Active Numbers** 中打开该号码的消息设置。在 **A message comes in → Webhook → HTTP POST** 中准确填写以 `/hooks/twilio` 结尾的公开 URL 并保存。向号码发送短信进行验证。Worker 返回空的 TwiML，不会自动回复短信。[Twilio 入站 Webhook](https://www.twilio.com/docs/messaging/guides/webhook-request) |
| 企业微信自建应用 | 将 **我的企业** 中的企业 ID 保存为 `WECOM_CORP_ID`，将回调的 Token、EncodingAESKey 分别保存为 `WECOM_TOKEN`、`WECOM_ENCODING_AES_KEY` | 在 **应用管理 → 自建 → 接收消息 → 设置 API 接收** 中填入 `/hooks/wecom` 和相同的 Token、EncodingAESKey。如果后台要求主体相关的备案域名，请为 Worker 配置相应的自定义域名。保存时会自动验证加密回调 URL，然后给应用发送消息。[企业微信回调配置](https://developer.work.weixin.qq.com/document/path/90930) |

**Telegram Bot API**。通过 @BotFather 创建机器人，另行生成由字母、数字、下划线或连字符组成的随机值（1 至 256 个字符），并将其保存为 Cloudflare 的 `TELEGRAM_WEBHOOK_SECRET`。使用 HTTPS 客户端按下例调用 `setWebhook`。在 shell 示例中，`BOT_TOKEN` 是 BotFather 提供的令牌，`WORKER_URL` 是末尾不带斜杠的 Worker 地址。机器人令牌仅用于访问 Telegram API。注册后会替换该机器人现有的 Webhook URL。[Telegram Webhook 设置](https://core.telegram.org/bots/api#setwebhook)

```sh
curl --fail-with-body -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/hooks/telegram" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","edited_message","channel_post","edited_channel_post"]'
curl --fail-with-body "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

通过 `getWebhookInfo` 确认返回的 URL，然后在与机器人的私聊中发送消息。MuseKnock 接收消息、频道帖子及其编辑，并转发其中的文本或媒体说明。消息出现在选定的 Muse 侧边对话中即表示投递成功。任何能给该机器人发消息的人都能触发通知。

### GitHub 仓库事件

1. 生成随机密钥，保存到 Worker 的 `GITHUB_WEBHOOK_SECRET`。在目标仓库打开 **Settings → Webhooks → Add webhook**，将 Payload URL 设为 `https://YOUR-WORKER/hooks/github`，Content type 选 `application/json`，在 Secret 中填入相同密钥，并启用 SSL 验证。
2. 在 **Let me select individual events** 中按需选择 `push`、`issues`、`pull_request`、`release` 和 `workflow_run`，然后启用 Webhook。Worker 验证 GitHub 的 SHA-256 签名。首次 `ping` 仅用于确认连接，触发所选事件后即可在对话中看到摘要。[创建仓库 Webhook](https://docs.github.com/zh/webhooks/using-webhooks/creating-webhooks)
3. 如果通知未送达，请检查 **Recent Deliveries**。GitHub 不会自动重试失败的投递。Worker 每次最多接收 512 KiB，每个来源每分钟最多接收 10 个新事件。遇到 `429` 时，等待一分钟后点击 **Redeliver**。七天内重复投递相同正文只会产生一条通知。[处理失败的投递](https://docs.github.com/zh/webhooks/testing-and-troubleshooting-webhooks/handling-failed-webhook-deliveries)

### X 公开帖子

准备一个已获批准且可以使用 X Activity API 的开发者应用，将其 OAuth 2.0 **Client Secret** 保存为 Worker 的 `X_OAUTH2_CLIENT_SECRET`。Worker 用它响应注册时的验证请求（CRC）并验证投递签名。X 按实际投递的帖子事件收费，包括删除事件。[X Activity API](https://docs.x.com/x-api/activity/introduction)

使用应用级 Bearer Token 调用以下两个 X API。请求头使用 `Authorization: Bearer YOUR_APP_BEARER_TOKEN` 和 `Content-Type: application/json`。

1. 向 `POST https://api.x.com/2/webhooks` 发送 `{"url":"https://YOUR-WORKER/hooks/x"}`。X 验证 URL 后，从响应中复制 Webhook ID。[注册 Webhook](https://docs.x.com/x-api/webhooks/quickstart)
2. 向 `POST https://api.x.com/2/activity/subscriptions` 发送 `{"event_type":"post.create","filter":{"user_id":"NUMERIC_X_USER_ID"},"webhook_id":"WEBHOOK_ID"}`。如需接收删除通知，再用 `post.delete` 创建一条订阅。[订阅事件](https://docs.x.com/x-api/activity/quickstart)

在订阅的公开账号发布帖子，确认消息已送达侧边对话。对于新帖子，MuseKnock 转发帖子 ID、URL 和正文的前 4,000 个字符。MCP 的筛选类型为 `post_create` 和 `post_delete`。七天内重复投递同一 X 事件 ID 只会产生一条通知。

## 连接 Gmail

Google Pub/Sub 将带签名的通知直接推送到 `/hooks/gmail`。Worker 读取一个 Gmail 账号的新邮件，并将通知发到选定的 Muse 侧边对话。首次在 Cloud Shell 配置 Google 资源。配置 Worker 并选择对话后，每五分钟运行一次的 Cron 会自动启动监听。如需立即开始，请从 Muse 调用 `sync_gmail`。[Gmail 接入指南](docs/gmail.zh-CN.md)

## 连接 Bluesky

选好 Muse 目标对话后，打开 Worker 的 **Settings → Variables and Secrets**。按需启用下列一种或两种来源并部署更改。Worker 每五分钟读取一次官方 API。

| 接收内容 | Worker 设置 | Muse 中的来源名称 |
| --- | --- | --- |
| 指定账号的新公开帖子和回复 | 将该账号的 DID 填入 `BLUESKY_DID`。在[查询个人资料](https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=bsky.app)的 URL 中将末尾的 `bsky.app` 替换为目标账号的用户名，复制结果中的 `did`。无需登录。 | `bluesky` |
| 自己在 Bluesky 托管的账号收到的提及、点赞、关注等通知 | 将自己的用户名填入 `BLUESKY_IDENTIFIER`。生成一个不允许访问私信的专用应用密码，并保存为 Worker Secret `BLUESKY_APP_PASSWORD`。[创建应用密码](https://bsky.app/settings/app-passwords) | `bluesky-notifications` |

每个账号首次成功获取数据时只记录起点。此后发布新帖或让其他账号提及你，下一次轮询后在所选 Muse 侧边对话中确认。每次轮询每个来源最多读取十条，积压的内容会在后续轮询中继续读取。读取通知不会修改其在 Bluesky 的已读状态。[公开帖子 API](https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/feed/getAuthorFeed.json) · [账号通知 API](https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/notification/listNotifications.json)

## 连接 Discord

Worker 每五分钟检查一个 Discord 服务器文字频道。首次检查仅记录最新消息的位置，之后每次按时间顺序读取最多十条新消息。普通消息和回复会被转发到 Muse，内容包括作者、正文前 2,000 个字符，以及附件名称、大小和文件类型。

1. 在 Discord Developer Portal 创建应用，打开 **Bot**，启用 **Message Content Intent**。已验证的应用需要申请该权限。复制机器人令牌，在 Worker 中将其保存为 Secret `DISCORD_BOT_TOKEN`。[访问消息内容](https://docs.discord.com/developers/events/gateway#message-content-intent)
2. 在 **Installation → Guild Install** 中选择 `bot` 权限范围，通过安装链接将机器人添加到服务器。在目标频道为机器人授予 **查看频道** 和 **读取消息历史记录** 权限。成员在该频道发布的消息将转发到所选 Muse 对话。[安装 Discord 应用](https://docs.discord.com/developers/resources/application#installation-context) · [频道消息权限](https://docs.discord.com/developers/resources/message#get-channel-messages)
3. 在 Discord 的 **用户设置 → 高级 → 开发者模式** 中启用开发者模式。右键点击目标频道并选择 **复制频道 ID**，将该值保存为 Worker 的 `DISCORD_CHANNEL_ID` 并部署。首次定时检查完成后，在频道中发送一条消息，下一次检查后打开 Muse 确认投递。MCP 的来源名称为 `discord`，事件类型为 `message`。切换频道后，Worker 会从新频道的最新消息开始。

## 切换目标对话

告诉管理连接器另一个名称和会话 ID，注册后再说“将通知切换到这个对话”。如果尚未选择目标，首次注册的对话会自动成为默认目标。切换只影响接下来收到的通知。排队或重试中的通知仍按接收时确定的目标投递。已有部署如果配置了 `MUSE_SESSION_ID`，原对话会以 `default` 作为注册名。

使用 `MCP_TOKEN` 的只读连接器可以列出已注册的对话、查看回执。管理连接器还可以暂停来源或设置事件类型过滤条件。可选的 CLI 安装方式、Webhook 格式及投递排查方法见[运维指南](docs/operations.zh-CN.md)。
