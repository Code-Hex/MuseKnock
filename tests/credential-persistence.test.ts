import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Response } from 'miniflare'
import { connect } from './mcp-client.ts'
import { startWorker } from './worker.ts'

test('switching pairings keeps each rotated token usable across Worker deployments', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'museknock-pairings-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const expected = new Map([['a', 'bootstrap-a'], ['b', 'bootstrap-b']])
  const refreshes: string[] = []
  const secret = '24'.repeat(32)
  for (const [pairing, seed, key] of [
    ['a', 'bootstrap-a', secret],
    ['b', 'bootstrap-b', '57'.repeat(32)],
    ['b', 'bootstrap-b', secret],
    ['a', 'hatch_refresh:bootstrap-a', secret],
  ]) {
    const worker = await startWorker((request) => {
      const url = new URL(request.url)
      if (url.pathname === '/device_token/refresh') {
        const refresh = request.headers.get('Authorization')?.replace('Bearer hatch_refresh:', '')
        refreshes.push(refresh ?? '')
        if (refresh !== expected.get(pairing)) return new Response(null, { status: 401 })
        const next = 'rotated-' + refreshes.length
        expected.set(pairing, next)
        return Response.json({ access_token: 'access-' + next, refresh_token: next })
      }
      // Expire the cached access token when the operator returns to A.
      if (url.pathname === '/fetch_vms' && refreshes.length === 2 && pairing === 'a')
        return new Response(null, { status: 401 })
      if (url.pathname === '/fetch_vms') return Response.json({
        vm_list: [{ vm_id: 'local-vm', vm_auth_token: 'test-token', vm_url: 'https://vm.example' }],
      })
      assert.equal(url.pathname, '/v1/noise')
      return new Response(null, { status: 503 })
    }, { MUSE_REFRESH_TOKEN: seed, CREDENTIAL_ENCRYPTION_KEY: key }, path)
    try {
      const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
      try {
        const status = await admin.callTool({ name: 'get_setup_status' })
        assert.deepEqual(status.structuredContent, {
          active: null, deviceConfigured: true, credentialStorageReady: key === secret, ready: false,
        })
        const response = await admin.callTool({
          name: 'register_side_chat', arguments: { name: 'alerts', sessionId: 'existing' },
        })
        assert.equal(response.isError, true)
      } finally {
        await admin.close()
      }
    } finally {
      await worker.close()
    }
  }
  assert.deepEqual(refreshes, ['bootstrap-a', 'bootstrap-b', 'rotated-1'])
})

test('removing all three setup secrets preserves the chat, webhook ingress and rotated credentials', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'museknock-handoff-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const removed = { MUSE_NODE_ID: undefined, MUSE_SDK_TOKEN: undefined, MUSE_REFRESH_TOKEN: undefined }
  const refreshes: string[] = []
  const deployments: Record<string, string | undefined>[] = [{}, { MUSE_SDK_TOKEN: undefined }, removed]
  for (const [step, overrides] of deployments.entries()) {
    const worker = await startWorker(async (request) => {
      const endpoint = new URL(request.url).pathname
      if (endpoint === '/device_token/refresh') {
        assert.deepEqual(await request.json(), { device_id: 'test-123abc', sdk_token: 'mgst_' + 'A'.repeat(43) })
        refreshes.push(request.headers.get('Authorization')!)
        return Response.json({ access_token: 'access-' + step, refresh_token: 'rotated-' + step })
      }
      if (endpoint === '/fetch_vms') {
        if (step === 2 && request.headers.get('Authorization') === 'Bearer access-0') {
          return new Response(null, { status: 401 })
        }
        return Response.json({ vm_list: [{ vm_id: 'local-vm', vm_auth_token: 'vm-token', vm_url: 'https://vm.example' }] })
      }
      return new Response(null, { status: 503 })
    }, { TELEGRAM_WEBHOOK_SECRET: 'fixture-token', ...overrides }, path)
    try {
      if (step === 0) await worker.setFixtureChat('local-vm')
      const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
      try {
        const status = await admin.callTool({ name: 'get_setup_status' })
        assert.deepEqual(status.structuredContent, {
          deviceConfigured: step !== 1, credentialStorageReady: true,
          active: step === 1 ? null : 'Notifications', ready: step !== 1,
        })
        await admin.callTool({ name: 'register_side_chat', arguments: { name: 'check', sessionId: 'existing' } })
        if (step > 0) {
          for (const source of ['custom', 'telegram']) {
            await admin.callTool({ name: 'set_source_paused', arguments: { source, paused: true } })
          }
          const hook = await fetch(new URL('/v1/hooks/custom', worker.url), {
            method: 'POST', headers: { Authorization: 'Bearer HOOK_TOKEN-test' }, body: 'handoff',
          })
          assert.equal(hook.status, step === 1 ? 503 : 202)
          await hook.text()
          const telegram = await fetch(new URL('/v1/hooks/telegram', worker.url), {
            method: 'POST',
            headers: { 'X-Telegram-Bot-Api-Secret-Token': 'fixture-token' },
            body: JSON.stringify({ update_id: 42, message: { message_id: 12, chat: { id: -5 }, text: 'handoff' } }),
          })
          assert.equal(telegram.status, step === 1 ? 503 : 200)
          await telegram.text()
        }
      } finally { await admin.close() }
    } finally { await worker.close() }
  }
  assert.deepEqual(refreshes, ['Bearer hatch_refresh:test-initial-refresh', 'Bearer hatch_refresh:rotated-0'])
})
