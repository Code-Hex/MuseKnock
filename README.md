# MuseKnock

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Code-Hex/MuseKnock)

MuseKnock delivers webhooks to a side chat in your Muse account. Send it a build notification, then ask Muse to deliver only failed builds from that source.

[Quick start](#quick-start) · **English** · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

```text
External service --webhook--> Cloudflare Worker --> SQLite queue
Muse --MCP--> Cloudflare Worker (delivery rules)
Bridge on Mac or Linux --outbound HTTPS--> Worker (fetch next event)
Bridge --> local executor --> Gadget SDK --> Muse side chat
```

## Quick start

You need a Cloudflare account, your own Muse account and Gadget SDK token, Node.js 22.12 or later, and npm. Run the bridge on a Mac or Linux host that stays online. The Mac option uses account sign-in and requires no Bluetooth pairing or separate Linux device.

**1. Connect a local executor to Muse. Choose one platform.**

**macOS.** Install `uv` and use the community Muse Desktop Bridge. Its installer can install Python 3.13. Sign in interactively with your own Muse account, complete its verification prompts, and keep the token on your Mac. The executor exposes shell and file operations to your Muse with the permissions of the macOS user running it. Choose a dedicated user and keep the Mac awake while you want notifications. [Muse Desktop Bridge setup](https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/3b6d0e0665d40d5537b21b701c18327e288741d9/README.md#quick-start)

```sh
git clone https://github.com/chaitanyarahalkar/muse-desktop-bridge.git ~/muse-desktop-bridge
cd ~/muse-desktop-bridge
git checkout 3b6d0e0665d40d5537b21b701c18327e288741d9
./scripts/setup.sh
python3 muse-auth/muse_auth.py setup
./muse-executor/muse-executor start
./muse-executor/muse-executor status
```

Wait for `status` to confirm the executor is connected. MuseKnock uses the socket in this checkout by default. If you clone elsewhere, set `MUSEGADGET_SOCKET` in `.env.bridge` to the absolute path of `muse-executor/.runtime/muse.sock`.

**Linux.** Use a 64-bit Linux host with Bluetooth LE for pairing. Install the official Linux SDK using your own Gadget SDK token. On your phone, add the device under **Settings → Devices**. Use a dedicated Linux account because Muse can act with that account’s permissions. The SDK token is for personal, non-commercial use with your own Muse account. [Linux SDK installation guide](https://github.com/facebookincubator/muse-gadget-sdk/blob/e17081a45941415d483642dbe21c2a2e6ef85a13/linux/README.md#install) · [SDK token terms](https://gadgets.muse.ai/sdk-terms)

**2. Generate the configuration.** Clone this repository and run these commands from its root directory.

```sh
npm ci
npm run setup
```

Setup writes the Worker tokens to `.dev.vars` and the bridge connection settings and side chat ID to `.env.bridge`. Only the file owner can read or write them. Running setup again keeps the existing values.

**3. Deploy the Worker.** Click **Deploy to Cloudflare** above and choose a Worker name. Set the deploy command to `npx wrangler deploy --minify`. For each of the four secrets, enter the value with the same name from `.dev.vars`, then deploy.

To deploy from the CLI, run the commands below. The default Worker name is `museknock`. If that name is already in use in your account, change `name` in `wrangler.jsonc` first.

```sh
npx wrangler login
npm run deploy
```

Set `WORKER_URL` in `.env.bridge` to the deployed Worker’s `https://…workers.dev` URL. To continue an existing gadget side chat, set `MUSE_SESSION_ID` to that chat’s session ID. Otherwise, keep the generated ID to start a new side chat on the first post. If deploying from another computer, install MuseKnock and its dependencies on the executor host and securely copy `.env.bridge` there.

**4. Start the bridge.** From the MuseKnock directory on the executor host, run this command as the user who can access its socket. Keep the executor and bridge running.

```sh
npm run bridge
```

**5. Send a notification.** Open a second terminal in the directory from step 2. The example below loads both generated files. If the files are on separate machines, load `.dev.vars` on the sender and set `WORKER_URL` there to the deployed URL.

```sh
. ./.dev.vars
. ./.env.bridge
curl -i "$WORKER_URL/hooks/default" \
  -H "Authorization: Bearer $HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Event-Type: build_failed' \
  -H 'Idempotency-Key: first-knock' \
  --data '{"project":"hello","message":"The tests failed"}'
```

The first request returns HTTP `202` and a receipt ID. The bridge normally polls within 10 seconds. Look for the notification in your Muse side chat. Sending the same command again returns HTTP `200`, the same ID, and the current delivery state. Use a new key for the next notification.

## Manage notifications from Muse

In Muse, open **Settings → Connectors** and create a custom connector. Set the URL to your Worker’s `/mcp` endpoint, select Bearer authentication, and enter the appropriate token from `.dev.vars`. Check your account for custom connector availability. [Meta’s connector guide](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)

| Token | What to ask Muse |
| --- | --- |
| `MCP_TOKEN` (read-only) | “List my notification sources.” “Check the delivery status for receipt ID …” |
| `MCP_ADMIN_TOKEN` (read/write) | “Pause default.” “Allow only build_failed events from default.” “Resume default.” |

Pausing a source also suppresses its queued notifications. Resuming it affects future deliveries. Suppressed notifications stay suppressed. A notification already handed to the bridge may still arrive.

## Try it locally

```sh
npm ci
npm run setup
npm run dev
```

Set `WORKER_URL` in step 5 to `http://127.0.0.1:8787` to try the same webhook locally. You can run `npm test` without a live Muse account or a connected executor. It exercises delivery through a local Worker and a test SDK socket. Use `npm run check` for type checking and `npm run deploy -- --dry-run` to check the deployment bundle.

For custom webhook formats, additional sources, rate limits, and delivery troubleshooting, see the [operations guide](docs/operations.md).
