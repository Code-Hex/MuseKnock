import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Response } from 'miniflare'
import { setTimeout as delay } from 'node:timers/promises'
import { startWorker } from './worker.ts'

test('a webhook wakes the Worker and starts device authorization without a bridge client', async (t) => {
  const calls: string[] = []
  const worker = await startWorker((request) => {
    calls.push(new URL(request.url).pathname)
    return new Response('{}', { status: 503 })
  })
  t.after(() => worker.close())
  const post = () =>
    fetch(new URL('/hooks/default', worker.url), {
      method: 'POST',
      headers: { Authorization: 'Bearer HOOK_TOKEN-test', 'Idempotency-Key': 'first-knock' },
      body: 'A test notification',
    })
  const receipt = await (await post()).json()
  assert.equal(receipt.state, 'queued')
  const until = Date.now() + 6_000
  while (!calls.length && Date.now() < until) await delay(50)
  assert.deepEqual(calls, ['/device_token/refresh'])
  let state
  do {
    state = (await (await post()).json()).state
    if (state !== 'sending') break
    await delay(20)
  } while (Date.now() < until)
  assert.equal(state, 'queued')
  const obsolete = await fetch(new URL('/bridge/claim', worker.url), { method: 'POST' })
  assert.equal(obsolete.status, 404)
})
