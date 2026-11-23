# MuseKnock 运维与自定义指南

[English](operations.md) · [日本語](operations.ja.md) · **简体中文**

## 首次授权设备

请为此 Worker 准备一个专用设备身份。前往 [Muse Gadgets](https://gadgets.muse.ai/) 的 **Account → SDK tokens** 获取自己的 SDK 令牌。

- **官方配对。** 在 Muse 应用中为专用设备配对，然后停止 SDK 守护进程。从 `pairing.json` 获取当前的 `node_id` 和 `refresh_token`，并准备配对时使用的 SDK 令牌。Linux SDK 通常将该文件保存在 `/var/lib/musegadget/`。[官方配对指南](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md#install)
- **通过浏览器使用社区工具登录。** 如果没有配对过的硬件，且愿意使用第三方工具登录，可以在自己的 GitHub Codespace 中打开 Muse Desktop Bridge 仓库。在浏览器的终端中运行 `git checkout 3b6d0e0665d40d5537b21b701c18327e288741d9`，再运行 `python3 muse-auth/muse_auth.py setup`。按提示使用自己的账户登录，完成一次性验证码或双重认证，并提供本人的 SDK 令牌。遇到账户验证时，可能仍需在 Muse 应用中操作。尚未使用真实账户在 Codespaces 中验证该登录流程。[社区登录说明](https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/3b6d0e0665d40d5537b21b701c18327e288741d9/muse-auth/README.md) · [在 Codespace 中打开 Muse Desktop Bridge](https://codespaces.new/chaitanyarahalkar/muse-desktop-bridge) · [GitHub Codespaces 说明](https://docs.github.com/en/codespaces/developing-in-a-codespace/creating-a-codespace-for-a-repository)

使用社区登录时，在你自己的私有 Codespace 编辑器中打开 `muse-auth/.state/state.json`，只把 `sdk_token`、`device.device_id` 和 `device.refresh_token` 复制到 Cloudflare 部署表单中对应的密钥栏。将原始文件和账户会话凭据保留在 Codespace 中。完成设备凭据移交后即可删除 Codespace。[部署步骤](../README.zh-CN.md#快速开始)

## 排查未收到的通知

请 Muse 按回执 ID 查询投递状态。即使尚未配置连接器，也可以用原来的 `Idempotency-Key` 重发 Webhook，查看该通知的状态。

| 状态 | 含义与排查方法 |
| --- | --- |
| `queued` | 正在等待 Worker 投递。请检查 Muse 密钥是否齐全、设备授权是否有效，以及设备是否有已分配的 VM。 |
| `sending` | Worker 已领取事件，正在连接或发送。 |
| `sent` | Muse 已确认接收。请打开 Worker 收到通知时选中的目标对话。 |
| `suppressed` | 来源已暂停，或事件类型不在允许列表中。该通知的投递已结束。 |
| `expired` | 通知已排队一小时，超过投递期限。 |
| `unknown` | 消息可能已经发送，但 Worker 未能确认结果，或者两分钟的投递许可已经过期。发送新通知前请先查看侧边对话。 |

如果能确定提交前已经失败，Worker 会在投递限额和有效期内重试。如果消息可能已到达 Muse，Worker 会记录为 `unknown`，由你决定是否重发，以免因确认响应丢失而重复投递。[Gadget SDK 消息传输协议](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/link_client.py)

## 迁移已保存的凭据

1. 升级现有 Worker 前，在 Cloudflare 的 **Settings → Variables and Secrets** 中将 `CREDENTIAL_ENCRYPTION_KEY` 添加为 **Secret**。按[部署步骤](../README.zh-CN.md#快速开始)生成 64 个十六进制字符作为专用密钥。如果该 Worker 已设置密钥，请保留原值。全新本地配置会生成自己的密钥。用 `npm run deploy:local` 更新已有 Worker 前，请先将该 Worker 的原密钥恢复到 `.dev.vars`。
2. 部署更新后，通过已认证的 Muse 连接器调用 `get_setup_status`，确认 `credentialStorageReady` 为 `true`。如果为 `false`，请检查 Secret 配置，如果密钥已更改则从备份中恢复原值。Durable Object 启动时会用 AES-256-GCM 加密已保存的 Muse 设备令牌和 Bluesky 会话。后续令牌更新也会加密。解密复制的凭据记录需要保存在 Worker Secret 中的独立密钥。请在私人密码管理器中保管密钥，以便重新部署或恢复。如果误换了密钥，恢复原值即可重新读取已保存的令牌。
3. 迁移前的导出文件和时间点恢复快照中可能仍有明文令牌。若这些数据已经泄露，请撤销受影响的 Muse 设备授权并重新授权设备。如果 Bluesky 令牌泄露，请撤销受影响的会话及应用密码，再签发新的应用密码。更新对应的 Worker Secret 后恢复投递。[Cloudflare 存储恢复机制](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#point-in-time-recovery-api)

## 更新设备授权

交接后，Worker 会将轮换后的设备凭据保存在 Durable Object 中。请勿在其他执行器、本地开发环境或其他 Worker 部署中使用同一设备身份。如果 Muse 撤销了配对，请重新授权设备凭据，在 Cloudflare 中更新相应的 Worker 密钥并重新部署。已注册的目标对话保存在 Durable Object 中。

Worker 使用标准设备 API `api.muse.ai` 和加密的 Link 网关 `hatch.metaaivm.com`。如果设置了 `MUSE_VM_ID`，请确认该 VM 已分配给设备。未指定时，Worker 会选择默认的已分配 VM，如果没有默认项则选择列表中的第一项。[Gadget SDK 设备 API](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/muse_api.py)

## 发送 Webhook

向 `POST /hooks/custom` 发送请求，用 `HOOK_TOKEN` 进行 Bearer 认证。 在 MCP 中，来源名称仍为 `default`，已有的暂停和筛选规则继续生效。

| 输入 | 处理方式 |
| --- | --- |
| `application/json` 或以 `+json` 结尾的子类型 | 验证 JSON 语法并投递原文，保留整数值和空白字符。 |
| `text/plain` 或无 Content-Type | 原样投递文本。 |
| `application/x-www-form-urlencoded` | 转换为名称与值的键值对数组，以保留重复字段。 |
| `X-Event-Type` | 过滤规则使用的事件类型，默认为 `notification`。来源名称和事件类型均为 1 至 64 个字符，以小写 ASCII 字母或数字开头，后续字符还可以包含 `_` 和 `-`。 |
| `Idempotency-Key` | 同一来源内的唯一事件标识符，最多 128 个可打印的 ASCII 字符，不含空格。省略时，每个 POST 都会作为新事件处理。 |

请求正文和解码后的文本各自最多为 32 KiB。正文只应包含希望交给 Muse 的信息。Worker 接收新事件时会保存当时选中的目标会话。

服务专用接口接受的请求正文最大为 512 KiB，提取的每条通知文本最大为 32 KiB。接口按各服务要求的格式响应。通过 MCP 暂停或筛选通知时，可使用 URL 中的来源名称（如 `telegram`）和事件类型（如 `edited_message`）。[服务设置](../README.zh-CN.md#直接连接服务)

每个来源在滚动的 60 秒内最多提交 10 个新事件。超出限制时返回 HTTP `429` 和 `Retry-After: 60`。所有来源合计每 60 秒最多获得 3 次投递许可，同时只处理一条。重试也占用配额。自收到事件起，去重和回执查询的有效期为 7 天。下次访问存储时会更新过期状态并删除旧记录。限额定义在 `src/store.ts` 中。

## 添加来源或正文格式

在 `src/index.ts` 中向 `registerWebhook` 传入来源名称、包含认证逻辑的 Hono 中间件数组，以及读取正文的函数。例如，要从 CI 通知中仅提取作业名称，请在 `WorkerEnv` 的 `Bindings` 中加入 `CI_HOOK_TOKEN`，将其设为独立的随机 Worker 密钥，再注册以下路由。

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

重新部署后即可向 `POST /hooks/ci` 发送通知。验证来源签名时，请在中间件中读取 `c.req.raw.clone()`，然后再解码正文。你可以在认证后添加限流或过滤逻辑。Durable Object 会对所有区域执行同一投递上限。[Hono 中间件](https://hono.dev/docs/guides/middleware) · [Durable Object 的 SQLite 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## MCP 工具

| 工具 | 参数与结果 | 权限 |
| --- | --- | --- |
| `get_setup_status` | 根据 Worker 中的配置返回 `deviceConfigured`、`credentialStorageReady`、`active` 和 `ready`。 | 只读 |
| `get_gmail_status` | 查看 Gmail 配置状态、监控到期时间、上次同步时间和历史记录缺失情况。 | 只读 |
| `sync_gmail` | 按需启动或续订 Gmail 监控，并同步一批新邮件。 | 管理 |
| `send_test_notification` | `requestId`（UUID）。向当前目标对话排入一条固定内容的测试通知，返回回执。来源为 `museknock-test`，事件类型为 `test`。 | 管理 |
| `list_side_chats` | 列出在 MuseKnock 中注册的名称、会话 ID 和当前目标。 | 只读 |
| `register_side_chat` | 用 `name`、`sessionId` 新建或更新记录。尚无投递目标时自动选中首次注册的对话。 | 管理 |
| `set_active_side_chat` | 通过 `name` 选择已有记录，作为之后接收通知的目标。 | 管理 |
| `list_sources` | 无参数。列出有接收记录或投递规则的来源。 | 只读 |
| `get_delivery_status` | `id`（回执 ID）。返回投递信息，不含正文。 | 只读 |
| `set_source_paused` | `source`、`paused`（布尔值）。 | 管理 |
| `set_event_filter` | `source`、`types`（允许的事件类型数组）。空数组允许所有类型。 | 管理 |

注册名区分大小写，去除首尾空格后长度为 1 至 64 个字符。首位使用 Unicode 字母或数字，之后还允许组合标记、空格、英文句点、下划线和连字符。会话 ID 区分大小写，允许使用 1 至 64 个 ASCII 字母、数字或连字符。注册时只保存你提供的 ID，不会发送测试消息。要继续原有对话，请使用设备发消息时使用的会话 ID。升级时，有效的旧版 `MUSE_SESSION_ID` 将显示为 `default`。设备密钥不全或未选择投递目标时，已通过身份验证的通知请求将收到 HTTP `503`。

轮换 Webhook 或 MCP 令牌时，在 Cloudflare 更新对应的 Worker 密钥并部署，再更新使用该令牌的发送端或连接器。

## 验证 SDK 兼容性

检出 Muse Gadget SDK 的提交 `e17081a45941415d483642dbe21c2a2e6ef85a13`，并在 Python 虚拟环境中安装其 `linux[test]` 包。将 `MUSE_PYTHON` 设为该环境的 Python 可执行文件路径，将 `MUSE_SDK_TESTS` 设为 SDK 中 `linux/tests` 目录的绝对路径。运行 `npm test` 即可使用测试凭据，在本地验证从接收 Webhook、经过 Worker 到 SDK 测试服务器收件的完整流程。

## 可选的 CLI 配置

在 Node.js 22.12 或更高版本中，运行 `npm ci` 和 `npm run setup -- --pairing /path/to/pairing.json`。使用社区登录状态时将参数换为 `--device-state /path/to/state.json`。编辑生成的 `.dev.vars`，补全设备凭据。对于新 Worker，请将生成的 `CREDENTIAL_ENCRYPTION_KEY` 备份到密码管理器中。部署已有 Worker 时，请使用原密钥。新配置不会预选目标对话。部署后请通过 MCP 注册。已有的 `MUSE_SESSION_ID` 会予以保留，包括旧版 `.env.bridge` 中的设置。运行 `npx wrangler login` 后，用 `npm run deploy:local` 上传设置。使用 `npm test`、`npm run check` 和 `npm run deploy -- --dry-run` 进行本地验证。在 `npm run dev` 中发送真实消息时，请使用单独的设备凭据。尚未验证向真实 Muse 账户投递。
