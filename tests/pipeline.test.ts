import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startWorker } from './worker.ts'

test(
  'the bridge process delivers a real Worker event over the gadget socket',
  { timeout: 20_000 },
  async (t) => {
    const worker = await startWorker()
    t.after(() => worker.close())
    const dir = await mkdtemp('/tmp/museknock-pipeline-')
    const path = join(dir, 'gadget.sock')
    const messages: { session_id: string; message: string }[] = []
    const socket = createServer((connection) => {
      let line = ''
      connection.setEncoding('utf8').on('data', (chunk) => {
        line += chunk
        if (!line.endsWith('\n')) return
        messages.push(JSON.parse(line))
        connection.end('{"ok":true,"status":200}\n')
      })
    }).listen(path)
    await once(socket, 'listening')
    t.after(async () => {
      await new Promise<void>((resolve) => socket.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    })
    const post = () =>
      fetch(new URL('/hooks/default', worker.url), {
        method: 'POST',
        headers: { Authorization: 'Bearer HOOK_TOKEN-test', 'Idempotency-Key': 'first-knock' },
        body: 'テスト通知',
      })
    const receipt = await (await post()).json()
    assert.equal(receipt.state, 'queued')
    const bridge = spawn(process.execPath, ['--import', 'tsx', 'bridge/main.ts'], {
      env: {
        ...process.env,
        WORKER_URL: worker.url.origin,
        MUSE_SESSION_ID: 'test-room',
        BRIDGE_TOKEN: 'BRIDGE_TOKEN-test',
        MUSEGADGET_SOCKET: path,
      },
      stdio: 'ignore',
    })
    const exited = once(bridge, 'exit')
    t.after(async () => {
      bridge.kill()
      await exited
    })
    const deadline = Date.now() + 10_000
    let state
    do {
      state = (await (await post()).json()).state
      if (state === 'sent') break
      await delay(50)
    } while (Date.now() < deadline && bridge.exitCode === null)
    assert.equal(state, 'sent')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].session_id, 'test-room')
    assert.deepEqual(JSON.parse(messages[0].message.split('\n').at(-1)!), {
      id: receipt.id,
      source: 'default',
      type: 'notification',
      text: 'テスト通知',
    })
  },
)
