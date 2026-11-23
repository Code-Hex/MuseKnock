# Operate and customize MuseKnock

**English** · [日本語](operations.ja.md) · [简体中文](operations.zh-CN.md)

## Authorize a device

Prepare one device identity exclusively for this Worker. Get the SDK token from **Account → SDK tokens** on [Muse Gadgets](https://gadgets.muse.ai/).

- **Official pairing.** Pair a dedicated gadget in the Muse app. Stop its SDK daemon before taking the current values from `pairing.json` (normally in `/var/lib/musegadget/` on Linux). Use `node_id`, `refresh_token`, and the SDK token used at pairing. [Official pairing instructions](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md#install)
- **Community sign-in from a browser.** If you have no paired hardware and are comfortable signing in with a third-party tool, open the Muse Desktop Bridge repository in a personal GitHub Codespace. In its browser terminal run `git checkout 3b6d0e0665d40d5537b21b701c18327e288741d9`, then `python3 muse-auth/muse_auth.py setup`. Complete the prompts for your own account, including OTP or two-factor authentication, and supply your SDK token. Account checkpoints may require the Muse app. This path has not been tested with a live account in Codespaces. [Community sign-in](https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/3b6d0e0665d40d5537b21b701c18327e288741d9/muse-auth/README.md) · [Open Muse Desktop Bridge in a Codespace](https://codespaces.new/chaitanyarahalkar/muse-desktop-bridge) · [GitHub Codespaces instructions](https://docs.github.com/en/codespaces/developing-in-a-codespace/creating-a-codespace-for-a-repository)

For community sign-in, open `muse-auth/.state/state.json` in your private Codespace editor and copy only `sdk_token`, `device.device_id`, and `device.refresh_token` to the corresponding Worker secrets in the deployment form. Keep the full file and the account’s session credentials inside your Codespace. Once the Worker has the device credentials, you can delete the Codespace. [Deployment steps](../README.md#quick-start)

For the first deployment, set these five Worker secrets. Generate an independent random bearer token for `MCP_ADMIN_TOKEN` and a separate 32-byte random key encoded as 64 hexadecimal characters for `CREDENTIAL_ENCRYPTION_KEY`. Enter the three device values together as `MUSE_NODE_ID`, `MUSE_SDK_TOKEN`, and `MUSE_REFRESH_TOKEN`. The admin connector also needs your Worker’s `/mcp` URL and the existing side chat’s session ID.

Register the side chat with the admin connector and confirm that a test notification reaches it. You can then remove all three device secrets together in one deployment. Keep `MCP_ADMIN_TOKEN` and the original `CREDENTIAL_ENCRYPTION_KEY`. On its next start, the Worker uses the encrypted pairing in its Durable Object. Supplying just one or two of the three device values blocks delivery until the configuration is complete or all three are removed.

For Shortcuts and other senders using `/v1/hooks/custom`, set a separate random Worker secret named `HOOK_TOKEN`. For a read-only MCP connector, set another independent secret named `MCP_TOKEN`.

## Trace a notification

Ask Muse to check the delivery status for the receipt ID. You can also repeat the original webhook with the same `Idempotency-Key` before setting up the connector.

| State | What it means |
| --- | --- |
| `queued` | Waiting for a Worker delivery attempt. Check the saved pairing, device authorization, and VM lease. |
| `sending` | The Worker has claimed this event and is connecting or posting. |
| `sent` | Muse acknowledged the post. Open the side chat selected when the Worker accepted the notification. |
| `suppressed` | The Worker stopped delivery. A source rule, a retracted message, or the circuit breaker can suppress a queued event. `message_retracted` means Slack or X deleted the message, or LINE withdrew it, before delivery. For a breaker decision, check the receipt's `reason`. `source_open` means this source reached its limit. `circuit_open` means the combined attempt count reached the global limit. The Worker checks that the chat exists immediately before posting. A `side_chat_missing` receipt means Muse returned 404. Select an existing chat through MCP to resume new deliveries. Previously suppressed notifications stay suppressed. |
| `expired` | The notification waited for one hour after receipt. Its delivery window has closed. |
| `unknown` | The Worker could not confirm the outcome after a possible send, or the two-minute delivery authorization expired. Check the side chat before sending another notification. |

If a delivery fails before submission, other chats can still receive notifications while that delivery waits for a retry. If the post may already have reached Muse, the Worker records `unknown` and leaves the decision to you. This avoids duplicating a post when its acknowledgement is lost. [Gadget SDK chat transport](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/link_client.py)

Each receipt keeps its device pairing, VM and session ID. If you change the pairing or VM configuration, restore it before expiry to resume waiting deliveries. Register the destination through MCP for each new pairing.

## Recover the credential encryption key

The Worker encrypts saved Muse device tokens and Bluesky sessions with AES-256-GCM. Keep `CREDENTIAL_ENCRYPTION_KEY` in your password manager. Use the same key for each deployment of this Worker. If `get_setup_status` reports `credentialStorageReady: false`, check the Worker secret and restore the original value from your backup. A replacement key cannot open records encrypted with the lost key. If the original key is unavailable, deploy a new Worker with fresh storage and perform the initial setup with a newly authorized pairing.

## Renew device authorization

If Muse revokes the pairing, authorize a dedicated device again and deploy all three new device values together. Register the side chat for the new pairing and confirm a test notification before removing those three settings. A fresh Durable Object also needs the initial setup. Keep each authorized device identity exclusive to one running Worker or SDK daemon.

The Worker uses the standard device API at `api.muse.ai` and the encrypted Link gateway at `hatch.metaaivm.com`. If you set `MUSE_VM_ID`, check that a lease exists for that exact VM. Without an explicit VM, registration uses the default lease or the first available lease. Selecting a verified name again uses its saved VM. To move the name to the current default VM, call `register_side_chat` again with the name and session ID. [Gadget SDK device API](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/muse_api.py)

## Send a webhook

Send `POST /v1/hooks/custom` with `HOOK_TOKEN` as the Bearer token. Use `custom` as the source name in MCP pause and filter rules.

| Input | Behavior |
| --- | --- |
| `application/json` or a `+json` subtype | Checks JSON syntax and delivers the original text, preserving integer values and whitespace. |
| `text/plain` or no Content-Type | Delivers the text as received. |
| `application/x-www-form-urlencoded` | Converts fields to an array of name/value pairs to preserve repeated field names. |
| `X-Event-Type` | Event type used by filters. Defaults to `notification`. Source names and event types are 1 to 64 characters. Start with a lowercase ASCII letter or digit. Subsequent characters can also include `_` and `-`. |
| `Idempotency-Key` | Unique event identifier within a source. Use up to 128 printable ASCII characters, excluding spaces. Omit the key to treat each POST as a new event. |

The request body and the decoded text may each be up to 32 KiB. Include only the information you intend to send to Muse. The Worker records the active destination when accepting each new event.

The built-in service endpoints accept request bodies up to 512 KiB. Each resulting notification can contain up to 32 KiB of text. They reply in the format the service expects. To pause or filter notifications through MCP, use the source name from the URL (for example, `telegram`) and the event type (for example, `edited_message`). [Service setup](../README.md#connect-a-service-directly)

Each source can submit 10 new events per rolling 60 seconds. Excess requests receive HTTP `429` and `Retry-After: 60`. Across all sources, the store authorizes up to three delivery attempts per rolling 60 seconds, one at a time. Retries count toward this limit. Receipt lookup and deduplication cover seven days from receipt. The next store operation applies expiry and removes old history. The limits are defined in `src/store.ts`.

## Add a source or payload format

In `src/index.ts`, pass a source name, an array of Hono middleware including authentication, and a body decoder to `registerWebhook`. To deliver only the job name from CI notifications, add `CI_HOOK_TOKEN` to the `WorkerEnv` bindings, add its value as a separate random Worker secret, and register this route.

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

After redeploying, send notifications to `POST /v1/hooks/ci`. To verify a source-specific signature, read `c.req.raw.clone()` in middleware before decoding the body. You can add rate limits or filters after authentication. The Durable Object enforces the shared delivery limit across locations. [Hono middleware](https://hono.dev/docs/guides/middleware) · [Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## MCP tools

| Tool | Arguments and result | Access |
| --- | --- | --- |
| `get_setup_status` | Returns `deviceConfigured`, `credentialStorageReady`, `active`, and `ready` from local configuration. | Read |
| `send_test_notification` | `requestId` (UUID). Enqueues a fixed test notification for the active chat and returns its receipt. The source is `museknock-test` and the event type is `test`. | Admin |
| `list_side_chats` | Lists locally registered names and session IDs, and identifies the active destination. | Read |
| `register_side_chat` | `name`, `sessionId`. Creates or updates the registration. The first chat becomes active when no destination is configured. | Admin |
| `set_active_side_chat` | `name`. Selects an existing registration for future notifications. | Admin |
| `list_sources` | No arguments. Lists sources with receipt history or delivery rules. | Read |
| `get_delivery_status` | `id` (receipt ID). Returns delivery metadata without the event body. | Read |
| `get_delivery_breaker` | Returns the global budget and attempts used by each source. | Read |
| `rearm_delivery_breaker` | `expectedGeneration`. Resets both budgets once a limit is reached and all in-flight sends finish. | Recovery |
| `set_source_paused` | `source`, `paused` (boolean). | Admin |
| `set_event_filter` | `source`, `types` (array of allowed event types). An empty array allows all types. | Admin |

Registration names are case-sensitive, with 1 to 64 characters after trimming. Start with a Unicode letter or number. You may then use letters, numbers, combining marks, spaces, periods, underscores, and hyphens. Session IDs are case-sensitive and accept 1–64 ASCII letters, digits or hyphens. Registration and selection verify that the session exists on Muse before changing the destination. Use the original gadget session ID to continue an existing chat. An authenticated notification returns HTTP `503` until the Worker can load the pairing and has an active destination.

To rotate webhook or MCP tokens, update the corresponding Worker secrets in Cloudflare and deploy the changes. Update the sender or connector that uses each token.

## Verify SDK compatibility

With the Muse Gadget SDK checked out at `e17081a45941415d483642dbe21c2a2e6ef85a13`, install its `linux[test]` package into a Python virtual environment. Set `MUSE_PYTHON` to that environment’s Python executable and `MUSE_SDK_TESTS` to the absolute path of the checkout’s `linux/tests` directory. Running `npm test` then includes a local test from webhook receipt through the Worker to the SDK’s test server. It uses synthetic credentials.

## Optional CLI setup

With Node.js 22.12 or later, run `npm ci` and `npm run setup -- --pairing /path/to/pairing.json`. For community sign-in use `--device-state /path/to/state.json` instead. Complete the device credentials in the generated `.dev.vars`. The script also generates separate tokens for custom webhooks and read-only MCP access. For a new Worker, back up its generated `CREDENTIAL_ENCRYPTION_KEY` in your password manager. For an existing Worker, use its original key before deploying. Run `npx wrangler login`, then `npm run deploy:local` to upload the settings. Register the destination through MCP. Use `npm test`, `npm run check`, and `npm run deploy -- --dry-run` for local verification. Use separate device credentials for live `npm run dev` sessions. Delivery to a live Muse account has not been verified.

Before the next local deployment, remove the three device assignments from `.dev.vars` if you removed them in Cloudflare.
