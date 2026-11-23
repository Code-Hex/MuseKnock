# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock 在 Cloudflare Worker 中接收外部 Webhook，直接投递到你自己的 Muse 侧边对话。Worker 保存事件、检查投递规则，再通过 Gadget 协议发送消息。部署后可以关闭用于配置的电脑。

[快速开始](#快速开始) · [English](README.md) · [日本語](README.ja.md) · **简体中文**

```text
外部服务 ──Webhook──▶ Worker + Durable Object ──Gadget Link──▶ Muse 侧边对话
Muse ──MCP──▶ Worker（暂停来源、过滤事件、查询回执）
```

## 快速开始

你需要 Cloudflare 账户、自己的 Muse 账户和 Gadget SDK 令牌。初次配置用的电脑需要 Node.js 22.12 或更高版本以及 npm。SDK 令牌仅供本人在自己的 Muse 账户中用于个人、非商业用途。[SDK 令牌使用条款](https://gadgets.muse.ai/sdk-terms)

**1. 为 Worker 单独授权一个设备身份。** 选择以下一种方式，只需操作一次。交接后由 Worker 刷新这台设备的令牌。如果现有执行器或 SDK 守护进程已经使用这个身份，请在导入凭据前停止它并关闭自动重启。

- **无需蓝牙设备。** 在 Mac 上使用社区维护的 Muse Desktop Bridge 登录。按照其认证说明，用自己的账户和 SDK 令牌完成登录。登录后即可停止配置，无需启动执行器。下一步将从本地状态文件中导入设备凭据。[社区版登录说明](https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/3b6d0e0665d40d5537b21b701c18327e288741d9/muse-auth/README.md)
- **使用官方 Gadget SDK 配对。** 将一个专用设备与 Muse 应用配对，停止 SDK 守护进程，并准备该设备的 `pairing.json`。Linux SDK 默认将文件保存在 `/var/lib/musegadget/` 中。[官方配对说明](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md#install)

**2. 生成 Worker 配置。** 克隆 MuseKnock，在项目根目录运行 `npm ci`。选择与你的设备授权方式对应的命令，并将路径替换为自己私有文件的绝对路径。

```sh
# 社区版登录状态
npm run setup -- --device-state /path/to/muse-desktop-bridge/muse-auth/.state/state.json
```

```sh
# 官方 SDK 配对文件
npm run setup -- --pairing /path/to/pairing.json
```

安装程序会在本地写入仅文件所有者可读写的 `.dev.vars`。社区版导入只复制设备 ID、设备刷新令牌和 SDK 令牌。如果导入官方配对文件，还需在 `.dev.vars` 中手动填写 `MUSE_SDK_TOKEN`。包含用户会话凭据的原始文件请保留在本地。

如需手动配置，运行 `npm run setup`，再填写同一设备授权对应的 `MUSE_NODE_ID`、`MUSE_REFRESH_TOKEN` 和 `MUSE_SDK_TOKEN`。安装程序会生成 `HOOK_TOKEN`、`MCP_TOKEN`、`MCP_ADMIN_TOKEN` 和 `MUSE_SESSION_ID`。若要沿用已有侧边对话，请将其确切会话 ID 填入 `MUSE_SESSION_ID`。保留生成值会在首次投递成功时创建新的侧边对话。可选择设置 `MUSE_VM_ID` 以指定已分配的 VM。

**3. 部署 Worker。** 点击上方的 **Deploy to Cloudflare**，选择 Worker 名称，将部署命令设为 `npx wrangler deploy --minify`，并在 Secrets 中输入 `.dev.vars` 里的同名值。也可以在项目根目录使用下面的 CLI 命令部署。默认 Worker 名称为 `museknock`。如果账户中已有同名 Worker，先修改 `wrangler.jsonc` 中的 `name`。

```sh
npx wrangler login
npm run deploy
```

**4. 发送通知。** 将示例 URL 替换为部署后显示的 HTTPS 地址。发送端只需要 Webhook 令牌。

```sh
WORKER_URL=https://your-worker.your-subdomain.workers.dev
HOOK_TOKEN=$(node --env-file=.dev.vars -p 'process.env.HOOK_TOKEN')
curl -i "$WORKER_URL/hooks/default" \
  -H "Authorization: Bearer $HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Event-Type: build_failed' \
  -H 'Idempotency-Key: first-knock' \
  --data '{"project":"hello","message":"测试失败"}'
```

首次请求返回 HTTP `202` 及回执 ID。Worker 安排投递，并将消息发送到 `MUSE_SESSION_ID` 指定的侧边对话。请在 Muse 中查看通知。使用相同的 `Idempotency-Key` 重发会返回 HTTP `200`、原回执 ID 和当前状态。新通知请使用新的幂等键。

## 在 Muse 中管理通知

在 Muse 的 **Settings → Connectors** 中创建自定义连接器，将 URL 设为 Worker 的 `/mcp` 端点，选择 Bearer 认证，并填入 `.dev.vars` 中对应的令牌。请在自己的账户中确认是否可以使用自定义连接器。[Meta 连接器指南](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

| 令牌 | 可以向 Muse 提出的请求 |
| --- | --- |
| `MCP_TOKEN`（只读） | “列出通知来源。”“查询回执 ID … 的投递状态。” |
| `MCP_ADMIN_TOKEN`（读写） | “暂停 default。”“default 只允许 build_failed 事件。”“恢复 default。” |

暂停来源会同时拦下尚在排队的通知。恢复来源只影响之后的投递，已开始发送的通知仍可能送达。

## 在本地试用

用 `npm ci`、`npm test` 和 `npm run check` 运行本地 Worker 测试并检查类型。用 `npm run deploy -- --dry-run` 检查部署包。使用真实凭据运行 `npm run dev` 时，请使用单独授权的设备身份，以免与已部署的 Worker 同时刷新同一令牌。测试验证了本地投递协议，尚未验证向真实 Muse 账户投递。

如需添加来源、处理自定义 Webhook 格式、了解限流规则或排查投递问题，请参阅[运维与自定义指南](docs/operations.zh-CN.md)。
