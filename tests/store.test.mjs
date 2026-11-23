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
        async fetch(request) {
          const [name, method, args] = await request.json()
          if (!this.queue) {
            if (name.startsWith("legacy-")) {
              this.ctx.storage.sql.exec(\`
                CREATE TABLE events (
                  id TEXT NOT NULL PRIMARY KEY, source TEXT NOT NULL, key TEXT NOT NULL,
                  type TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, createdAt INTEGER NOT NULL,
                  startedAt INTEGER, attempt TEXT, outcome TEXT, UNIQUE(source, key)
                )
              \`)
              for (const state of ["queued", "sending"]) {
                this.ctx.storage.sql.exec(
                  "INSERT INTO events VALUES (?, 'monitor', ?, 'alert', 'previous payload', ?, ?, ?, ?, NULL)",
                  state, state, state, Date.now(), Date.now(), "old-attempt"
                )
              }
            }
            this.queue = new DeliveryQueue(this.ctx.storage, name.endsWith("empty") ? null : "legacy-room")
          }
          const target = method === "age" || method === "reopen" ? this : this.queue
          return Response.json(target[method](...args) ?? null)
        }
        reopen(sessionId) { this.queue = new DeliveryQueue(this.ctx.storage, sessionId) }
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
  const { attempt, sessionId, ...payload } = claim
  assert.equal(sessionId, 'legacy-room')
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

test('registers existing side chats and keeps the destination of each accepted notification', async () => {
  const call = inbox('registry-empty')
  assert.deepEqual(await call('listSideChats'), { active: null, chats: [] })
  assert.deepEqual(await call('enqueue', event('alert-1')), { noDestination: true })
  const first = { name: '障害対応', sessionId: 'room-one' }
  assert.deepEqual(await call('registerSideChat', first.name, first.sessionId), {
    active: first.name,
    chats: [first],
  })
  const receipt = await call('enqueue', event('alert-1'))
  assert.equal(receipt.duplicate, false)
  await call('registerSideChat', 'backup', 'room-two')
  assert.equal((await call('listSideChats')).active, first.name)
  assert.equal(await call('setActiveSideChat', 'missing'), null)
  assert.equal((await call('setActiveSideChat', 'backup')).active, 'backup')
  const second = await call('enqueue', event('alert-2'))
  await call('registerSideChat', 'backup', 'room-three')
  await call('reopen', null)
  assert.deepEqual(await call('listSideChats'), {
    active: 'backup',
    chats: [{ name: 'backup', sessionId: 'room-three' }, first],
  })
  assert.deepEqual(await call('enqueue', event('alert-1')), { ...receipt, duplicate: true })
  const one = await call('claim')
  assert.equal(one.id, receipt.id)
  assert.equal(one.sessionId, 'room-one')
  await call('finish', one.id, one.attempt, 'not_sent')
  const retry = await call('claim')
  assert.equal(retry.sessionId, 'room-one')
  await call('finish', retry.id, retry.attempt, 'sent')
  const two = await call('claim')
  assert.equal(two.id, second.id)
  assert.equal(two.sessionId, 'room-two')
  await call('finish', two.id, two.attempt, 'sent')
  await call('age', 61_000)
  await call('enqueue', event('alert-3'))
  assert.equal((await call('claim')).sessionId, 'room-three')
})

test('keeps environment-based installs working until their default is explicitly updated', async () => {
  const call = inbox('routes')
  assert.deepEqual(await call('listSideChats'), {
    active: 'default',
    chats: [{ name: 'default', sessionId: 'legacy-room' }],
  })
  await call('registerSideChat', 'other', 'other-room')
  assert.equal((await call('listSideChats')).active, 'default')
  await call('enqueue', event('before-change'))
  await call('reopen', 'new-env-room')
  assert.equal((await call('listSideChats')).chats[0].sessionId, 'new-env-room')
  await call('registerSideChat', 'default', 'mcp-room')
  await call('reopen', 'another-env-room')
  assert.equal((await call('listSideChats')).chats[0].sessionId, 'mcp-room')
  assert.equal((await call('claim')).sessionId, 'legacy-room')
})

test('migrates previously queued events with the original configured session, never a newly registered one', async () => {
  const configured = inbox('legacy-configured')
  await configured('registerSideChat', 'other', 'changed-room')
  await configured('setActiveSideChat', 'other')
  await configured('age', 121_000)
  assert.equal((await configured('status', 'sending')).state, 'unknown')
  const claim = await configured('claim')
  assert.equal(claim.id, 'queued')
  assert.equal(claim.sessionId, 'legacy-room')

  const missing = inbox('legacy-empty')
  await missing('registerSideChat', 'other', 'changed-room')
  assert.equal((await missing('status', 'queued')).state, 'suppressed')
  assert.equal((await missing('status', 'sending')).state, 'unknown')
  assert.equal(await missing('claim'), null)
})

test('registering a saved name selects it if the environment fallback has been removed', async () => {
  const call = inbox('removed-default')
  await call('registerSideChat', 'existing', 'old-room')
  await call('reopen', null)
  assert.equal((await call('listSideChats')).active, null)
  assert.equal((await call('registerSideChat', 'existing', 'new-room')).active, 'existing')
})
