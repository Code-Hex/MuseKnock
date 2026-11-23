# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock delivers webhooks from Cloudflare Workers to an existing Muse side chat. You choose the destination in Muse through an MCP connector. The Worker handles delivery while your computer is off.

[Quick start](#quick-start) · **English** · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

## Quick start

You can deploy and configure MuseKnock in a browser. Have your Cloudflare and GitHub accounts ready, along with an authorized Muse device identity and the exact session ID your gadget uses for the existing chat. If you need a device identity, see the [one-time authorization options](docs/operations.md#authorize-a-device). Use the Gadget SDK token for personal, non-commercial use with your own Muse account. [SDK token terms](https://gadgets.muse.ai/sdk-terms)

**1. Deploy the Worker.** Click **Deploy to Cloudflare** above, choose a Worker name, and keep the suggested deploy command. Open the resulting HTTPS Worker URL with `/setup` appended. This page runs in your browser. It can generate three independent access tokens and read the device fields from your selected SDK `pairing.json` or community `state.json`. The file stays in the browser.

**2. Save the six runtime secrets.** Open your Worker in **Workers & Pages → Settings → Variables and Secrets**. Add each value below as type **Secret**, then select **Deploy**. Save the three access tokens in your password manager. [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

| Worker secret | Value |
| --- | --- |
| `HOOK_TOKEN` | Random token for the webhook sender |
| `MCP_TOKEN` | Separate random token for a read-only Muse connector |
| `MCP_ADMIN_TOKEN` | Separate random token for the connector that manages destinations |
| `MUSE_NODE_ID` | The authorized device’s node ID |
| `MUSE_REFRESH_TOKEN` | The current refresh token for that device |
| `MUSE_SDK_TOKEN` | The Gadget SDK token used to authorize the device. Enter it separately when importing an official pairing. |

You can generate the three access tokens in a password manager instead. Use long, independent random strings made of letters and digits. Stop any executor or SDK daemon using this device identity and disable its automatic restart before handing it over. The Worker will rotate the device token.

**3. Register your existing chat in Muse.** Open **Settings → Connectors**, create a custom connector for `https://YOUR-WORKER.workers.dev/mcp`, and choose Bearer authentication. Enter `MCP_ADMIN_TOKEN` in the connector’s token field. The setup page shows your exact connector and webhook URLs. [Muse connector guide](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

Ask Muse: “Register my side chat as `builds` with session ID `YOUR-EXISTING-SESSION-ID`, select `builds` for notifications, and show me the active chat.” Use the value passed to the original gadget’s `--session-id`, or the previous MuseKnock deployment’s `MUSE_SESSION_ID`. The name `builds` is a local label. MuseKnock cannot look up a Muse conversation by title, and posting with an unfamiliar ID can start a new chat. [Gadget SDK side chats](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md)

**4. Send a notification.** In your webhook sender’s settings, send a `POST` to your Worker’s `/hooks/default` with `Authorization: Bearer YOUR_HOOK_TOKEN`, `Content-Type: application/json`, and a body such as `{"message":"Build finished"}`. Give the test event an `Idempotency-Key` such as `first-knock`. HTTP `202` returns a receipt ID. Ask Muse to check that receipt and open the selected chat. Repeating the same event with the same key returns its current status.

## Change the destination

Ask the admin connector to register another name and session ID, then say “Switch notifications to that chat.” The first registration becomes active if there is no destination yet. Switching affects newly accepted notifications. Queued deliveries and retries keep the destination they had when accepted. An existing deployment with `MUSE_SESSION_ID` starts with that chat as `default`.

A connector configured with `MCP_TOKEN` can list registered chats and check receipts. The admin connector can also pause sources and filter event types. For optional CLI setup, webhook formats, and troubleshooting, see the [operations guide](docs/operations.md).
