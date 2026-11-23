import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import { HTTPException } from 'hono/http-exception'
import { authenticateGmailPush, gmailPushConfigured } from '../src/providers/gmail.ts'
import { startWorker } from './worker.ts'

const env = {
  GMAIL_ACCOUNT: 'reader@example.com',
  GMAIL_SUBSCRIPTION: 'projects/example/subscriptions/mail',
  GMAIL_PUSH_AUDIENCE: 'https://muse.example/hooks/gmail',
  GMAIL_PUSH_SERVICE_ACCOUNT: 'push@example.iam.gserviceaccount.com',
}
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
const kid = 'test-google-key'
const now = Math.floor(Date.now() / 1000)
const claims = {
  iss: 'https://accounts.google.com',
  aud: env.GMAIL_PUSH_AUDIENCE,
  email: env.GMAIL_PUSH_SERVICE_ACCOUNT,
  email_verified: true,
  iat: now,
  exp: now + 3600,
}
function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
function token(changes = {}, header = {}) {
  const input = encode({ alg: 'RS256', kid, ...header }) + '.' + encode({ ...claims, ...changes })
  return input + '.' + sign('sha256', Buffer.from(input), key.privateKey).toString('base64url')
}
const message = { emailAddress: env.GMAIL_ACCOUNT, historyId: '9876543210987654321' }
const envelope = { subscription: env.GMAIL_SUBSCRIPTION, message: { data: encode(message) } }
function request(url: URL, jwt?: string, body: unknown = envelope) {
  return new Request(new URL('/hooks/gmail', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jwt && { Authorization: 'Bearer ' + jwt }) },
    body: JSON.stringify(body),
  })
}

test('Gmail push requires an HTTPS audience, a Google service account and a full subscription name', () => {
  assert.equal(gmailPushConfigured(env), true)
  for (const changed of [
    { GMAIL_PUSH_AUDIENCE: 'http://muse.example/hooks/gmail' },
    { GMAIL_PUSH_SERVICE_ACCOUNT: 'reader@gmail.com' },
    { GMAIL_SUBSCRIPTION: 'mail' },
    { GMAIL_ACCOUNT: '' },
  ]) {
    assert.equal(gmailPushConfigured({ ...env, ...changed }), false)
  }
})

test('Gmail accepts only signed Google push notifications for the configured subscription and mailbox', async (t) => {
  let keyRequests = 0
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs')
    keyRequests++
    return Response.json({
      keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256' }],
    })
  })
  async function check(jwt?: string, body: unknown = envelope) {
    try {
      await authenticateGmailPush(request(new URL(env.GMAIL_PUSH_AUDIENCE), jwt, body), env)
    } catch (error) {
      if (error instanceof HTTPException) return error.status
      throw error
    }
  }
  for (const value of [
    undefined,
    'HOOK_TOKEN-test',
    token({}, { alg: 'HS256' }),
    token({}, { kid: '' }),
  ]) {
    assert.equal(await check(value), 401)
  }
  assert.equal(keyRequests, 0)
  for (const changed of [
    { iss: 'https://example.com' },
    { aud: 'https://other.example/hooks/gmail' },
    { email: 'another@example.iam.gserviceaccount.com' },
    { email_verified: false },
    { email_verified: 'true' },
    { iat: undefined },
    { exp: undefined },
    { iat: now + 300 },
    { exp: now - 300 },
  ])
    assert.equal(await check(token(changed)), 401, JSON.stringify(changed))
  const valid = token()
  const [header, , signature] = valid.split('.')
  assert.equal(
    await check([header, encode({ ...claims, sub: 'changed' }), signature].join('.')),
    401,
  )
  assert.equal(await check(token({}, { kid: 'unknown' })), 401)
  assert.equal(keyRequests, 1)
  assert.equal(await check(valid, { ...envelope, subscription: env.GMAIL_SUBSCRIPTION + '2' }), 403)
  assert.equal(
    await check(valid, {
      ...envelope,
      message: { data: encode({ ...message, emailAddress: 'someone@example.com' }) },
    }),
    403,
  )
  for (const body of [
    message,
    { ...envelope, message: { data: '%%%' } },
    { ...envelope, message: { data: encode({ ...message, historyId: 'abc' }) } },
  ]) {
    assert.equal(await check(valid, body), 400)
  }
  assert.equal(await check(valid), undefined)
  assert.equal(
    await check(valid, {
      ...envelope,
      message: {
        data: Buffer.from(JSON.stringify({ ...message, historyId: 42 })).toString('base64'),
      },
    }),
    undefined,
  )
  assert.equal(keyRequests, 1)
})

test('Gmail fails closed when push identity or its Google key service is unavailable', async (t) => {
  const missing = await startWorker()
  const unavailable = await startWorker(undefined, env)
  t.after(() => Promise.all([missing.close(), unavailable.close()]))
  assert.equal((await fetch(request(missing.url, token()))).status, 503)
  assert.equal((await fetch(request(unavailable.url, 'HOOK_TOKEN-test'))).status, 401)
  assert.equal((await fetch(request(unavailable.url, token()))).status, 503)
})
