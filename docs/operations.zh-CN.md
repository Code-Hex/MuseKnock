# MuseKnock 运维与自定义指南

[English](operations.md) · [日本語](operations.ja.md) · **简体中文**

## 排查未收到的通知

请 Muse 按回执 ID 查询投递状态。即使尚未配置连接器，也可以用原来的 `Idempotency-Key` 重发 Webhook，查看该通知的状态。

| 状态 | 含义与排查方法 |
| --- | --- |
| `queued` | 正在等待 Worker 投递。请检查 Muse 密钥是否齐全、设备授权是否有效，以及设备是否有已分配的 VM。 |
| `sending` | Worker 已领取事件，正在连接或发送。 |
| `sent` | Muse 已确认接收消息。请在 `MUSE_SESSION_ID` 指定的侧边对话中查看消息和 Muse 的回复。 |
| `suppressed` | 来源已暂停，或事件类型不在允许列表中。该通知的投递已结束。 |
| `expired` | 通知已排队一小时，超过投递期限。 |
| `unknown` | 消息可能已经发送，但 Worker 未能确认结果，或者两分钟的投递许可已经过期。发送新通知前请先查看侧边对话。 |

如果能确定提交前已经失败，Worker 会在投递限额和有效期内重试。如果消息可能已到达 Muse，Worker 会记录为 `unknown`，由你决定是否重发，以免因确认响应丢失而重复投递。[Gadget SDK 消息传输协议](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/link_client.py)

## 更新设备授权

交接后，Worker 会将轮换后的设备凭据保存在 Durable Object 中。请勿在其他执行器、本地开发环境或其他 Worker 部署中使用同一设备身份。如果 Muse 撤销了配对，请重新授权设备凭据，重新导入最新状态，并使用更新后的初始密钥重新部署。保留 `MUSE_SESSION_ID` 即可继续向同一侧边对话投递。

Worker 使用标准设备 API `api.muse.ai` 和加密的 Link 网关 `hatch.metaaivm.com`。如果设置了 `MUSE_VM_ID`，请确认该 VM 已分配给设备。未指定时，Worker 会选择默认的已分配 VM，如果没有默认项则选择列表中的第一项。[Gadget SDK 设备 API](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/muse_api.py)

## 发送 Webhook

向 `POST /hooks/default` 发送请求，用 `HOOK_TOKEN` 进行 Bearer 认证。

| 输入 | 处理方式 |
| --- | --- |
| `application/json` 或以 `+json` 结尾的子类型 | 验证 JSON 语法并投递原文，保留整数值和空白字符。 |
| `text/plain` 或无 Content-Type | 原样投递文本。 |
| `application/x-www-form-urlencoded` | 转换为名称与值的键值对数组，以保留重复字段。 |
| `X-Event-Type` | 过滤规则使用的事件类型，默认为 `notification`。来源名称和事件类型均为 1 至 64 个字符，以小写 ASCII 字母或数字开头，后续字符还可以包含 `_` 和 `-`。 |
| `Idempotency-Key` | 同一来源内的唯一事件标识符，最多 128 个可打印的 ASCII 字符，不含空格。省略时，每个 POST 都会作为新事件处理。 |

请求正文和解码后的文本各自最多为 32 KiB。正文只应包含希望交给 Muse 的信息。目标会话和凭据由 Worker 配置决定。

每个来源在滚动的 60 秒内最多提交 10 个新事件。超出限制时返回 HTTP `429` 和 `Retry-After: 60`。所有来源合计每 60 秒最多获得 3 次投递许可，同时只处理一条。重试也占用配额。自收到事件起，去重和回执查询的有效期为 7 天。下次访问存储时会更新过期状态并删除旧记录。限额定义在 `src/store.ts` 中。

## 添加来源或正文格式

在 `src/index.ts` 中向 `registerWebhook` 传入来源名称、包含认证逻辑的 Hono 中间件数组，以及读取正文的函数。例如，要从 CI 通知中仅提取作业名称，请在 `WorkerEnv` 的 `Bindings` 中加入 `CI_HOOK_TOKEN`，在 `.dev.vars` 中为其设置单独的随机密钥，并注册以下路由。

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
| `list_sources` | 无参数。列出有接收记录或投递规则的来源。 | 只读 |
| `get_delivery_status` | `id`（回执 ID）。返回投递信息，不含正文。 | 只读 |
| `set_source_paused` | `source`、`paused`（布尔值）。 | 管理 |
| `set_event_filter` | `source`、`types`（允许的事件类型数组）。空数组允许所有类型。 | 管理 |

如需轮换 Webhook 或 MCP 令牌，请修改 `.dev.vars` 中对应的值，运行 `npm run deploy`，并更新使用该令牌的发送端或连接器。

## 验证 SDK 兼容性

检出 Muse Gadget SDK 的提交 `e17081a45941415d483642dbe21c2a2e6ef85a13`，并在 Python 虚拟环境中安装其 `linux[test]` 包。将 `MUSE_PYTHON` 设为该环境的 Python 可执行文件路径，将 `MUSE_SDK_TESTS` 设为 SDK 中 `linux/tests` 目录的绝对路径。运行 `npm test` 即可使用测试凭据，在本地验证从接收 Webhook、经过 Worker 到 SDK 测试服务器收件的完整流程。
