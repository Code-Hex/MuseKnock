import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import ts from 'typescript'

let runtime
before(async () => {
  const source = await readFile(new URL('../src/store.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: '2025-09-01',
      durableObjects: { INBOX: { className: 'TestInbox', useSQLite: true } },
      script:
        outputText +
        `
      import { DurableObject } from "cloudflare:workers";
      export class TestInbox extends DurableObject {
        constructor(ctx, env) { super(ctx, env); this.queue = new DeliveryQueue(ctx.storage) }
        async fetch(request) {
          const [, method, args] = await request.json()
          const target = method === "age" ? this : this.queue
          return Response.json(target[method](...args) ?? null)
        }
        age(milliseconds) {
          this.ctx.storage.sql.exec(
            "UPDATE events SET createdAt = createdAt - ?, startedAt = startedAt - ?",
            milliseconds, milliseconds
          )
          this.ctx.storage.sql.exec("UPDATE authorizations SET startedAt = startedAt - ?", milliseconds)
        }
      }
      export default {
        async fetch(request, env) {
          const [name] = await request.clone().json()
          const inbox = env.INBOX.getByName(name)
          return inbox.fetch(request)
        }
      }
    `,
    }),
  )
})
after(async () => runtime?.dispose())

function inbox(name) {
  return async (method, ...args) => {
    const response = await runtime.dispatchFetch('http://localhost', {
      method: 'POST',
      body: JSON.stringify([name, method, args]),
    })
    const body = await response.text()
    assert.equal(response.status, 200, body)
    return JSON.parse(body)
  }
}

function event(key, source = 'monitor', type = 'alert') {
  return { source, key, type, text: '外部のメッセージ' }
}

test('one receipt per source and key, one authorization even with concurrent claims', async () => {
  const call = inbox('concurrency')
  const receipts = await Promise.all(Array.from({ length: 4 }, () => call('enqueue', event('job'))))
  const { id } = receipts[0]
  assert.equal(receipts.filter((r) => !r.duplicate).length, 1)
  assert.deepEqual([...new Set(receipts.map((r) => r.id))], [id])
  const other = await call('enqueue', event('job', 'second'))
  assert.notEqual(other.id, id)
  const claims = await Promise.all([call('claim'), call('claim')])
  const [claim] = claims.filter(Boolean)
  assert.equal(claims.filter(Boolean).length, 1)
  const { attempt, ...payload } = claim
  assert.match(attempt, /^[a-f0-9-]{36}$/)
  assert.deepEqual(payload, { id, source: 'monitor', type: 'alert', text: '外部のメッセージ' })
  assert.equal(await call('finish', id, attempt, 'sent'), true)
  assert.equal(await call('finish', id, attempt, 'sent'), true)
  assert.equal(await call('finish', id, attempt, 'unknown'), false)
  const { createdAt, ...status } = await call('status', id)
  assert.equal(typeof createdAt, 'number')
  assert.deepEqual(status, { id, source: 'monitor', type: 'alert', state: 'sent' })
  assert.equal((await call('claim')).id, other.id)
})

test('pause and allowlist apply to the backlog and to new events', async () => {
  const call = inbox('rules')
  const beforePause = await call('enqueue', event('p'))
  assert.deepEqual(await call('setPaused', 'monitor', true), {
    source: 'monitor',
    paused: true,
    types: [],
  })
  assert.equal((await call('enqueue', event('paused'))).state, 'suppressed')
  await call('setPaused', 'monitor', false)
  assert.equal((await call('status', beforePause.id)).state, 'suppressed')
  const beforeFilter = await call('enqueue', event('f'))
  await call('setFilter', 'monitor', ['warning'])
  assert.equal((await call('enqueue', event('filtered'))).state, 'suppressed')
  assert.equal((await call('status', beforeFilter.id)).state, 'suppressed')
  assert.equal(await call('claim'), null)
  const allowed = await call('enqueue', event('ok', 'monitor', 'warning'))
  assert.equal((await call('claim')).id, allowed.id)
  assert.deepEqual(await call('sources'), [
    { source: 'monitor', paused: false, types: ['warning'] },
  ])
  await call('setFilter', 'monitor', [])
  assert.equal((await call('enqueue', event('all'))).state, 'queued')
})

test('sliding rate limits count distinct receipts per source and authorizations across sources', async () => {
  const call = inbox('limits')
  for (let i = 0; i < 10; i++)
    assert.equal((await call('enqueue', event(String(i)))).state, 'queued')
  assert.deepEqual(await call('enqueue', event('11')), { limited: true })
  assert.equal((await call('enqueue', event('1'))).duplicate, true)
  assert.equal((await call('enqueue', event('1', 'elsewhere'))).state, 'queued')
  for (let i = 0; i < 3; i++) {
    const claim = await call('claim')
    assert.equal(await call('finish', claim.id, claim.attempt, 'sent'), true)
  }
  assert.equal(await call('claim'), null)
  await call('age', 61_000)
  assert.equal((await call('enqueue', event('11'))).state, 'queued')
  assert.ok(await call('claim'))
})

test('lost acknowledgments never redeliver, stale queued events expire, and history ages out', async () => {
  const call = inbox('timeouts')
  const first = await call('enqueue', event('first'))
  const second = await call('enqueue', event('second'))
  const claim = await call('claim')
  assert.equal(claim.id, first.id)
  await call('age', 121_000)
  assert.equal((await call('claim')).id, second.id)
  assert.equal((await call('status', first.id)).state, 'unknown')
  assert.equal(await call('finish', first.id, claim.attempt, 'sent'), false)
  const third = await call('enqueue', event('third'))
  await call('age', 3_600_000)
  assert.equal(await call('claim'), null)
  assert.equal((await call('status', third.id)).state, 'expired')
  await call('age', 7 * 86_400_000)
  assert.equal(await call('status', first.id), null)
  const fresh = await call('enqueue', event('first'))
  assert.notEqual(fresh.id, first.id)
  assert.equal(fresh.duplicate, false)
})

test('definite non-delivery retains the payload, fences old reports, and counts every authorization', async () => {
  const call = inbox('retry')
  const { id } = await call('enqueue', event('retry'))
  const first = await call('claim')
  assert.equal(await call('finish', id, first.attempt, 'not_sent'), true)
  assert.equal(await call('finish', id, first.attempt, 'not_sent'), true)
  assert.equal(await call('finish', id, first.attempt, 'sent'), false)
  assert.equal((await call('status', id)).state, 'queued')
  for (let i = 0; i < 2; i++) {
    const retry = await call('claim')
    assert.equal(retry.id, id)
    assert.equal(retry.text, first.text)
    assert.notEqual(retry.attempt, first.attempt)
    assert.equal(await call('finish', id, first.attempt, 'sent'), false)
    assert.equal(await call('finish', id, first.attempt, 'not_sent'), false)
    assert.equal(await call('finish', id, retry.attempt, 'not_sent'), true)
  }
  assert.equal(await call('claim'), null)
  await call('age', 61_000)
  const retry = await call('claim')
  assert.equal(await call('finish', id, retry.attempt, 'unknown'), true)
  assert.equal(await call('finish', id, retry.attempt, 'not_sent'), false)
  assert.equal(await call('claim'), null)
})

test('a failed attempt honors rule changes and expiry before retry', async () => {
  for (const mode of ['pause', 'filter', 'expire']) {
    const call = inbox('inflight-' + mode)
    const { id } = await call('enqueue', event('retry'))
    if (mode === 'expire') await call('age', 3_590_000)
    const { attempt } = await call('claim')
    if (mode === 'expire') await call('age', 15_000)
    if (mode === 'pause') await call('setPaused', 'monitor', true)
    if (mode === 'filter') await call('setFilter', 'monitor', ['other'])
    assert.equal(await call('finish', id, attempt, 'not_sent'), true)
    assert.equal((await call('status', id)).state, mode === 'expire' ? 'expired' : 'suppressed')
    assert.equal(await call('claim'), null)
  }
})

test('an alarm waits for the active attempt or the rolling limit, then stops on an empty queue', async () => {
  const call = inbox('alarms')
  assert.equal(await call('nextWakeAt'), null)
  for (const key of ['one', 'two', 'three', 'four']) await call('enqueue', event(key))
  for (let i = 0; i < 3; i++) {
    assert.ok((await call('nextWakeAt')) <= Date.now())
    const active = await call('claim')
    assert.ok((await call('nextWakeAt')) > Date.now() + 100_000)
    await call('finish', active.id, active.attempt, 'sent')
  }
  assert.ok((await call('nextWakeAt')) > Date.now() + 50_000)
  await call('age', 61_000)
  assert.ok((await call('nextWakeAt')) <= Date.now())
  await call('claim')
  await call('age', 121_000)
  assert.equal(await call('nextWakeAt'), null)
})
