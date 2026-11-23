import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { fetch as localFetch, Response } from 'miniflare'
import { sendOverLink } from '../src/link/chat.ts'
import { connect } from './mcp-client.ts'
import { startWorker } from './worker.ts'

test(
  'posts to the original side chat using the upstream Python SDK responder',
  {
    skip: process.env.MUSE_SDK_TESTS
      ? false
      : 'set MUSE_SDK_TESTS to the upstream linux/tests directory',
    timeout: 30_000,
  },
  async (t) => {
    const peer = spawn(
      process.env.MUSE_PYTHON ?? 'python3',
      [fileURLToPath(new URL('./link-peer.py', import.meta.url))],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    const exited = once(peer, 'exit')
    t.after(() => {
      peer.kill()
    })
    const output = createInterface({ input: peer.stdout })
    const [port] = await Promise.race([
      once(output, 'line'),
      exited.then(() => {
        throw Error('SDK peer did not start')
      }),
    ])
    for (const [path, outcome] of [
      ['send', 'sent'],
      ['reject-registration', 'not_sent'],
      ['lost-ack', 'unknown'],
      ['malformed-ack', 'unknown'],
      ['empty-ack', 'unknown'],
      ['array-ack', 'unknown'],
    ]) {
      const socket = new WebSocket('ws://127.0.0.1:' + port + '/' + path)
      await once(socket, 'open')
      try {
        assert.equal(
          await sendOverLink(
            socket,
            'test-123abc',
            'same-chat',
            'event'.repeat(15_000),
            AbortSignal.timeout(8_000),
          ),
          outcome,
        )
      } finally {
        if (socket.readyState < WebSocket.CLOSING) socket.close()
      }
    }
    const accountRequests: string[] = []
    const worker = await startWorker(
      async (req) => {
        const url = new URL(req.url)
        if (url.origin === 'https://hatch.metaaivm.com') {
          assert.equal(req.headers.get('upgrade'), 'websocket')
          return localFetch('http://127.0.0.1:' + port + url.pathname + url.search, {
            headers: {
              Upgrade: 'websocket',
              Authorization: req.headers.get('authorization') ?? '',
            },
            redirect: 'manual',
          })
        }
        assert.equal(url.origin, 'https://api.muse.ai')
        accountRequests.push(url.pathname)
        if (req.method === 'POST' && url.pathname === '/device_token/refresh') {
          assert.equal(
            req.headers.get('authorization'),
            'Bearer hatch_refresh:test-initial-refresh',
          )
          assert.deepEqual(await req.json(), {
            device_id: 'test-123abc',
            sdk_token: 'mgst_' + 'A'.repeat(43),
          })
          return Response.json({ access_token: 'local-access', refresh_token: 'local-refresh' })
        }
        assert.equal(req.method, 'GET')
        assert.equal(url.pathname, '/fetch_vms')
        assert.equal(req.headers.get('authorization'), 'Bearer local-access')
        return Response.json({
          vm_list: [
            { vm_id: 'local-vm', vm_auth_token: 'local-vm-token', vm_url: 'https://vm.example' },
          ],
        })
      },
      { MUSE_SESSION_ID: '' },
    )
    t.after(() => worker.close())
    const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
    t.after(() => admin.close())
    const selected = await admin.callTool({
      name: 'register_side_chat',
      arguments: { name: 'My existing chat', sessionId: 'same-chat' },
    })
    assert.deepEqual(selected.structuredContent, {
      active: 'My existing chat',
      chats: [{ name: 'My existing chat', sessionId: 'same-chat' }],
    })
    const post = () =>
      fetch(new URL('/hooks/default', worker.url), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer HOOK_TOKEN-test',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'interop',
        },
        body: '{\n  "id": 9007199254740993\n}\n',
      })
    const first = await post()
    assert.equal(first.status, 202)
    const receipt = await first.json()
    const deadline = Date.now() + 10_000
    let repeated
    do {
      await delay(50)
      const duplicate = await post()
      assert.equal(duplicate.status, 200)
      repeated = await duplicate.json()
    } while (['queued', 'sending'].includes(repeated.state) && Date.now() < deadline)
    assert.deepEqual(repeated, { id: receipt.id, duplicate: true, state: 'sent' })
    assert.deepEqual(accountRequests, ['/device_token/refresh', '/fetch_vms'])
    assert.equal((await exited)[0], 0)
  },
)
