# Operate and customize MuseKnock

**English** · [日本語](operations.ja.md) · [简体中文](operations.zh-CN.md)

## Authorize a device

For Mac and phone pairing, run `npm run authorize -- --bluetooth` on the Mac. The command uses uv to install the macOS Bluetooth bindings and the pinned Muse SDK pairing protocol. The phone app authorizes a new device for this Worker. To renew the same Worker’s pairing, add `--replace`. The following verification-code method is available for accounts that Muse allows to sign in with a code. Follow the phone verification steps in the [quick start](../README.md#quick-start).

If you already have a valid pairing for this Worker, you can use the Cloudflare dashboard. Under **Settings → Variables and Secrets**, add its matching `MUSE_NODE_ID`, `MUSE_SDK_TOKEN` and `MUSE_REFRESH_TOKEN` as secrets and deploy them together. Call `begin_muse_pairing` through the admin connector. When it returns `configured`, continue with side chat registration. The command below is for a fresh pairing.

The admin MCP tool `begin_muse_pairing` returns a node ID derived from the Worker’s Durable Object identity. The command calls the same tool, so you never need to copy the node ID. Enter verification codes only in the private terminal.

Use a private terminal in the MuseKnock repository (a personal Codespace works). After deployment run `npm ci` and `npm run authorize`. Enter the HTTPS origin of your own Worker, its `MCP_ADMIN_TOKEN`, your SDK token and your account email or phone number. Complete the verification code and any account selection or two-factor challenge Muse offers. If Muse requires an account checkpoint, complete it in the Muse app before restarting.

For SMS sign-in you can pass the two-letter country code for your phone number. For a Japanese mobile number, run `npm run authorize -- --region JP` and enter the domestic number in digits, keeping the leading zero. The command sends the digits as entered.

Only the generated node ID, SDK token and device refresh token go to your Worker. It keeps them encrypted using `CREDENTIAL_ENCRYPTION_KEY`. The command keeps the account session in memory. An already paired Worker retains its current pairing. Register the existing side chat through MCP after authorization.

When the Worker imports credentials from the authorization command, it refreshes them with Muse before activating them. For a saved pairing, `begin_muse_pairing` reports the last refresh result. `unverified` means the Worker has yet to confirm the credentials. `verified` means a refresh succeeded. `rejected` means Muse refused the credentials.

The authorization command uses the Muse account sign-in service and your SDK token. This sign-in interface can change. The local sign-in tests pass. A live SMS trial received HTTP 400 at the verification-code request, including with the phone region supplied. This verification-code sign-in remains unverified with a live account. The earlier Mac pairing flow completed with the Muse iPhone app and a local Worker. In a physical iPhone test, Muse rejected a gadget without an SDK token before displaying the Wi-Fi list. A verification code in that list cannot identify the phone before token release. The separate Bluetooth verification step has automated coverage and still needs an end-to-end iPhone test. [Muse Gadget SDK tokens](https://gadgets.muse.ai/settings/sdk-tokens)

If the pairing upload acknowledgement is lost, the Mac checks which pairing the Worker saved. The Worker retries a failed write with the newly issued token. If the Worker stops before that token reaches durable storage and Muse has already invalidated the old token, renew the pairing with `--replace`.

## Trace a notification

Ask Muse to check the delivery status for the receipt ID. You can also repeat the original webhook with the same `Idempotency-Key` before setting up the connector.

| State | What it means |
| --- | --- |
| `queued` | Waiting for a Worker delivery attempt. Check the saved pairing, device authorization, and VM lease. If Muse returns HTTP 429 for the post, the Worker keeps the body and retries within the delivery budget and expiry window. |
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

To replace a revoked pairing, run `npm run authorize -- --replace` for the same Worker URL, then register the side chat again. Existing senders and connectors keep their URLs. Pending deliveries retain their original pairing. If you configured the three Muse secrets in Cloudflare, correct an incorrect SDK token there and redeploy. To switch from those secrets to a new pairing, first check that the Worker can open its saved credentials, then remove all three Muse secrets together, redeploy and run the replacement command.

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
| `begin_muse_pairing` | Returns the node ID and private sign-in steps, or the last verification result for a saved pairing. The authorization command uses `replace: true` to request replacement. | Admin |
| `get_setup_status` | Returns `deviceConfigured`, `credentialStorageReady`, `active`, and `ready` from local configuration. An invalid `CIRCUIT_BREAKER` setting returns `ready: false` and `reason: invalid_circuit_breaker`. | Read |
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

Registration names are case-sensitive, with 1 to 64 characters after trimming. Start with a Unicode letter or number. You may then use letters, numbers, combining marks, spaces, periods, underscores, and hyphens. Session IDs are case-sensitive and accept 1–64 ASCII letters, digits or hyphens. Registration and selection verify that the session exists on Muse before changing the destination. Use the ID of the existing side chat. An authenticated notification returns HTTP `503` until the Worker can load the pairing and has an active destination.

To rotate webhook or MCP tokens, update the corresponding Worker secrets in Cloudflare and deploy the changes. Update the sender or connector that uses each token. If your Telegram webhook secret was also used as an MCP or custom webhook token, rotate both to independent values and register the new Telegram secret with `setWebhook`.

## Verify SDK compatibility

With the Muse Gadget SDK checked out at `e17081a45941415d483642dbe21c2a2e6ef85a13`, install its `linux[test]` package into a Python virtual environment. Set `MUSE_PYTHON` to that environment’s Python executable and `MUSE_SDK_TESTS` to the absolute path of the checkout’s `linux/tests` directory. Running `npm test` then includes a local test from webhook receipt through the Worker to the SDK’s test server. It uses synthetic credentials.

## Optional CLI setup

With Node.js 22.12 or later, run `npm ci` and `npm run setup` in this repository to generate local Worker secrets in `.dev.vars`. Use the original encryption key for an existing Worker. Run `npx wrangler login` and `npm run deploy:local`, then check the pairing through MCP.
