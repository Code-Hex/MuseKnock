# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock 通过 Cloudflare Workers 把 Webhook 通知发送到已有的 Muse 侧边对话。你可以在 Muse 中通过 MCP 连接器选择目标对话。关闭电脑后，Worker 会继续投递通知。

[快速开始](#快速开始) · [English](README.md) · [日本語](README.ja.md) · **简体中文**

## 快速开始

请准备 Cloudflare 和 GitHub 账户、已获授权的 Muse 设备凭据，以及设备向现有对话发消息时使用的确切会话 ID。SDK 令牌仅供你在自己的 Muse 账户中用于个人、非商业用途。[首次授权设备](docs/operations.zh-CN.md#首次授权设备) · [SDK 令牌使用条款](https://gadgets.muse.ai/sdk-terms)

**1. 从 Cloudflare 部署。** 点击上方的 **Deploy to Cloudflare**，选择 Worker 名称，在部署表单的 Worker 密钥栏填写以下六项。在密码管理器中为前三项分别生成足够长的随机字母数字串。[Cloudflare 部署按钮说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/#worker-environment-variables-and-secrets)

| Worker 密钥 | 值 |
| --- | --- |
| `HOOK_TOKEN` | Webhook 发送端使用的令牌 |
| `MCP_TOKEN` | Muse 只读连接器使用的令牌 |
| `MCP_ADMIN_TOKEN` | Muse 管理连接器使用的令牌，可配置目标对话和发送测试通知 |
| `MUSE_NODE_ID` | 官方 `pairing.json` 中的 `node_id`，或社区版 `state.json` 中的 `device.device_id` |
| `MUSE_REFRESH_TOKEN` | 官方文件中的 `refresh_token`，或社区版文件中的 `device.refresh_token` |
| `MUSE_SDK_TOKEN` | 官方设备配对时使用的 SDK 令牌，或社区版文件中的 `sdk_token` |

如果已有执行器或 SDK 守护进程使用相同的设备身份，请先将其停止并关闭自动重启。移交后 Worker 会刷新设备凭据。只将表中指定的三项设备信息复制到 Cloudflare，原始文件和账户凭据应保留在你自己手中。部署 Worker，复制部署完成后显示的 HTTPS 地址。

**2. 连接 Muse。** 在 Muse 的 **Settings → Connectors** 中添加一个自定义连接器。在已部署 Worker 的 URL 后加上 `/mcp`，选择 Bearer 身份验证，将 `MCP_ADMIN_TOKEN` 填入令牌栏。[Muse 连接器指南](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

**3. 通过 Muse 注册对话并测试投递。** 可以按顺序向连接器提出以下请求。

1. “检查我的 MuseKnock 配置。” `get_setup_status` 检查 Worker 中的配置。下面的测试消息用于验证实际投递。
2. “将现有会话 `已有会话ID` 注册为‘构建通知’，并设为通知目标。”请使用设备原来的 `--session-id`，或旧部署中的 `MUSE_SESSION_ID`。`register_side_chat` 保存的是 MuseKnock 中的名称。使用陌生的 ID，首次投递时可能会创建新对话。[Gadget SDK 侧边对话说明](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md)
3. “发送一条测试通知并检查回执。”Muse 使用新的 UUID 作为 `requestId` 调用 `send_test_notification`，然后用返回的回执 ID 调用 `get_delivery_status`。当状态为 `sent` 时，打开所选对话查看消息。重试同一次测试时，请使用相同的请求 ID。

**4. 连接事件来源。** 在发送服务的 Webhook 设置中，将请求设为发往同一 Worker 的 `/hooks/default` 的 `POST`，添加 `Authorization: Bearer YOUR_HOOK_TOKEN` 和 `Content-Type: application/json`。发送 `{"message":"构建完成"}` 等正文后会收到回执 ID。之后可以在 Muse 中查看投递状态、暂停来源或筛选事件类型。

## 切换目标对话

告诉管理连接器另一个名称和会话 ID，注册后再说“将通知切换到这个对话”。如果尚未选择目标，首次注册的对话会自动成为默认目标。切换只影响接下来收到的通知。排队或重试中的通知仍按接收时确定的目标投递。已有部署如果配置了 `MUSE_SESSION_ID`，原对话会以 `default` 作为注册名。

使用 `MCP_TOKEN` 的只读连接器可以列出已注册的对话、查看回执。管理连接器还可以暂停来源或设置事件类型过滤条件。可选的 CLI 安装方式、Webhook 格式及投递排查方法见[运维指南](docs/operations.zh-CN.md)。
