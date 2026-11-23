# Operate and customize MuseKnock

**English** · [日本語](operations.ja.md) · [简体中文](operations.zh-CN.md)

## Trace a notification

Ask Muse to check the delivery status for the receipt ID. You can also repeat the original webhook with the same `Idempotency-Key` before setting up the connector.

| State | What it means |
| --- | --- |
| `queued` | Waiting for delivery. Check that the bridge is running, that `WORKER_URL` is correct, and that the executor is connected to Muse. |
| `sending` | The bridge has claimed the notification for delivery. |
| `sent` | The Gadget SDK acknowledged the post. Check the side chat selected by `MUSE_SESSION_ID` in `.env.bridge` for Muse’s reply. |
| `suppressed` | The source was paused or the event type was excluded. Delivery has ended. |
| `expired` | The notification waited for one hour after receipt. Its delivery window has closed. |
| `unknown` | The connection closed after sending, or no result arrived within two minutes of authorization. Check the chat history before deciding whether to send a new notification. |

If the connection fails before the bridge writes to the SDK, or the SDK explicitly reports that Muse is disconnected, MuseKnock retries subject to the current rules and expiry time. An `unknown` result is final because the SDK has no idempotency key for a chat post. [SDK local delivery protocol](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/src/musegadget/service.py#L277-L302)

If the socket is missing on macOS, run `./muse-executor/muse-executor status` in the Muse Desktop Bridge checkout. On Linux, run `sudo musegadget doctor` and check the daemon and its account. The default sockets are `~/muse-desktop-bridge/muse-executor/.runtime/muse.sock` on macOS and `/run/musegadget/musegadget.sock` on Linux. For a different location, set `MUSEGADGET_SOCKET` in `.env.bridge` to the full absolute path. The executor and the MuseKnock bridge must both stay running.

## Start the bridge after a Linux reboot

Run these steps as the user who can access the SDK socket. Set `WORKER_URL` in `.env.bridge` to the deployed URL, then stop any bridge you started manually with Ctrl+C.

Run the commands below from the project directory to create a systemd user service. The unit uses the current directory and Node.js executable.

```sh
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/museknock.service <<EOF
[Unit]
Description=MuseKnock bridge

[Service]
WorkingDirectory=$(pwd -P)
ExecStart="$(node -p 'process.execPath')" --env-file=.env.bridge --import tsx bridge/main.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now museknock.service
systemctl --user status museknock.service
```

Follow the logs with `journalctl --user -u museknock.service -f`. To start the bridge before login, a Linux administrator can run `loginctl enable-linger USERNAME`. To stop it and disable automatic startup, run `systemctl --user disable --now museknock.service`.

## Send a webhook

Send `POST /hooks/default` with `HOOK_TOKEN` as the Bearer token.

| Input | Behavior |
| --- | --- |
| `application/json` or a `+json` subtype | Checks JSON syntax and delivers the original text, preserving integer values and whitespace. |
| `text/plain` or no Content-Type | Delivers the text as received. |
| `application/x-www-form-urlencoded` | Converts fields to an array of name/value pairs to preserve repeated field names. |
| `X-Event-Type` | Event type used by filters. Defaults to `notification`. Source names and event types are 1 to 64 characters. Start with a lowercase ASCII letter or digit. Subsequent characters can also include `_` and `-`. |
| `Idempotency-Key` | Unique event identifier within a source. Use up to 128 printable ASCII characters, excluding spaces. Omit the key to treat each POST as a new event. |

The request body and the decoded text may each be up to 32 KiB. Include only the information you intend to send to Muse. The bridge configuration determines the destination session and credentials.

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

To rotate Worker credentials, edit `.dev.vars` and run `npm run deploy`. Update each sender, bridge, or connector that uses the changed token.
