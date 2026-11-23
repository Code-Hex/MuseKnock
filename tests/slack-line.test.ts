import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { connect } from './mcp-client.ts'
import { startWorker } from './worker.ts'

const secrets = {
  SLACK_SIGNING_SECRET: 'slack-signing-key',
  LINE_CHANNEL_SECRET: 'line-channel-key',
}

function slackHeaders(body: string, offset = 0) {
  const timestamp = String(Math.floor(Date.now() / 1000) + offset)
  const digest = createHmac('sha256', secrets.SLACK_SIGNING_SECRET)
    .update('v0:' + timestamp + ':' + body)
    .digest('hex')
  return { 'X-Slack-Request-Timestamp': timestamp, 'X-Slack-Signature': 'v0=' + digest }
}

function lineHeaders(body: string) {
  const digest = createHmac('sha256', secrets.LINE_CHANNEL_SECRET).update(body).digest('base64')
  return { 'X-Line-Signature': digest }
}

function post(url: URL, service: string, body: string, headers: Record<string, string>) {
  return fetch(new URL('/hooks/' + service, url), {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

test('Slack and LINE verify signed connection checks before device and destination setup', async (t) => {
  const worker = await startWorker(undefined, {
    ...secrets,
    MUSE_REFRESH_TOKEN: '',
    MUSE_SESSION_ID: '',
  })
  t.after(() => worker.close())
  const challenge = '{ "type": "url_verification", "challenge": "桜" }'
  const confirmation = await post(worker.url, 'slack', challenge, slackHeaders(challenge))
  assert.equal(confirmation.status, 200)
  assert.equal(await confirmation.text(), '桜')
  const emptyBatch = '{ "destination":"Utest", "events": [] }'
  assert.equal((await post(worker.url, 'line', emptyBatch, lineHeaders(emptyBatch))).status, 200)

  const slack = JSON.stringify({
    type: 'event_callback',
    event_id: 'Ev1',
    event: { type: 'app_mention', text: 'Hi' },
  })
  const line = JSON.stringify({ events: [{ type: 'follow', webhookEventId: 'ID1' }] })
  assert.equal((await post(worker.url, 'slack', slack, slackHeaders(slack))).status, 503)
  assert.equal((await post(worker.url, 'line', line, lineHeaders(line))).status, 503)
})

test('Slack and LINE require provider credentials and authenticate exact bytes before parsing', async (t) => {
  const worker = await startWorker(undefined, secrets)
  t.after(() => worker.close())
  const disabled = await startWorker()
  t.after(() => disabled.close())
  const malformed = '{'
  for (const [service, sign] of [
    ['slack', slackHeaders],
    ['line', lineHeaders],
  ] as const) {
    assert.equal((await post(disabled.url, service, malformed, sign(malformed))).status, 503)
    assert.equal(
      (await post(worker.url, service, malformed, { Authorization: 'Bearer HOOK_TOKEN-test' }))
        .status,
      401,
    )
    assert.equal((await post(worker.url, service, malformed, sign(malformed + ' '))).status, 401)
    assert.equal((await post(worker.url, service, malformed, sign(malformed))).status, 400)
  }
  for (const offset of [-360, 360]) {
    assert.equal(
      (await post(worker.url, 'slack', malformed, slackHeaders(malformed, offset))).status,
      401,
    )
  }
  assert.equal((await post(worker.url, 'line', malformed, { 'X-Line-Signature': '@' })).status, 401)
})

test('Slack and LINE queue callbacks under their own source and accept retries with the same event IDs', async (t) => {
  const worker = await startWorker(undefined, secrets)
  t.after(() => worker.close())
  const client = await connect(new URL('/mcp', worker.url), 'MCP_TOKEN-test')
  t.after(() => client.close())
  const slack = JSON.stringify({
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'Ev1',
    event: { type: 'message', text: 'Hi' },
  })
  const events = Array.from({ length: 10 }, (_, n) => ({
    type: 'message',
    webhookEventId: 'ID' + n,
    message: { type: 'text', id: String(n), text: '桜' },
  }))
  for (let attempt = 0; attempt < 2; ++attempt) {
    assert.equal((await post(worker.url, 'slack', slack, slackHeaders(slack))).status, 200)
    const line = JSON.stringify({
      events: events.map((e) => ({ ...e, deliveryContext: { isRedelivery: !!attempt } })),
    })
    assert.equal((await post(worker.url, 'line', line, lineHeaders(line))).status, 200)
  }
  const line = JSON.stringify({ events: [{ ...events[0], webhookEventId: 'extra' }] })
  assert.equal((await post(worker.url, 'line', line, lineHeaders(line))).status, 429)
  assert.deepEqual((await client.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [
      { source: 'line', paused: false, types: [] },
      { source: 'slack', paused: false, types: [] },
    ],
  })
})

test('notifications retain message text and omit provider credentials and reply capabilities', async (t) => {
  const worker = await startWorker(undefined, secrets)
  t.after(() => worker.close())
  // A field above the notification limit makes its inclusion observable at the HTTP boundary.
  const long = 'x'.repeat(32 * 1024)
  for (const text of ['Hi', long]) {
    const expected = text === long ? 413 : 200
    const slack = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev' + expected,
      token: long,
      event: { type: 'message', text, response_url: long },
    })
    const line = JSON.stringify({
      events: [
        {
          type: 'message',
          webhookEventId: 'ID' + expected,
          replyToken: long,
          message: { type: 'text', id: 'm1', text, quoteToken: long },
        },
      ],
    })
    assert.equal((await post(worker.url, 'slack', slack, slackHeaders(slack))).status, expected)
    assert.equal((await post(worker.url, 'line', line, lineHeaders(line))).status, expected)
  }
})
