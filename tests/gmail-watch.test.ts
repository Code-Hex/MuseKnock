import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gmailConfigured, syncGmail, type GmailWatchState } from '../src/gmail-watch.ts'

const env = {
  GMAIL_CLIENT_ID: 'client',
  GMAIL_CLIENT_SECRET: 'secret',
  GMAIL_REFRESH_TOKEN: 'refresh',
  GMAIL_ACCOUNT: 'reader@example.com',
  GMAIL_TOPIC: 'projects/example/topics/gmail',
}
const mail = (id: string, labels = ['INBOX']) => ({
  id,
  labelIds: labels,
  threadId: 'thread',
  payload: { headers: [{ name: 'Subject', value: 'Hello' }] },
})
const record = (id: string, ids: string[]) => ({
  id,
  messagesAdded: ids.map((id) => ({ message: { id } })),
})
function account() {
  let state: GmailWatchState | undefined
  const events: { key: string; type: string; text: string }[] = []
  const requests: URL[] = []
  const api = {
    profile: env.GMAIL_ACCOUNT,
    baseline: '101',
    history: (_: URL): Response => Response.json({ historyId: '103' }),
    message: (id: string, _: URL): Response => Response.json(mail(id)),
    accepted: true,
  }
  const run = (changes = {}) =>
    syncGmail(
      { ...env, ...changes },
      state,
      async (value) => {
        state = structuredClone(value)
      },
      async (batch) => {
        events.push(...batch)
        return api.accepted ? 'accepted' : 'limited'
      },
      async (url, init) => {
        requests.push(url)
        assert.equal(init.redirect, 'manual')
        assert.ok(init.signal)
        if (url.href === 'https://oauth2.googleapis.com/token') {
          assert.equal(
            new URLSearchParams(String(init.body)).get('refresh_token'),
            env.GMAIL_REFRESH_TOKEN,
          )
          return Response.json({ access_token: 'access' })
        }
        assert.equal(url.origin, 'https://gmail.googleapis.com')
        assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer access')
        if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: api.profile })
        if (url.pathname.endsWith('/watch')) {
          assert.deepEqual(JSON.parse(String(init.body)), {
            topicName: env.GMAIL_TOPIC,
            labelIds: ['INBOX'],
            labelFilterBehavior: 'include',
          })
          return Response.json({
            historyId: api.baseline,
            expiration: String(Date.now() + 7 * 86400000),
          })
        }
        if (url.pathname.endsWith('/history')) {
          assert.equal(url.searchParams.get('labelId'), 'INBOX')
          assert.equal(url.searchParams.get('historyTypes'), 'messageAdded')
          return api.history(url)
        }
        assert.match(url.pathname, /\/messages\//)
        return api.message(url.pathname.split('/').at(-1)!, url)
      },
    )
  return {
    api,
    events,
    requests,
    run,
    state: () => state!,
    save: (s: GmailWatchState) => {
      state = s
    },
  }
}

test('Gmail starts at watch registration and checks mailbox ownership before each watch or sync', async () => {
  const app = account()
  assert.ok(gmailConfigured(env))
  assert.ok(!gmailConfigured({ ...env, GMAIL_MAX_BYTES: '-3' }))
  app.api.profile = 'wrong@example.com'
  await assert.rejects(app.run(), /account/i)
  assert.equal(app.state(), undefined)
  assert.equal(app.requests.length, 2)
  app.api.profile = env.GMAIL_ACCOUNT
  await app.run()
  assert.equal(app.state().historyId, '101')
  assert.equal(app.events.length, 0)
  assert.ok(!JSON.stringify(app.state()).includes('refresh'))
  app.save({ ...app.state(), watchRenewedAt: 1 })
  app.api.baseline = '150'
  app.api.history = (url) => {
    assert.equal(url.searchParams.get('startHistoryId'), '101')
    return new Response(null, { status: 429 })
  }
  await assert.rejects(app.run(), /429/)
  assert.equal(app.state().historyId, '101')
  assert.ok(app.state().watchRenewedAt > 1)
  app.api.history = () => new Response(null, { status: 404 })
  await app.run()
  assert.equal(app.state().historyId, '150')
  assert.ok(app.state().lastGapAt)
})

test('Gmail resumes oversized records and paginates, filters missing and unlabelled mail, retries with stable keys', async () => {
  const app = account()
  await app.run()
  const ids = Array.from({ length: 13 }, (_, i) => String(i))
  app.api.history = (url) =>
    Response.json(
      url.searchParams.has('pageToken')
        ? { historyId: '130', history: [record('125', ['14', '15'])] }
        : { historyId: '130', history: [record('120', ids)], nextPageToken: 'next' },
    )
  app.api.message = (id, url) => {
    assert.equal(url.searchParams.get('format'), 'metadata')
    return id === '14'
      ? new Response(null, { status: 404 })
      : Response.json(mail(id, id === '15' ? ['SENT'] : ['INBOX']))
  }
  app.api.accepted = false
  await assert.rejects(app.run(), /limited/)
  const failed = app.events.splice(0)
  assert.equal(app.state().historyId, '101')
  app.api.accepted = true
  await app.run()
  assert.deepEqual(app.events, failed)
  assert.equal(app.events.length, 10)
  await app.run()
  assert.equal(app.events.length, 13)
  assert.equal(app.state().historyId, '120')
  await app.run()
  assert.equal(app.events.length, 13)
  assert.equal(app.state().historyId, '130')
  assert.equal(new Set(app.events.map((e) => e.key)).size, 13)
})

test('Gmail includes only bounded inline plaintext when enabled', async () => {
  const app = account()
  await app.run()
  app.api.history = () => Response.json({ historyId: '105', history: [record('103', ['42'])] })
  const part = (mimeType: string, text: string, filename = '') => ({
    mimeType,
    filename,
    body: { data: Buffer.from(text).toString('base64url') },
  })
  app.api.message = (id, url) => {
    assert.equal(url.searchParams.get('format'), 'full')
    return Response.json({
      ...mail(id),
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          part('text/html', '<script>'),
          part('text/plain', 'attachment', 'attached.txt'),
          part('text/plain', '日本語です。'),
        ],
      },
    })
  }
  await app.run({ GMAIL_INCLUDE_BODY: 'true', GMAIL_MAX_BYTES: '9' })
  const event = JSON.parse(app.events[0].text)
  assert.equal(event.body, '日本語')
  assert.equal(event.bodyTruncated, true)
  assert.equal(app.events[0].type, 'message')
})

test('Gmail restarts an invalid page token at the last accepted history record', async () => {
  const app = account()
  await app.run()
  app.api.history = () =>
    Response.json({ historyId: '130', history: [record('105', ['1'])], nextPageToken: 'stale' })
  await app.run()
  assert.equal(app.state().historyId, '105')
  app.api.history = (url) => {
    assert.equal(url.searchParams.get('pageToken'), 'stale')
    return new Response(null, { status: 400 })
  }
  await app.run()
  assert.equal(app.state().historyId, '105')
  assert.equal(app.state().page, undefined)
  app.api.history = (url) => {
    assert.equal(url.searchParams.get('startHistoryId'), '105')
    return Response.json({ historyId: '131', history: [record('113', ['2'])] })
  }
  await app.run()
  assert.equal(app.state().historyId, '131')
  assert.equal(app.events.length, 2)
})

test('Gmail falls back to headers if the full message exceeds the response bound', async () => {
  const app = account()
  await app.run()
  app.api.history = () => Response.json({ historyId: '105', history: [record('103', ['42'])] })
  const formats: string[] = []
  app.api.message = (id, url) => {
    const format = url.searchParams.get('format')!
    formats.push(format)
    return format === 'full'
      ? Response.json({ attachment: 'x'.repeat(1024 * 1024) })
      : Response.json(mail(id))
  }
  await app.run({ GMAIL_INCLUDE_BODY: 'true' })
  assert.deepEqual(formats, ['full', 'metadata'])
  const event = JSON.parse(app.events[0].text)
  assert.equal(event.subject, 'Hello')
  assert.equal(event.body, undefined)
  assert.equal(event.bodyTruncated, true)
})

test('Gmail preserves already accepted progress when fetching a later message fails', async () => {
  const app = account()
  await app.run()
  app.api.history = () => Response.json({ historyId: '109', history: [record('108', ['1', '2'])] })
  app.api.message = (id) =>
    id === '2'
      ? new Response('private error including refresh token', { status: 429 })
      : Response.json(mail(id))
  await assert.rejects(app.run(), { message: 'Gmail returned HTTP 429' })
  assert.equal(app.events.length, 1)
  assert.equal(app.state().historyId, '101')
  const reads: string[] = []
  app.api.message = (id) => {
    reads.push(id)
    return Response.json(mail(id))
  }
  await app.run()
  assert.deepEqual(reads, ['2'])
  assert.equal(app.state().historyId, '109')
  assert.equal(app.events.length, 2)
})
