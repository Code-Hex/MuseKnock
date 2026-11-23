# MuseKnock 运维与自定义指南

[English](operations.md) · [日本語](operations.ja.md) · **简体中文**

## 排查未收到的通知

请 Muse 按回执 ID 查询投递状态。即使尚未配置连接器，也可以用原来的 `Idempotency-Key` 重发 Webhook，查看该通知的状态。

| 状态 | 含义与排查方法 |
| --- | --- |
| `queued` | 正在排队。请检查桥接程序是否运行、`WORKER_URL` 是否正确，以及执行器是否已连接到 Muse。 |
| `sending` | 桥接程序已领取通知，正在尝试投递。 |
| `sent` | Gadget SDK 已确认接收。请在 `.env.bridge` 的 `MUSE_SESSION_ID` 指定的侧边对话中查看 Muse 的回复。 |
| `suppressed` | 来源已暂停，或事件类型不在允许列表中。该通知的投递已结束。 |
| `expired` | 通知已排队一小时，超过投递期限。 |
| `unknown` | 发送后连接中断，或获得投递许可后两分钟内没有收到结果。请先查看对话记录，再决定是否发送一条新通知。 |

如果桥接程序在写入 SDK 之前连接失败，或 SDK 明确报告尚未连接 Muse，MuseKnock 会按当前规则和有效期重试。Gadget SDK 没有用于消息投递的幂等键，因此不会自动重发 `unknown` 状态的通知。[SDK 本地投递协议](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/service.py#L277-L302)

如果找不到套接字，在 macOS 上进入 Muse Desktop Bridge 目录，运行 `./muse-executor/muse-executor status`。在 Linux 上运行 `sudo musegadget doctor`，检查守护进程及其运行账户。默认套接字在 macOS 上是 `~/muse-desktop-bridge/muse-executor/.runtime/muse.sock`，在 Linux 上是 `/run/musegadget/musegadget.sock`。如使用其他位置，请将绝对路径写入 `.env.bridge` 的 `MUSEGADGET_SOCKET`。执行器和 MuseKnock 桥接程序都需要保持运行。

## 在 Linux 重启后自动投递

使用有权访问 SDK 套接字的用户进行配置。先将 `.env.bridge` 的 `WORKER_URL` 设为部署后的地址，再用 Ctrl+C 退出手动启动的桥接程序。

在项目目录中运行以下命令，创建 systemd 用户服务。服务配置将使用当前目录和 Node.js 可执行文件的路径。

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

用 `journalctl --user -u museknock.service -f` 查看日志。如需在用户登录前启动服务，请让 Linux 管理员运行 `loginctl enable-linger 用户名`。运行 `systemctl --user disable --now museknock.service` 可停止服务并关闭自动启动。

## 发送 Webhook

向 `POST /hooks/default` 发送请求，用 `HOOK_TOKEN` 进行 Bearer 认证。

| 输入 | 处理方式 |
| --- | --- |
| `application/json` 或以 `+json` 结尾的子类型 | 验证 JSON 语法并投递原文，保留整数值和空白字符。 |
| `text/plain` 或无 Content-Type | 原样投递文本。 |
| `application/x-www-form-urlencoded` | 转换为名称与值的键值对数组，以保留重复字段。 |
| `X-Event-Type` | 过滤规则使用的事件类型，默认为 `notification`。来源名称和事件类型均为 1 至 64 个字符，以小写 ASCII 字母或数字开头，后续字符还可以包含 `_` 和 `-`。 |
| `Idempotency-Key` | 同一来源内的唯一事件标识符，最多 128 个可打印的 ASCII 字符，不含空格。省略时，每个 POST 都会作为新事件处理。 |

请求正文和解码后的文本各自最多为 32 KiB。正文只应包含希望交给 Muse 的信息。目标会话和凭据由桥接程序的配置决定。

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

如需轮换 Worker 凭据，请编辑 `.dev.vars` 并运行 `npm run deploy`。同时更新使用该令牌的发送端、桥接程序或连接器。
