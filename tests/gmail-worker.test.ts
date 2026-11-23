import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { Response } from 'miniflare'
import { z } from 'zod'
import { connect } from './mcp-client.ts'
import { startWorker } from './worker.ts'

test('MCP starts a Gmail watch, authenticated push queues new mail, and cron recovers a missed push', async (t) => {
  const env = {
    MUSE_SESSION_ID: '',
    GMAIL_ACCOUNT: 'reader@example.com',
    GMAIL_TOPIC: 'projects/example/topics/mail',
    GMAIL_CLIENT_ID: 'test-client',
    GMAIL_CLIENT_SECRET: 'test-secret',
    GMAIL_REFRESH_TOKEN: 'test-refresh',
    GMAIL_PUSH_AUDIENCE: 'https://muse.example/hooks/gmail',
    GMAIL_PUSH_SERVICE_ACCOUNT: 'push@example.iam.gserviceaccount.com',
    GMAIL_SUBSCRIPTION: 'projects/example/subscriptions/mail',
  }
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' }
  const jwt = await new SignJWT({ email: env.GMAIL_PUSH_SERVICE_ACCOUNT, email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer('https://accounts.google.com')
    .setAudience(env.GMAIL_PUSH_AUDIENCE)
    .sign(privateKey)
  const reads: string[] = []
  let watches = 0
  let latest = '101'
  let historyUnavailable = false
  const worker = await startWorker((req) => {
    const url = new URL(req.url)
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs')
      return Response.json({ keys: [jwk] })
    if (url.href === 'https://oauth2.googleapis.com/token')
      return Response.json({ access_token: 'local-access' })
    if (url.origin !== 'https://gmail.googleapis.com') return new Response(null, { status: 503 })
    assert.equal(req.headers.get('Authorization'), 'Bearer local-access')
    if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: env.GMAIL_ACCOUNT })
    if (url.pathname.endsWith('/watch')) {
      watches++
      return Response.json({ historyId: latest, expiration: String(Date.now() + 7 * 86400000) })
    }
    if (url.pathname.endsWith('/history')) {
      if (historyUnavailable) return new Response(null, { status: 503 })
      const previous = url.searchParams.get('startHistoryId')
      return Response.json({
        historyId: latest,
        history:
          previous === latest ? [] : [{ id: latest, messagesAdded: [{ message: { id: latest } }] }],
      })
    }
    assert.match(url.pathname, /\/messages\/[0-9]+$/)
    const id = url.pathname.split('/').at(-1)!
    reads.push(id)
    return Response.json({ id, threadId: 'thread', labelIds: ['INBOX'], payload: { headers: [] } })
  }, env)
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  const statusData = z.object({ ready: z.boolean(), historyId: z.string().nullable() })
  const status = async () =>
    statusData.parse((await admin.callTool({ name: 'get_gmail_status' })).structuredContent)
  const sync = () => admin.callTool({ name: 'sync_gmail' })
  const push = () =>
    fetch(new URL('/hooks/gmail', worker.url), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: env.GMAIL_SUBSCRIPTION,
        message: {
          data: Buffer.from(
            JSON.stringify({ emailAddress: env.GMAIL_ACCOUNT, historyId: '999' }),
          ).toString('base64'),
        },
      }),
    })

  assert.equal((await status()).ready, false)
  assert.equal((await sync()).isError, true)
  assert.equal(watches, 0)
  await admin.callTool({
    name: 'register_side_chat',
    arguments: { name: 'Mail', sessionId: 'mail-chat' },
  })
  assert.equal(statusData.parse((await sync()).structuredContent).historyId, '101')
  latest = '102'
  historyUnavailable = true
  assert.equal((await push()).status, 503)
  assert.equal((await status()).historyId, '101')
  historyUnavailable = false
  assert.equal((await push()).status, 204)
  assert.equal((await push()).status, 204)
  assert.equal((await status()).historyId, '102')
  assert.deepEqual((await admin.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [{ source: 'gmail', paused: false, types: [] }],
  })
  latest = '103'
  const cron = await fetch(new URL('/cdn-cgi/local/scheduled?format=json', worker.url))
  assert.equal(cron.status, 200, await cron.text())
  assert.equal((await status()).historyId, '103')
  assert.deepEqual(reads, ['102', '103'])
  assert.equal(watches, 1)
})
