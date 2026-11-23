import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connect } from './mcp-client.ts'
import { startWorker } from './worker.ts'

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
}

test('MCP readers inspect delivery rules; only administrators can change them', async (t) => {
  const worker = await startWorker()
  t.after(() => worker.close())
  const url = new URL('/mcp', worker.url)
  const reader = await connect(url, 'MCP_TOKEN-test')
  const admin = await connect(url, 'MCP_ADMIN_TOKEN-test')
  t.after(() => Promise.all([reader.close(), admin.close()]))

  assert.deepEqual((await reader.listTools()).tools.map((tool) => tool.name).sort(), [
    'get_delivery_status',
    'get_setup_status',
    'list_side_chats',
    'list_sources',
  ])
  assert.deepEqual((await admin.listTools()).tools.map((tool) => tool.name).sort(), [
    'get_delivery_status',
    'get_setup_status',
    'list_side_chats',
    'list_sources',
    'register_side_chat',
    'send_test_notification',
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

  const setup = () => reader.callTool({ name: 'get_setup_status' })
  assert.deepEqual((await setup()).structuredContent, {
    credentialStorageReady: true,
    deviceConfigured: true,
    active: null,
    ready: false,
  })
  const requestId = crypto.randomUUID()
  const sendTest = { name: 'send_test_notification', arguments: { requestId } }
  const missingDestination = await admin.callTool(sendTest)
  assert.equal(missingDestination.isError, true)
  assert.match(JSON.stringify(missingDestination.content), /register.*side chat/i)
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
  assert.deepEqual((await setup()).structuredContent, {
    credentialStorageReady: true,
    deviceConfigured: true,
    active: first.name,
    ready: true,
  })
  assert.equal((await reader.callTool(sendTest)).isError, true)
  assert.equal(
    (await admin.callTool({ name: 'send_test_notification', arguments: { requestId: 'invalid' } }))
      .isError,
    true,
  )
  const receipt = (await admin.callTool(sendTest)).structuredContent
  assertRecord(receipt)
  assert.equal(typeof receipt.id, 'string')
  assert.deepEqual(receipt, { id: receipt.id, state: 'queued', duplicate: false })
  assert.deepEqual((await admin.callTool(sendTest)).structuredContent, {
    ...receipt,
    duplicate: true,
  })
  const delivery = (
    await reader.callTool({ name: 'get_delivery_status', arguments: { id: receipt.id } })
  ).structuredContent
  assertRecord(delivery)
  assert.equal(delivery.source, 'museknock-test')
  assert.equal(delivery.type, 'test')
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

test('MCP setup checks disclose no device secrets and never send an implicit test', async (t) => {
  const worker = await startWorker(undefined, { MUSE_REFRESH_TOKEN: '' })
  t.after(() => worker.close())
  const url = new URL('/mcp', worker.url)
  const admin = await connect(url, 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  assert.deepEqual((await admin.callTool({ name: 'get_setup_status' })).structuredContent, {
    credentialStorageReady: true,
    deviceConfigured: false,
    active: 'default',
    ready: false,
  })
  const missingDevice = await admin.callTool({
    name: 'send_test_notification',
    arguments: { requestId: crypto.randomUUID() },
  })
  assert.equal(missingDevice.isError, true)
  assert.match(JSON.stringify(missingDevice.content), /device.*(secrets|credentials)/i)
  assert.deepEqual((await admin.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [],
  })
})

test('MCP test notifications respect the source pause and rate limits', async (t) => {
  const worker = await startWorker()
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  await admin.callTool({
    name: 'set_source_paused',
    arguments: { source: 'museknock-test', paused: true },
  })
  const send = () =>
    admin.callTool({
      name: 'send_test_notification',
      arguments: { requestId: crypto.randomUUID() },
    })
  for (let i = 0; i < 10; i++) {
    const receipt = (await send()).structuredContent
    assertRecord(receipt)
    assert.equal(receipt.state, 'suppressed')
  }
  const limited = await send()
  assert.equal(limited.isError, true)
  assert.match(JSON.stringify(limited.content), /rate limit/i)
})

test('a shared webhook or read-only credential cannot authorize MCP administration', async (t) => {
  for (const reused of ['HOOK_TOKEN', 'MCP_TOKEN']) {
    const token = reused + '-test'
    const worker = await startWorker(undefined, { MCP_ADMIN_TOKEN: token })
    t.after(() => worker.close())
    const response = await fetch(new URL('/mcp', worker.url), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
    })
    assert.equal(response.status, 503)
  }
})

test('credential storage must be available before accepting deliveries or refreshing tokens', async (t) => {
  const calls: string[] = []
  for (const key of ['', 'a'.repeat(64)]) {
    const worker = await startWorker(
      (req) => {
        calls.push(req.url)
        throw new Error('Unexpected outbound request')
      },
      { CREDENTIAL_ENCRYPTION_KEY: key, HOOK_TOKEN: 'A'.repeat(64) },
    )
    t.after(() => worker.close())
    const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
    t.after(() => admin.close())
    const status = (await admin.callTool({ name: 'get_setup_status' })).structuredContent
    assert.deepEqual(status, {
      deviceConfigured: true,
      active: 'default',
      credentialStorageReady: false,
      ready: false,
    })
    const test = await admin.callTool({
      name: 'send_test_notification',
      arguments: { requestId: crypto.randomUUID() },
    })
    assert.equal(test.isError, true)
    const response = await fetch(new URL('/hooks/default', worker.url), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + 'A'.repeat(64) },
      body: 'test',
    })
    assert.equal(response.status, 503)
  }
  assert.deepEqual(calls, [])
})
