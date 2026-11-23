# Send new Gmail messages to a Muse side chat

[English](gmail.md) · [日本語](gmail.ja.md) · [简体中文](gmail.zh-CN.md)

Complete the [MuseKnock quick start](../README.md#quick-start) through the test notification. You need a deployed Worker, a working Muse device, an encryption key and a selected side chat. Each Worker watches one Google mailbox. After setup you can close Cloud Shell. Google Pub/Sub calls the Worker directly, and Cloudflare Cron renews the Gmail watch.

## 1. Connect Pub/Sub to the Worker

Use a dedicated Google Cloud project. Use that same project for the OAuth client in step 2. Open Google Cloud Shell in your browser. Replace the project ID and Worker origin in both commands. The preview prints the operations without contacting Google. [Open Cloud Shell](https://shell.cloud.google.com/)

```sh
git clone --depth 1 https://github.com/Code-Hex/MuseKnock.git
cd MuseKnock
./scripts/setup-gmail.sh --dry-run YOUR_PROJECT_ID https://YOUR-WORKER.workers.dev
./scripts/setup-gmail.sh YOUR_PROJECT_ID https://YOUR-WORKER.workers.dev
```

The script enables the required APIs, grants Gmail publish access to the topic, and creates a push subscription to `/hooks/gmail`. It grants the Pub/Sub service agent permission to mint an OIDC token for the dedicated push service account. Save the four `GMAIL_*` settings it prints. Rerunning the script reuses its named resources and updates the subscription’s push endpoint. [Gmail push setup](https://developers.google.com/workspace/gmail/api/guides/push) · [Authenticated Pub/Sub push](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

Run setup as a project administrator who can enable APIs, manage Pub/Sub, create service accounts and grant these IAM bindings. If creating the subscription fails with `iam.serviceAccounts.actAs`, have an administrator grant your setup identity **Service Account User** on `museknock-gmail-push@YOUR_PROJECT_ID.iam.gserviceaccount.com`, then rerun the command. If organization policy blocks the Gmail publisher, ask your administrator for an exception on the topic. [Pub/Sub permissions](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

## 2. Authorize the mailbox

1. In Google Auth Platform, configure the consent screen. Add `https://www.googleapis.com/auth/gmail.readonly` under **Data Access**. For an external app in **Testing**, add your Gmail address under **Audience → Test users**. Gmail read access covers the mailbox even if you configure a single label in MuseKnock. [Google Auth Platform](https://console.cloud.google.com/auth/overview)
2. Under **Clients**, create a **Web application** OAuth client. Set its authorized redirect URI to `https://developers.google.com/oauthplayground` (no trailing slash). Keep the client ID and client secret. [Create OAuth credentials](https://developers.google.com/workspace/guides/create-credentials#web-application)
3. In OAuth 2.0 Playground, open the settings gear, select **Use your own OAuth credentials**, enter those credentials, and choose **Offline** access and **Consent**. Enter the Gmail read-only scope from step 1, press **Authorize APIs**, and sign in to the mailbox you want to watch. Choose **Exchange authorization code for tokens** and copy the **Refresh token**. [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
4. For an external app in **Testing**, Google expires this refresh token after seven days. For continuous operation, use the publishing status appropriate for your Google account and obtain a new refresh token after changing it. [Refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)

## 3. Configure and start the Worker

In Cloudflare, open the deployed Worker’s **Settings → Variables and Secrets**. Set these values and deploy the changes. Enter the Google credentials directly in Cloudflare.

| Type | Setting | Value |
| --- | --- | --- |
| Secret | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Your OAuth client ID, its secret, and the mailbox refresh token |
| Text | `GMAIL_ACCOUNT` | Primary email address of the authorized mailbox |
| Text | `GMAIL_TOPIC`, `GMAIL_SUBSCRIPTION` | Full resource names printed by the script, including `projects/…` |
| Text | `GMAIL_PUSH_SERVICE_ACCOUNT`, `GMAIL_PUSH_AUDIENCE` | Service account email and exact HTTPS URL printed by the script |
| Text, optional | `GMAIL_LABEL_ID` | Gmail label ID, default `INBOX`. For a custom label, get its ID from `users.labels.list`. |
| Text, optional | `GMAIL_INCLUDE_BODY`, `GMAIL_MAX_BYTES` | By default (`false`), Muse receives message metadata, including sender, recipient and subject. Set `true` to include plain text when available. Set a body limit from 1 to 20,000 bytes (default 20,000). |

1. Once the Worker settings and Muse destination are ready, the five-minute cron starts the watch automatically. To start immediately, ask your admin connector to call `sync_gmail`. The first sync registers the watch and records the starting point. Existing mail stays in Gmail. Ask for `get_gmail_status` and check `ready`, `historyId` and `watchExpiresAt`.
2. Send a new email from another account that will receive the selected label. Check the selected Muse side chat. Gmail limits push notifications to one per second per mailbox. The Worker checks Gmail history every five minutes to recover from delayed or missed notifications. Each sync processes at most ten messages and continues the backlog on later syncs. The Worker renews the watch daily. [Gmail delivery limits](https://developers.google.com/workspace/gmail/api/guides/push#limitations)
3. If delivery stops, check `lastSyncAt` and `watchExpiresAt` with `get_gmail_status`. Call `sync_gmail` to retry. A new `lastGapAt` means Gmail had expired the saved history. Check the mailbox for messages from that interval. [Gmail history synchronization](https://developers.google.com/workspace/gmail/api/guides/sync)

## Disconnect Gmail

Remove the Gmail bindings in Cloudflare and deploy the change to stop syncing. To stop Pub/Sub delivery immediately, delete the dedicated `museknock-gmail-push` subscription in Google Cloud. The Gmail watch expires within seven days without renewal. If you are retiring this integration, revoke the app’s access and delete its dedicated topic and push service account. [Google account connections](https://myaccount.google.com/connections)
