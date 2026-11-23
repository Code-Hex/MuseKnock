import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startWorker } from './worker.ts'

test('a webhook is authenticated, normalized, deduplicated and claimed once', async (t) => {
  const worker = await startWorker()
  t.after(() => worker.close())
  const post = (path: string, token: string, body?: string, headers?: Record<string, string>) =>
    fetch(new URL(path, worker.url), {
      method: 'POST',
      body,
      headers: { Authorization: 'Bearer ' + token, ...headers },
    })
  const hook = '/hooks/default'
  const hookToken = 'HOOK_TOKEN-test'
  const bridgeToken = 'BRIDGE_TOKEN-test'
  const body = '{"temperature":35, "sensor_id":9007199254740993}'
  const headers = {
    'Content-Type': 'application/json',
    'X-Event-Type': 'sensor',
    'Idempotency-Key': 'sensor-1',
  }
  assert.equal((await post(hook, bridgeToken, body, headers)).status, 401)
  assert.equal((await post('/bridge/claim', hookToken)).status, 401)
  assert.equal((await post('/hooks/unknown', hookToken, body, headers)).status, 404)
  assert.equal((await post(hook, hookToken, '{', headers)).status, 400)
  assert.equal((await post(hook, hookToken, 'x'.repeat(33 * 1024))).status, 413)
  const received = await post(hook, hookToken, body, headers)
  assert.equal(received.status, 202)
  const receipt = await received.json()
  assert.equal(receipt.state, 'queued')
  assert.deepEqual(await (await post(hook, hookToken, body, headers)).json(), {
    ...receipt,
    duplicate: true,
  })
  const claim = () => post('/bridge/claim', bridgeToken)
  const { attempt, ...event } = await (await claim()).json()
  assert.match(attempt, /^[0-9a-f-]{36}$/)
  assert.deepEqual(event, { id: receipt.id, source: 'default', type: 'sensor', text: body })
  assert.equal((await claim()).status, 204)
  const finish = await post(
    '/bridge/finish',
    bridgeToken,
    JSON.stringify({ id: receipt.id, attempt, outcome: 'sent' }),
    headers,
  )
  assert.equal(finish.status, 204)
  assert.equal((await (await post(hook, hookToken, body, headers)).json()).state, 'sent')
  assert.equal(
    (
      await post(hook, hookToken, 'temp=30&temp=40', {
        'Content-Type': 'application/x-www-form-urlencoded',
      })
    ).status,
    202,
  )
  assert.equal((await (await claim()).json()).text, '[["temp","30"],["temp","40"]]')
  assert.equal((await post(hook, hookToken, 'plain text')).status, 202)
})
