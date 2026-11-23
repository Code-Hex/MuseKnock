# Operate and customize MuseKnock

**English** · [日本語](operations.ja.md) · [简体中文](operations.zh-CN.md)

## Authorize a device

If you already have the current device credentials, go straight to the [browser setup](../README.md#quick-start). Use the identity exclusively with this Worker. Get your own SDK token from **Account → SDK tokens** on [Muse Gadgets](https://gadgets.muse.ai/).

- **Official pairing.** Use the Muse app to pair a dedicated gadget. After stopping its SDK daemon, open your Worker’s `/setup` and select the device’s `pairing.json`. The Linux SDK normally saves it under `/var/lib/musegadget/`. Enter the SDK token used for that pairing separately. [Official pairing instructions](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md#install)
- **Community sign-in from a browser.** If you have no paired hardware and are comfortable signing in with a third-party tool, open the Muse Desktop Bridge repository in a personal GitHub Codespace. In its browser terminal run `git checkout 3b6d0e0665d40d5537b21b701c18327e288741d9`, then `python3 muse-auth/muse_auth.py setup`. Complete the prompts for your own account, including OTP or two-factor authentication, and supply your SDK token. Account checkpoints may require the Muse app. This path has not been tested with a live account in Codespaces. [Community sign-in](https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/3b6d0e0665d40d5537b21b701c18327e288741d9/muse-auth/README.md) · [Open Muse Desktop Bridge in a Codespace](https://codespaces.new/chaitanyarahalkar/muse-desktop-bridge) · [GitHub Codespaces instructions](https://docs.github.com/en/codespaces/developing-in-a-codespace/creating-a-codespace-for-a-repository)

Before downloading from your Codespace, run this command in the same browser terminal. It writes just the three device fields into a private file.

```sh
python3 - <<'PYTHON'
import json, os, tempfile
from pathlib import Path

directory = Path("muse-auth/.state")
state = json.loads((directory / "state.json").read_text())
device = {key: state["device"][key] for key in ("device_id", "refresh_token")}
with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as out:
    json.dump({"sdk_token": state["sdk_token"], "device": device}, out)
os.replace(out.name, directory / "museknock-device.json")
PYTHON
```

Download `muse-auth/.state/museknock-device.json` from the browser file explorer and select it in your own Worker’s `/setup`. Keep that file private. The original account sign-in state stays inside the Codespace, which you can delete after the handoff.

Official device pairing requires the Muse app. Authorize the device with Muse before using it to deliver notifications from your Worker.


## Trace a notification

Ask Muse to check the delivery status for the receipt ID. You can also repeat the original webhook with the same `Idempotency-Key` before setting up the connector.

| State | What it means |
| --- | --- |
| `queued` | Waiting for a Worker delivery attempt. Check that the Muse secrets are set, the device authorization is current, and a VM is leased to the device. |
| `sending` | The Worker has claimed this event and is connecting or posting. |
| `sent` | Muse acknowledged the post. Open the side chat selected when the Worker accepted the notification. |
| `suppressed` | The source was paused or the event type was excluded. Delivery has ended. |
| `expired` | The notification waited for one hour after receipt. Its delivery window has closed. |
| `unknown` | The Worker could not confirm the outcome after a possible send, or the two-minute delivery authorization expired. Check the side chat before sending another notification. |

A failure known to have occurred before submission can be retried within the delivery limits. If the post may already have reached Muse, the Worker records `unknown` and leaves the decision to you. This avoids duplicating a post when its acknowledgement is lost. [Gadget SDK chat transport](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/link_client.py)

## Renew device authorization

After handoff, the Worker saves rotated device credentials in its Durable Object. Keep other executors, local development environments, and Worker deployments off that identity. If Muse revokes the pairing, authorize a fresh device credential, import its current state again, and redeploy with the updated bootstrap secret. Existing registrations remain in the Durable Object.

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

The request body and the decoded text may each be up to 32 KiB. Include only the information you intend to send to Muse. The Worker records the active destination when accepting each new event.

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

After redeploying, send notifications to `POST /hooks/ci`. To verify a source-specific signature, read `c.req.raw.clone()` in middleware before decoding the body. You can add rate limits or filters after authentication. The Durable Object enforces the shared delivery limit across locations. [Hono middleware](https://hono.dev/docs/guides/middleware) · [Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## MCP tools

| Tool | Arguments and result | Access |
| --- | --- | --- |
| `list_side_chats` | Lists locally registered names and session IDs, and identifies the active destination. | Read |
| `register_side_chat` | `name`, `sessionId`. Creates or updates the registration. The first chat becomes active when no destination is configured. | Admin |
| `set_active_side_chat` | `name`. Selects an existing registration for future notifications. | Admin |
| `list_sources` | No arguments. Lists sources with receipt history or delivery rules. | Read |
| `get_delivery_status` | `id` (receipt ID). Returns delivery metadata without the event body. | Read |
| `set_source_paused` | `source`, `paused` (boolean). | Admin |
| `set_event_filter` | `source`, `types` (array of allowed event types). An empty array allows all types. | Admin |

Use 1–64 lowercase ASCII letters, digits, underscores or hyphens for a registration name, starting with a letter or digit. Session IDs are case-sensitive and accept 1–64 ASCII letters, digits or hyphens. Registration records the ID you give it without posting a test message. Use the original gadget session ID to continue an existing chat. A valid legacy `MUSE_SESSION_ID` appears as `default` on upgrade. An authenticated webhook returns HTTP `503` until there is an active destination and the device secrets are configured.

To rotate webhook or MCP tokens, update the corresponding Worker secrets in Cloudflare and deploy the changes. Update the sender or connector that uses each token.

## Verify SDK compatibility

With the Muse Gadget SDK checked out at `e17081a45941415d483642dbe21c2a2e6ef85a13`, install its `linux[test]` package into a Python virtual environment. Set `MUSE_PYTHON` to that environment’s Python executable and `MUSE_SDK_TESTS` to the absolute path of the checkout’s `linux/tests` directory. Running `npm test` then includes a local test from webhook receipt through the Worker to the SDK’s test server. It uses synthetic credentials.

## Optional CLI setup

With Node.js 22.12 or later, run `npm ci` and `npm run setup -- --pairing /path/to/pairing.json`. For community sign-in use `--device-state /path/to/state.json` instead. Edit the generated `.dev.vars` to complete the device credentials. For an existing chat, replace any generated `MUSE_SESSION_ID` with your existing ID, or omit it and register the chat through MCP. Run `npx wrangler login`, then `npm run deploy:local` to upload the settings. Use `npm test`, `npm run check`, and `npm run deploy -- --dry-run` for local verification. Use separate device credentials for live `npm run dev` sessions. Delivery to a live Muse account has not been verified.
