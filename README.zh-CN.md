# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock 可以将外部服务的 Webhook 通知发送到你自己的 Muse 侧边对话。例如，你可以接入构建通知，再告诉 Muse：“这个来源只发构建失败的通知。”

[快速开始](#快速开始) · [English](README.md) · [日本語](README.ja.md) · **简体中文**

```text
外部服务 ──Webhook──▶ Cloudflare Worker ──▶ SQLite 队列
Muse ──MCP──▶ Cloudflare Worker（管理投递规则）
Mac 或 Linux 桥接程序 ──出站 HTTPS──▶ Worker（获取下一条通知）
桥接程序 ──▶ 本地执行器 ──▶ Gadget SDK ──▶ Muse 侧边对话
```

## 快速开始

你需要 Cloudflare 账户、自己的 Muse 账户和 Gadget SDK 令牌，以及 Node.js 22.12 或更高版本和 npm。请在保持在线的 Mac 或 Linux 主机上运行桥接程序。Mac 方案使用账户登录，无需蓝牙配对或单独的 Linux 设备。

**1. 连接本地执行器。选择以下一种方式。**

**macOS。** 安装 `uv` 并使用社区维护的 Muse Desktop Bridge。其安装程序可以安装 Python 3.13。交互式登录自己的 Muse 账户并完成验证，将令牌保存在 Mac 上。执行器允许 Muse 以当前 macOS 用户的权限运行命令和读写文件，请使用专用用户。需要接收通知时，请保持 Mac 唤醒。[Muse Desktop Bridge 安装说明](https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/3b6d0e0665d40d5537b21b701c18327e288741d9/README.md#quick-start)

```sh
git clone https://github.com/chaitanyarahalkar/muse-desktop-bridge.git ~/muse-desktop-bridge
cd ~/muse-desktop-bridge
git checkout 3b6d0e0665d40d5537b21b701c18327e288741d9
./scripts/setup.sh
python3 muse-auth/muse_auth.py setup
./muse-executor/muse-executor start
./muse-executor/muse-executor status
```

等待 `status` 确认执行器已连接。MuseKnock 默认使用该目录中的套接字。如果克隆到了其他位置，请将 `muse-executor/.runtime/muse.sock` 的绝对路径写入 `.env.bridge` 的 `MUSEGADGET_SOCKET`。

**Linux。** 准备一台支持低功耗蓝牙配对的 64 位 Linux 主机。使用自己的 Gadget SDK 令牌安装官方 Linux SDK，然后在手机的 **Settings → Devices** 中添加设备。Muse 可以使用运行 SDK 的 Linux 账户权限，因此建议使用专用账户。SDK 令牌仅供本人在自己的 Muse 账户中用于个人、非商业用途。[Linux SDK 安装说明](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md#install) · [SDK 令牌使用条款](https://gadgets.muse.ai/sdk-terms)

**2. 生成配置。** 克隆此仓库，在项目根目录执行以下命令。

```sh
npm ci
npm run setup
```

安装脚本将 Worker 的令牌写入 `.dev.vars`，将桥接程序的连接配置和目标对话 ID 写入 `.env.bridge`。只有文件所有者可以读写这两个文件。再次运行脚本会保留已有配置。

**3. 部署 Worker。** 点击上方的 **Deploy to Cloudflare**，选择 Worker 名称，将部署命令设为 `npx wrangler deploy --minify`。在四个 Secret 输入框中分别填入 `.dev.vars` 中的同名值，然后部署。

如需使用命令行部署，请执行以下命令。默认 Worker 名称为 `museknock`。如果账户中已有同名 Worker，先修改 `wrangler.jsonc` 中的 `name`。

```sh
npx wrangler login
npm run deploy
```

将部署后得到的 `https://…workers.dev` 地址填入 `.env.bridge` 的 `WORKER_URL`。若需继续使用已有的 Gadget 侧边对话，请将 `MUSE_SESSION_ID` 设为该对话的会话 ID。保留自动生成的 ID 会在首次投递时新建侧边对话。如果从其他电脑部署，请在执行器主机上也安装 MuseKnock 和依赖，并安全复制 `.env.bridge`。

**4. 启动桥接程序。** 在执行器主机上的 MuseKnock 目录中，以有权访问套接字的用户运行以下命令。请保持执行器和桥接程序持续运行。

```sh
npm run bridge
```

**5. 发送通知。** 在另一个终端中进入第 2 步的目录。以下示例会加载两个配置文件。如果文件位于不同设备，请在发送端加载 `.dev.vars`，并将 `WORKER_URL` 设为已部署的地址。

```sh
. ./.dev.vars
. ./.env.bridge
curl -i "$WORKER_URL/hooks/default" \
  -H "Authorization: Bearer $HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Event-Type: build_failed' \
  -H 'Idempotency-Key: first-knock' \
  --data '{"project":"hello","message":"测试失败"}'
```

首次请求返回 HTTP `202` 和一个回执 ID。桥接程序通常会在 10 秒内发起下一次轮询。请在 Muse 侧边对话中查看通知。重复执行同一命令会返回 HTTP `200`、相同的 ID 和当前投递状态。发送下一条通知时请更换幂等键。

## 在 Muse 中管理通知

在 Muse 的 **Settings → Connectors** 中创建自定义连接器，将 URL 设为 Worker 的 `/mcp` 端点，选择 Bearer 认证，并填入 `.dev.vars` 中对应的令牌。请在自己的账户中确认是否可以使用自定义连接器。[Meta 连接器指南](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

| 令牌 | 可以向 Muse 提出的请求 |
| --- | --- |
| `MCP_TOKEN`（只读） | “列出通知来源。”“查询回执 ID … 的投递状态。” |
| `MCP_ADMIN_TOKEN`（读写） | “暂停 default。”“default 只允许 build_failed 事件。”“恢复 default。” |

暂停来源也会拦下该来源正在排队的通知。恢复后，已拦下的通知不会补发。已经交给桥接程序的通知仍有可能送达。

## 在本地试用

```sh
npm ci
npm run setup
npm run dev
```

将第 5 步的 `WORKER_URL` 设为 `http://127.0.0.1:8787` 即可在本地试用同一个 Webhook。即使没有已连接的执行器或 Muse 账户，也可以运行 `npm test`，通过本地 Worker 和测试用 SDK 套接字验证投递流程。使用 `npm run check` 检查类型，使用 `npm run deploy -- --dry-run` 检查部署包。

如需添加来源、处理自定义 Webhook 格式、了解限流规则或排查投递问题，请参阅[运维与自定义指南](docs/operations.zh-CN.md)。
