import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare'
import { connect } from './mcp-client.ts'
import { startWorker } from './worker.ts'

const secret = '24'.repeat(32)
const fingerprint = createHash('sha256')
  .update(JSON.stringify(['test-123abc', 'test-initial-refresh']))
  .digest('hex')

// This test-only deployment reads and writes the same local Durable Object as the application.
async function snapshot(path: string, seed?: Record<string, unknown>) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      script: `
      import { DurableObject } from 'cloudflare:workers'
      export class Inbox extends DurableObject {
        async fetch(req) {
          if (req.method === 'POST') await this.ctx.storage.put(await req.json())
          const values = await this.ctx.storage.list()
          const body = JSON.stringify(Object.fromEntries(values), (_, value) =>
            value instanceof ArrayBuffer ? Array.from(new Uint8Array(value)) : value)
          return new Response(body, {
            headers: { 'content-type': 'application/json' },
          })
        }
      }
      export default { fetch(req, env) { return env.INBOX.getByName('personal').fetch(req) } }
    `,
      port: 0,
      host: '127.0.0.1',
      cf: false,
      modules: true,
      compatibilityDate: '2026-11-19',
      durableObjects: { INBOX: { className: 'Inbox', useSQLite: true } },
      resourcePersistencePath: path,
    }),
  )
  try {
    const response = await mf.dispatchFetch(
      'http://local.test/',
      seed ? { method: 'POST', body: JSON.stringify(seed) } : {},
    )
    assert.equal(response.status, 200)
    return (await response.json()) as Record<string, Record<string, unknown>>
  } finally {
    await mf.dispose()
  }
}

test('upgrading persisted storage seals both legacy sessions and reuses the latest Muse refresh token', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'museknock-credentials-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const records = {
    device: {
      fingerprint,
      credentials: { accessToken: 'old-access', refreshToken: 'latest-refresh', savedAt: 0 },
    },
    'bluesky-notifications.session': {
      fingerprint,
      session: { did: 'did:plc:owner', accessJwt: 'blue-access', refreshJwt: 'blue-refresh' },
    },
  }
  assert.deepEqual(await snapshot(path, records), records)
  async function open(key: string, ready: boolean, send: boolean) {
    const refreshes: string[] = []
    let usedRotatedAccess = false
    const worker = await startWorker(
      (request) => {
        if (new URL(request.url).pathname === '/device_token/refresh') {
          refreshes.push(request.headers.get('Authorization') ?? '')
          return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' })
        }
        usedRotatedAccess = request.headers.get('Authorization') === 'Bearer rotated-access'
        return new Response(null, { status: 503 })
      },
      { CREDENTIAL_ENCRYPTION_KEY: key },
      path,
    )
    try {
      const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
      try {
        const status = await admin.callTool({ name: 'get_setup_status' })
        assert.deepEqual(status.structuredContent, {
          active: 'default',
          deviceConfigured: true,
          credentialStorageReady: ready,
          ready,
        })
        if (send) {
          const test = await admin.callTool({
            name: 'send_test_notification',
            arguments: { requestId: crypto.randomUUID() },
          })
          assert.notEqual(test.isError, true)
          await t.waitFor(() => assert.ok(usedRotatedAccess), { timeout: 4000 })
          assert.deepEqual(refreshes, ['Bearer hatch_refresh:latest-refresh'])
        }
      } finally {
        await admin.close()
      }
    } finally {
      await worker.close()
    }
  }
  await open(secret, true, false)
  const sealed = await snapshot(path)
  for (const name of Object.keys(records)) {
    assert.deepEqual(Object.keys(sealed[name]).sort(), ['ciphertext', 'iv', 'version'])
  }
  await open('57'.repeat(32), false, false)
  assert.deepEqual(await snapshot(path), sealed)
  await open(secret, true, true)
  const rotated = await snapshot(path)
  assert.deepEqual(Object.keys(rotated.device).sort(), ['ciphertext', 'iv', 'version'])
  assert.notDeepEqual(rotated.device.ciphertext, sealed.device.ciphertext)
  assert.deepEqual(
    rotated['bluesky-notifications.session'],
    sealed['bluesky-notifications.session'],
  )
})
