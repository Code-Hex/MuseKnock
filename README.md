# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock delivers webhooks directly from a Cloudflare Worker to a side chat in your Muse account. The Worker stores the event, checks your delivery rules, and posts it using the Muse Gadget protocol. You can turn off your setup computer after deployment.

[Quick start](#quick-start) · **English** · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

```text
External service --webhook--> Worker + Durable Object --Gadget Link--> Muse side chat
Muse --MCP--> Worker (pause sources, filter events, inspect receipts)
```

## Quick start

You need a Cloudflare account, your own Muse account, and a Gadget SDK token. Use Node.js 22.12 or later and npm on your setup computer. The SDK token is for personal, non-commercial use with your own Muse account. [SDK token terms](https://gadgets.muse.ai/sdk-terms)

**1. Authorize a dedicated device identity once.** Choose one of the following paths. The Worker takes ownership of token refresh for this identity. If an executor or SDK daemon already uses it, stop it and disable automatic restarts before importing its credentials.

- **Without Bluetooth hardware:** Use the community Muse Desktop Bridge sign-in on a Mac. Follow its authentication setup with your own account and SDK token. Stop after sign-in, before starting the executor. The import reads the device identity and SDK token from the resulting local state file. [Community sign-in instructions](https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/3b6d0e0665d40d5537b21b701c18327e288741d9/muse-auth/README.md)
- **With an official Gadget SDK pairing:** Pair a dedicated gadget with your Muse app. Stop the SDK daemon and use the `pairing.json` for that device. The Linux SDK normally keeps it in `/var/lib/musegadget/`. [Official pairing instructions](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md#install)

**2. Generate the Worker configuration.** Clone MuseKnock and run `npm ci` in its root directory. Run the setup command that matches your device. Replace the path with the absolute path of your own private file.

```sh
# Community sign-in state
npm run setup -- --device-state /path/to/muse-desktop-bridge/muse-auth/.state/state.json
```

```sh
# Official SDK pairing
npm run setup -- --pairing /path/to/pairing.json
```

Setup writes `.dev.vars` locally with owner-only permissions. The community import copies only the node ID, device refresh token, and SDK token. For an official pairing, fill in `MUSE_SDK_TOKEN` in `.dev.vars` yourself. Keep the original files, including any user-session credentials, off Cloudflare.

To enter the device credentials yourself, run `npm run setup` and fill in `MUSE_NODE_ID`, `MUSE_REFRESH_TOKEN`, and `MUSE_SDK_TOKEN` from the same authorization. Setup generates `HOOK_TOKEN`, `MCP_TOKEN`, `MCP_ADMIN_TOKEN`, and `MUSE_SESSION_ID`. To continue an existing side chat, set `MUSE_SESSION_ID` to its exact session ID. Otherwise the first accepted post starts a new side chat. You may set `MUSE_VM_ID` to select a particular leased VM.

**3. Deploy the Worker.** Click **Deploy to Cloudflare** above, choose a Worker name, and set the deploy command to `npx wrangler deploy --minify`. In Secrets, enter the named values from `.dev.vars`. Alternatively, deploy from the project directory using the CLI. The default Worker name is `museknock`. If that name is already in use in your account, change `name` in `wrangler.jsonc` first.

```sh
npx wrangler login
npm run deploy
```

**4. Send a notification.** Replace the example URL below with the HTTPS URL shown after deployment. Only the webhook token is needed by the sender.

```sh
WORKER_URL=https://your-worker.your-subdomain.workers.dev
HOOK_TOKEN=$(node --env-file=.dev.vars -p 'process.env.HOOK_TOKEN')
curl -i "$WORKER_URL/hooks/default" \
  -H "Authorization: Bearer $HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Event-Type: build_failed' \
  -H 'Idempotency-Key: first-knock' \
  --data '{"project":"hello","message":"The tests failed"}'
```

The first request returns HTTP `202` and a receipt ID. The Worker schedules delivery, then sends the notification to `MUSE_SESSION_ID`. Check that side chat in Muse. Repeat the request with the same `Idempotency-Key` to get HTTP `200`, the original receipt ID, and its current state. Use a new key for a new notification.

## Manage notifications from Muse

In Muse, open **Settings → Connectors** and create a custom connector. Set the URL to your Worker’s `/mcp` endpoint, select Bearer authentication, and enter the appropriate token from `.dev.vars`. Check your account for custom connector availability. [Meta’s connector guide](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

| Token | What to ask Muse |
| --- | --- |
| `MCP_TOKEN` (read-only) | “List my notification sources.” “Check the delivery status for receipt ID …” |
| `MCP_ADMIN_TOKEN` (read/write) | “Pause default.” “Allow only build_failed events from default.” “Resume default.” |

Pausing a source suppresses queued notifications. Resuming affects future deliveries. A post already in progress may still arrive.

## Try it locally

Run `npm ci`, `npm test`, and `npm run check` to exercise the local Worker and type-check the project. Use `npm run deploy -- --dry-run` to check the bundle. For `npm run dev` with live Muse credentials, use a separate authorized identity so the local and deployed Workers do not rotate the same token. Tests exercise the local delivery protocol; posting to a real Muse account has not been verified.

For custom webhook formats, additional sources, rate limits, and delivery troubleshooting, see the [operations guide](docs/operations.md).
