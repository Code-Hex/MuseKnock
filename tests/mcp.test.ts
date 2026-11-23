import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startWorker } from './worker.ts'

async function connect(url: URL, token: string) {
  const client = new Client({ name: 'museknock-test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  return client
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
    'list_sources',
  ])
  assert.deepEqual((await admin.listTools()).tools.map((tool) => tool.name).sort(), [
    'get_delivery_status',
    'list_sources',
    'set_event_filter',
    'set_source_paused',
  ])

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
