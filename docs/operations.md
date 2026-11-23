# Operate and customize MuseKnock

**English** · [日本語](operations.ja.md) · [简体中文](operations.zh-CN.md)

## Trace a notification

Ask Muse to check the delivery status for the receipt ID. You can also repeat the original webhook with the same `Idempotency-Key` before setting up the connector.

| State | What it means |
| --- | --- |
| `queued` | Waiting for a Worker delivery attempt. Check that the Muse secrets are set, the device authorization is current, and a VM is leased to the device. |
| `sending` | The Worker has claimed this event and is connecting or posting. |
| `sent` | Muse acknowledged the post. Look in the side chat named by `MUSE_SESSION_ID` for the message and Muse’s reply. |
| `suppressed` | The source was paused or the event type was excluded. Delivery has ended. |
| `expired` | The notification waited for one hour after receipt. Its delivery window has closed. |
| `unknown` | The Worker could not confirm the outcome after a possible send, or the two-minute delivery authorization expired. Check the side chat before sending another notification. |

A failure known to have occurred before submission can be retried within the delivery limits. If the post may already have reached Muse, the Worker records `unknown` and leaves the decision to you. This avoids duplicating a post when its acknowledgement is lost. [Gadget SDK chat transport](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/link_client.py)

## Renew device authorization

After handoff, the Worker saves rotated device credentials in its Durable Object. Keep other executors, local development environments, and Worker deployments off that identity. If Muse revokes the pairing, authorize a fresh device credential, import its current state again, and redeploy with the updated bootstrap secret. Keep `MUSE_SESSION_ID` to continue posting to the same chat.

The Worker uses the standard device API at `api.muse.ai` and the encrypted Link gateway at `hatch.metaaivm.com`. If you set `MUSE_VM_ID`, check that a lease exists for that exact VM. Otherwise the Worker selects the default leased VM, falling back to the first available lease. [Gadget SDK device API](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/muse_api.py)

## Send a webhook

Send `POST /hooks/default` with `HOOK_TOKEN` as the Bearer token.

| Input | Behavior |
| --- | --- |
| `application/json` or a `+json` subtype | Checks JSON syntax and delivers the original text, preserving integer values and whitespace. |
| `text/plain` or no Content-Type | Delivers the text as received. |
| `application/x-www-form-urlencoded` | Converts fields to an array of name/value pairs to preserve repeated field names. |
| `X-Event-Type` | Event type used by filters. Defaults to `notification`. Source names and event types are 1 to 64 characters. Start with a lowercase ASCII letter or digit. Subsequent characters can also include `_` and `-`. |
| `Idempotency-Key` | Unique event identifier within a source. Use up to 128 printable ASCII characters, excluding spaces. Omit the key to treat each POST as a new event. |

The request body and the decoded text may each be up to 32 KiB. Include only the information you intend to send to Muse. Worker configuration fixes the destination session and credentials.

Each source can submit 10 new events per rolling 60 seconds. Excess requests receive HTTP `429` and `Retry-After: 60`. Across all sources, the store authorizes up to three delivery attempts per rolling 60 seconds, one at a time. Retries count toward this limit. Receipt lookup and deduplication cover seven days from receipt. The next store operation applies expiry and removes old history. The limits are defined in `src/store.ts`.

## Add a source or payload format

In `src/index.ts`, pass a source name, an array of Hono middleware including authentication, and a body decoder to `registerWebhook`. To deliver only the job name from CI notifications, add `CI_HOOK_TOKEN` to the `WorkerEnv` bindings, set its value to a separate random secret in `.dev.vars`, and register this route.

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

After redeploying, send notifications to `POST /hooks/ci`. To verify a source-specific signature, read `c.req.raw.clone()` in middleware before decoding the body. You can add rate limits or filters after authentication. The Durable Object enforces the shared delivery limit across locations. [Hono middleware](https://hono.dev/docs/guides/middleware) · [Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## MCP tools

| Tool | Arguments and result | Access |
| --- | --- | --- |
| `list_sources` | No arguments. Lists sources with receipt history or delivery rules. | Read |
| `get_delivery_status` | `id` (receipt ID). Returns delivery metadata without the event body. | Read |
| `set_source_paused` | `source`, `paused` (boolean). | Admin |
| `set_event_filter` | `source`, `types` (array of allowed event types). An empty array allows all types. | Admin |

To rotate webhook or MCP credentials, edit the appropriate token in `.dev.vars`, run `npm run deploy`, and update the sender or connector that uses it.

## Verify SDK compatibility

With the Muse Gadget SDK checked out at `e17081a45941415d483642dbe21c2a2e6ef85a13`, install its `linux[test]` package into a Python virtual environment. Set `MUSE_PYTHON` to that environment’s Python executable and `MUSE_SDK_TESTS` to the absolute path of the checkout’s `linux/tests` directory. Running `npm test` then includes a local test from webhook receipt through the Worker to the SDK’s test server. It uses synthetic credentials.
