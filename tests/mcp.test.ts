import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connect } from './mcp-client.ts'
import { startWorker } from './worker.ts'

test('MCP readers inspect delivery rules; only administrators can change them', async (t) => {
  const worker = await startWorker()
  t.after(() => worker.close())
  const url = new URL('/mcp', worker.url)
  const reader = await connect(url, 'MCP_TOKEN-test')
  const admin = await connect(url, 'MCP_ADMIN_TOKEN-test')
  t.after(() => Promise.all([reader.close(), admin.close()]))

  assert.deepEqual((await reader.listTools()).tools.map((tool) => tool.name).sort(), [
    'get_delivery_status',
    'list_side_chats',
    'list_sources',
  ])
  assert.deepEqual((await admin.listTools()).tools.map((tool) => tool.name).sort(), [
    'get_delivery_status',
    'list_side_chats',
    'list_sources',
    'register_side_chat',
    'set_active_side_chat',
    'set_event_filter',
    'set_source_paused',
  ])

  assert.deepEqual((await reader.callTool({ name: 'list_side_chats' })).structuredContent, {
    active: 'default',
    chats: [{ name: 'default', sessionId: 'same-chat' }],
  })

  const pause = { name: 'set_source_paused', arguments: { source: 'ci', paused: true } }
  assert.equal((await reader.callTool(pause)).isError, true)
  assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [],
  })
  assert.deepEqual((await admin.callTool(pause)).structuredContent, {
    source: 'ci',
    paused: true,
    types: [],
  })
  const filter = await admin.callTool({
    name: 'set_event_filter',
    arguments: { source: 'ci', types: ['failed'] },
  })
  assert.deepEqual(filter.structuredContent, { source: 'ci', paused: true, types: ['failed'] })
  assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [{ source: 'ci', paused: true, types: ['failed'] }],
  })

  assert.equal(
    (
      await admin.callTool({
        name: 'set_event_filter',
        arguments: { source: 'ci', types: ['not an event type'] },
      })
    ).isError,
    true,
  )
  assert.equal(
    (
      await reader.callTool({
        name: 'get_delivery_status',
        arguments: { id: crypto.randomUUID() },
      })
    ).isError,
    true,
  )

  const hook = await fetch(new URL('/hooks/default', worker.url), {
    method: 'POST',
    headers: { Authorization: 'Bearer HOOK_TOKEN-test', 'X-Event-Type': 'opened' },
    body: 'sensitive event body',
  })
  assert.equal(hook.status, 202)
  const receipt = await hook.json()
  const status = (
    await reader.callTool({
      name: 'get_delivery_status',
      arguments: { id: receipt.id },
    })
  ).structuredContent
  assert.ok(status && typeof status === 'object' && 'createdAt' in status)
  assert.equal(typeof status.createdAt, 'number')
  assert.deepEqual(status, {
    id: receipt.id,
    source: 'default',
    type: 'opened',
    state: 'queued',
    createdAt: status.createdAt,
  })

  const foreignOrigin = await fetch(url, {
    method: 'GET',
    headers: { Origin: 'https://other.example', Authorization: 'Bearer MCP_ADMIN_TOKEN-test' },
  })
  assert.equal(foreignOrigin.status, 403)
})

test('an admin registers and switches webhook destinations without a deployment session ID', async (t) => {
  const worker = await startWorker(undefined, { MUSE_SESSION_ID: '' })
  t.after(() => worker.close())
  const url = new URL('/mcp', worker.url)
  const reader = await connect(url, 'MCP_TOKEN-test')
  const admin = await connect(url, 'MCP_ADMIN_TOKEN-test')
  t.after(() => Promise.all([reader.close(), admin.close()]))

  const list = () => reader.callTool({ name: 'list_side_chats' })
  const register = (name: string, sessionId: string) => ({
    name: 'register_side_chat',
    arguments: { name, sessionId },
  })
  const select = (name: string) => ({ name: 'set_active_side_chat', arguments: { name } })
  const post = () =>
    fetch(new URL('/hooks/default', worker.url), {
      method: 'POST',
      headers: { Authorization: 'Bearer HOOK_TOKEN-test' },
      body: 'browser setup complete',
    })

  assert.deepEqual((await list()).structuredContent, { active: null, chats: [] })
  assert.equal((await post()).status, 503)
  const first = { name: 'Builds', sessionId: 'room-1' }
  const second = { name: '本番通知', sessionId: 'room-2' }
  const addFirst = register(first.name, first.sessionId)
  assert.equal((await reader.callTool(addFirst)).isError, true)
  assert.equal((await admin.callTool(register('bad\nname', 'room-1'))).isError, true)
  assert.equal(
    (await admin.callTool(register('untrusted', 'https://invalid.example'))).isError,
    true,
  )
  assert.deepEqual((await list()).structuredContent, { active: null, chats: [] })
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await admin.callTool(addFirst)).structuredContent, {
      active: first.name,
      chats: [first],
    })
  }
  assert.equal((await post()).status, 202)
  const chats = [first, second]
  assert.deepEqual(
    (await admin.callTool(register(second.name, second.sessionId))).structuredContent,
    {
      active: first.name,
      chats,
    },
  )
  assert.equal((await reader.callTool(select(second.name))).isError, true)
  assert.equal((await admin.callTool(select('missing'))).isError, true)
  assert.deepEqual((await list()).structuredContent, { active: first.name, chats })
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await admin.callTool(select(second.name))).structuredContent, {
      active: second.name,
      chats,
    })
  }
  const updated = { ...second, sessionId: 'room-3' }
  await admin.callTool(register(updated.name, updated.sessionId))
  assert.deepEqual((await list()).structuredContent, {
    active: updated.name,
    chats: [first, updated],
  })
})
