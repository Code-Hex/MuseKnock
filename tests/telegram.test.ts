import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startWorker } from './worker.ts'

const secret = 'telegram_test-secret'
const update = { message: { message_id: 5, chat: { id: -12 }, text: 'Hello' } }
test('Telegram authenticates updates and deduplicates them by update_id before rate limiting', async (t) => {
  const worker = await startWorker(undefined, { TELEGRAM_WEBHOOK_SECRET: secret, HOOK_TOKEN: '' })
  t.after(() => worker.close())
  const post = (body: unknown, token?: string) =>
    fetch(new URL('/hooks/telegram', worker.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'X-Telegram-Bot-Api-Secret-Token': token }),
      },
      body: JSON.stringify(body),
    })
  for (const token of [undefined, 'wrong']) assert.equal((await post(update, token)).status, 401)
  assert.equal((await post(update, secret)).status, 400)
  assert.equal((await post({ update_id: 100, message: null }, secret)).status, 400)
  for (let id = 1; id <= 10; id++) {
    assert.equal((await post({ update_id: id, ...update }, secret)).status, 200)
  }
  assert.equal((await post({ update_id: 1, ...update }, secret)).status, 200)
  assert.equal((await post({ update_id: 11, ...update }, secret)).status, 429)
})

test('Telegram requires a configured webhook secret', async (t) => {
  const worker = await startWorker()
  t.after(() => worker.close())
  const response = await fetch(new URL('/hooks/telegram', worker.url), { method: 'POST' })
  assert.equal(response.status, 503)
})
