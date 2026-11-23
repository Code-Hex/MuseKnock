# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock 通过 Cloudflare Workers 把 Webhook 通知发送到已有的 Muse 侧边对话。你可以在 Muse 中通过 MCP 连接器选择目标对话。关闭电脑后，Worker 会继续投递通知。

[快速开始](#快速开始) · [English](README.md) · [日本語](README.ja.md) · **简体中文**

## 快速开始

部署和配置都可以在浏览器中完成。请准备 Cloudflare 和 GitHub 账户、已获授权的 Muse 设备凭据，以及设备向现有对话发消息时使用的确切会话 ID。如果尚未授权设备，请参阅[首次授权设备](docs/operations.zh-CN.md#首次授权设备)。Gadget SDK 令牌仅供你在自己的 Muse 账户中用于个人、非商业用途。[SDK 令牌使用条款](https://gadgets.muse.ai/sdk-terms)

**1. 部署 Worker。** 点击上方的 **Deploy to Cloudflare**，选择 Worker 名称并保留默认部署命令。部署完成后，在 Worker 的 HTTPS 地址后加上 `/setup` 并打开。该页面可以生成三个独立的访问令牌，也可以在浏览器中从你选择的官方 SDK `pairing.json` 或社区版 `state.json` 中读取设备信息。文件不会上传。

**2. 配置六个运行时密钥。** 在 Cloudflare 的 **Workers & Pages** 中选择你的 Worker，打开 **Settings → Variables and Secrets**，将以下各项以 **Secret** 类型添加，再点击 **Deploy**。请将三个访问令牌保存在密码管理器中。[Cloudflare Worker 密钥指南](https://developers.cloudflare.com/workers/configuration/secrets/)

| Worker 密钥 | 值 |
| --- | --- |
| `HOOK_TOKEN` | Webhook 发送端专用的随机令牌 |
| `MCP_TOKEN` | Muse 只读连接器专用的随机令牌 |
| `MCP_ADMIN_TOKEN` | 管理目标对话的连接器专用的随机令牌 |
| `MUSE_NODE_ID` | 已授权设备的节点 ID |
| `MUSE_REFRESH_TOKEN` | 该设备当前的刷新令牌 |
| `MUSE_SDK_TOKEN` | 授权设备时使用的 Gadget SDK 令牌。导入官方配对文件时需要单独填写。 |

也可以用密码管理器分别生成三个由字母和数字组成的长随机令牌。交接后，Worker 会刷新设备令牌。如果已有执行器或 SDK 守护进程使用相同的设备身份，请先将其停止并关闭自动重启。

**3. 在 Muse 中注册已有对话。** 在 **Settings → Connectors** 中为 `https://YOUR-WORKER.workers.dev/mcp` 创建自定义连接器，你的 Worker 的 `/setup` 页面会显示完整的连接器和 Webhook 地址。选择 Bearer 认证，在连接器的令牌栏输入 `MCP_ADMIN_TOKEN`。[Muse 连接器指南](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

告诉 Muse：“把会话 ID 为 `已有会话ID` 的侧边对话注册为 `builds`，将它选为通知目标，再显示当前目标。”请填入设备发送消息时传给 `--session-id` 的值，或旧版 MuseKnock 使用的 `MUSE_SESSION_ID`。`builds` 是在 MuseKnock 中使用的名称。MuseKnock 无法按对话标题查询会话 ID，向陌生的 ID 投稿可能会建立新的对话。[Gadget SDK 侧边对话说明](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md)

**4. 发送通知。** 在发送服务的 Webhook 设置中，向 Worker 的 `/hooks/default` 发送 `POST`，添加 `Authorization: Bearer YOUR_HOOK_TOKEN` 和 `Content-Type: application/json`，正文可用 `{"message":"构建已完成"}`。测试时加上 `Idempotency-Key: first-knock`。HTTP `202` 会返回回执 ID，你可以用它向 Muse 查询投递状态，并打开所选对话查看消息。使用同一个键重发将返回当前状态。

## 切换目标对话

告诉管理连接器另一个名称和会话 ID，注册后再说“将通知切换到这个对话”。如果尚未选择目标，首次注册的对话会自动成为默认目标。切换只影响接下来收到的通知。排队或重试中的通知仍按接收时确定的目标投递。已有部署如果配置了 `MUSE_SESSION_ID`，原对话会以 `default` 作为注册名。

使用 `MCP_TOKEN` 的只读连接器可以列出已注册的对话、查看回执。管理连接器还可以暂停来源或设置事件类型过滤条件。可选的 CLI 安装方式、Webhook 格式及投递排查方法见[运维指南](docs/operations.zh-CN.md)。
