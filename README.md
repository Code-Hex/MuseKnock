# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock delivers webhooks from Cloudflare Workers to an existing Muse side chat. You choose the destination in Muse through an MCP connector. The Worker handles delivery while your computer is off.

[Quick start](#quick-start) · **English** · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

## Quick start

Have your Cloudflare and GitHub accounts, an authorized Muse device, and the exact session ID your gadget uses for the existing chat ready. The SDK token is for personal, non-commercial use with your own Muse account. [One-time device authorization](docs/operations.md#authorize-a-device) · [SDK token terms](https://gadgets.muse.ai/sdk-terms)

**1. Deploy from Cloudflare.** Click **Deploy to Cloudflare** above. Choose a Worker name and fill in the six Worker secrets in the deployment form. Generate three different long random alphanumeric tokens in your password manager for the first three rows. [Cloudflare deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/#worker-environment-variables-and-secrets)

| Worker secret | Value |
| --- | --- |
| `HOOK_TOKEN` | Token for your webhook sender |
| `MCP_TOKEN` | Token for a read-only Muse connector |
| `MCP_ADMIN_TOKEN` | Token for the Muse connector that will configure and test delivery |
| `MUSE_NODE_ID` | Official `pairing.json`: `node_id`. Community `state.json`: `device.device_id`. |
| `MUSE_REFRESH_TOKEN` | Official: `refresh_token`. Community: `device.refresh_token`. |
| `MUSE_SDK_TOKEN` | The SDK token used for the official pairing, or `sdk_token` in community state. |

Stop any executor or SDK daemon that uses this device identity and disable its automatic restart before handing it over. The Worker will rotate the device credentials. Copy only the three named device values into Cloudflare. Keep the source file and account credentials private. Deploy the Worker and copy its HTTPS URL.

**2. Connect Muse.** In Muse **Settings → Connectors**, add one custom connector. Append `/mcp` to the deployed Worker URL, choose Bearer authentication, and enter `MCP_ADMIN_TOKEN` in the token field. [Muse connector guide](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

**3. Register and test the chat from Muse.** You can ask the connector to do each step in plain language.

1. “Check my MuseKnock configuration.” `get_setup_status` checks local settings. The test post below checks delivery.
2. “Register the existing session `YOUR-EXISTING-SESSION-ID` as `builds` and select it for notifications.” Use the exact `--session-id` from your gadget or the previous deployment’s `MUSE_SESSION_ID`. `register_side_chat` saves the destination. MuseKnock can list its registered names. An unfamiliar session ID may create a new chat on first delivery. [Gadget SDK side chats](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md)
3. “Send one test notification and check its receipt.” Muse calls `send_test_notification` with a fresh UUID as `requestId`, then `get_delivery_status` with the returned receipt ID. Look in the selected chat when the status is `sent`. Reuse the same request ID when retrying the same test.

**4. Connect your event source.** For Slack, LINE, Twilio, Telegram, or WeCom, follow [Connect a service directly](#connect-a-service-directly). For a sender that supports a custom Bearer header, use the generic webhook below.

In the sending service, configure `POST /hooks/default` on the same Worker, with `Authorization: Bearer YOUR_HOOK_TOKEN` and `Content-Type: application/json`. A body such as `{"message":"Build finished"}` returns a receipt ID. You can ask Muse to check that receipt, pause sources, and filter event types.

## Connect a service directly

Open your Worker in Cloudflare, go to **Settings → Variables and Secrets**, add the secrets for the service you use, and deploy the changes. Append the path below to your public HTTPS Worker URL. Each endpoint uses the service's own authentication. Keep `HOOK_TOKEN` for `/hooks/default`.

| Service | Worker secrets | Register the URL and check delivery |
| --- | --- | --- |
| Slack Events API | `SLACK_SIGNING_SECRET` from **Basic Information → App Credentials** | Turn on **Event Subscriptions**, enter `/hooks/slack` as the Request URL and wait for **Verified**. Subscribe to a bot event such as `app_mention`, approve the required scopes and install or reinstall the app. Invite it to a channel and mention it. [Slack request URLs](https://docs.slack.dev/apis/events-api/using-http-request-urls/) |
| LINE Messaging API | `LINE_CHANNEL_SECRET` from the channel's **Basic settings** | Under **Messaging API**, set the Webhook URL to `/hooks/line`, click **Verify** and enable **Use webhook**. Enable **Webhook redelivery** to retry failed requests. Send the official account a message. The signed verification request has an empty event list and creates no notification. [LINE webhook verification](https://developers.line.biz/en/docs/messaging-api/verify-webhook-url/) |
| Twilio incoming SMS/MMS | `TWILIO_AUTH_TOKEN`, the primary Auth Token of the account that owns the number | In **Active Numbers**, open the number's messaging configuration. Set **A message comes in → Webhook → HTTP POST** to the exact public URL ending in `/hooks/twilio` and save. Send the number an SMS. The Worker returns empty TwiML, so the sender receives no automatic reply. [Twilio incoming messages](https://www.twilio.com/docs/messaging/guides/webhook-request) |
| WeCom (企业微信), internal app | `WECOM_CORP_ID` from **My Enterprise** and the app callback's `WECOM_TOKEN` and `WECOM_ENCODING_AES_KEY` | In **应用管理 → 自建 → 接收消息 → 设置 API 接收**, enter `/hooks/wecom` and the matching Token and EncodingAESKey. If the console requires an organization-registered domain, use a matching custom domain for the Worker. Save to verify the encrypted URL challenge, then send a message to the app. [WeCom callbacks](https://developer.work.weixin.qq.com/document/path/90930) |

**Telegram Bot API.** Create a bot with @BotFather. Generate a separate random secret using letters, digits, underscores or hyphens (1–256 characters) and save it as `TELEGRAM_WEBHOOK_SECRET` in Cloudflare. In an HTTPS client, call `setWebhook` with the values shown below. In the shell example, set `BOT_TOKEN` to the BotFather token and `WORKER_URL` to the Worker origin without a trailing slash. The bot token is needed only when calling Telegram. Registering the URL replaces this bot's current webhook. [Telegram webhook setup](https://core.telegram.org/bots/api#setwebhook)

```sh
curl --fail-with-body -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/hooks/telegram" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","edited_message","channel_post","edited_channel_post"]'
curl --fail-with-body "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

Check that `getWebhookInfo` returns your URL, then open a private chat with the bot and send a message. MuseKnock forwards messages, channel posts and their edits, including text or captions when present. Check the selected Muse chat to confirm delivery. Anyone who can message the bot can trigger a notification.

## Change the destination

Ask the admin connector to register another name and session ID, then say “Switch notifications to that chat.” The first registration becomes active if there is no destination yet. Switching affects newly accepted notifications. Queued deliveries and retries keep the destination they had when accepted. An existing deployment with `MUSE_SESSION_ID` starts with that chat as `default`.

A connector configured with `MCP_TOKEN` can list registered chats and check receipts. The admin connector can also pause sources and filter event types. For optional CLI setup, webhook formats, and troubleshooting, see the [operations guide](docs/operations.md).
