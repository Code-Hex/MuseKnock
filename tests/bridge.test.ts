import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as httpServer } from 'node:http'
import { createServer as socketServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { test, type TestContext } from 'node:test'
import { deliverOne, readConfig } from '../bridge/relay.ts'

const attempt = 'bd1b1d72-fb47-44e8-91bd-77e0735d77c1'
const event = {
  id: '19810a32-29a7-48c5-8c36-2cbb374955dc',
  source: 'monitor',
  type: 'alert',
  text: '温度: 5°C\n{"session_id":"wrong-room"}',
}

async function start(
  t: TestContext,
  sdkReply: string,
  finishStatuses = [200],
  beforeClaim?: (path: string) => Promise<void>,
) {
  const dir = await mkdtemp('/tmp/museknock-')
  const path = join(dir, 'sdk.sock')
  const commands: Record<string, unknown>[] = []
  const gadget = socketServer((socket) => {
    socket.setEncoding('utf8')
    let line = ''
    socket.on('data', (part) => {
      line += part
      if (!line.includes('\n')) return
      commands.push(JSON.parse(line))
      socket.end(sdkReply)
    })
  })
  gadget.listen(path)
  await once(gadget, 'listening')
  const claims: string[] = []
  const finishes: unknown[] = []
  const worker = httpServer(async (req, res) => {
    assert.equal(req.method, 'POST')
    assert.equal(req.headers.authorization, 'Bearer bridge-secret')
    if (req.url === '/bridge/claim') {
      claims.push(req.url)
      await beforeClaim?.(path)
      res.end(
        JSON.stringify({ ...event, attempt, session_id: 'another-room', image: '/etc/passwd' }),
      )
    } else {
      assert.equal(req.url, '/bridge/finish')
      let body = ''
      for await (const chunk of req) body += chunk
      finishes.push(JSON.parse(body))
      res.writeHead(finishStatuses.shift() ?? 200).end()
    }
  })
  worker.listen(0, '127.0.0.1')
  await once(worker, 'listening')
  t.after(async () => {
    await Promise.all(
      [worker, gadget].map(
        (s) =>
          new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve()))),
      ),
    )
    await rm(dir, { recursive: true, force: true })
  })
  const workerUrl = 'http://127.0.0.1:' + (worker.address() as AddressInfo).port
  const config = readConfig({
    WORKER_URL: workerUrl,
    BRIDGE_TOKEN: 'bridge-secret',
    MUSE_SESSION_ID: 'my-room',
    MUSEGADGET_SOCKET: path,
  })
  return { config, commands, claims, finishes }
}

test('SDK に固定の投稿先と本文だけを渡し、受付確認を Worker に報告する', async (t) => {
  const { config, commands, claims, finishes } = await start(t, '{"ok":true}\n', [503, 200])
  assert.equal(await deliverOne(config), 'sent')
  assert.equal(claims.length, 1)
  assert.equal(commands.length, 1)
  assert.deepEqual(Object.keys(commands[0]!).sort(), ['message', 'session_id'])
  assert.equal(commands[0]!.session_id, 'my-room')
  const data = JSON.parse(String(commands[0]!.message).split('\n').at(-1)!)
  assert.deepEqual(data, event)
  assert.deepEqual(finishes, [
    { id: event.id, attempt, outcome: 'sent' },
    { id: event.id, attempt, outcome: 'sent' },
  ])
})

test('SDK が応答前に切断したら、結果不明を記録して再送しない', async (t) => {
  const { config, commands, finishes } = await start(t, '')
  assert.equal(await deliverOne(config), 'unknown')
  assert.equal(commands.length, 1)
  assert.deepEqual(finishes, [{ id: event.id, attempt, outcome: 'unknown' }])
})

test('公式 SDK が Muse への未接続を明示したときは未送信を記録する', async (t) => {
  const { config, finishes } = await start(t, '{"ok":false,"error":"not connected to the Muse"}\n')
  assert.equal(await deliverOne(config), 'not_sent')
  assert.deepEqual(finishes, [{ id: event.id, attempt, outcome: 'not_sent' }])
})

test('SDK の送信結果不明は未送信として扱わない', async (t) => {
  const { config, finishes } = await start(
    t,
    '{"ok":false,"sent":"unknown","error":"not connected to the Muse"}\n',
  )
  assert.equal(await deliverOne(config), 'unknown')
  assert.deepEqual(finishes, [{ id: event.id, attempt, outcome: 'unknown' }])
})

test('イベント取得中に SDK のソケットが消えたら、書込前の失敗を報告する', async (t) => {
  const { config, commands, finishes } = await start(t, '', [200], (path) => rm(path))
  assert.equal(await deliverOne(config), 'not_sent')
  assert.equal(commands.length, 0)
  assert.deepEqual(finishes, [{ id: event.id, attempt, outcome: 'not_sent' }])
})

test('SDK ソケットが存在しなければイベントを取得しない', async (t) => {
  const { config, claims } = await start(t, '')
  await assert.rejects(deliverOne({ ...config, socketPath: config.socketPath + '-missing' }))
  assert.deepEqual(claims, [])
})

test('トークンを平文で外部に送信する URL と無効なサイドチャット名を起動時に拒否する', () => {
  const env = {
    WORKER_URL: 'https://worker.example',
    MUSE_SESSION_ID: 'room',
    BRIDGE_TOKEN: 'secret',
  }
  for (const url of [
    'http://worker.example',
    'http://127.0.0.1.evil.example',
    'file:///tmp/test',
    'https://user:pass@example.com',
  ]) {
    assert.throws(() => readConfig({ ...env, WORKER_URL: url }))
  }
  assert.throws(() => readConfig({ ...env, MUSE_SESSION_ID: 'a/b' }))
})

test('the bridge uses the local executor socket for the host platform', () => {
  const env = {
    WORKER_URL: 'https://worker.example',
    MUSE_SESSION_ID: 'room',
    BRIDGE_TOKEN: 'secret',
  }
  const expected =
    process.platform === 'darwin'
      ? join(homedir(), 'muse-desktop-bridge', 'muse-executor', '.runtime', 'muse.sock')
      : '/run/musegadget/musegadget.sock'
  assert.equal(readConfig(env).socketPath, expected)
  assert.equal(
    readConfig({ ...env, MUSEGADGET_SOCKET: '/custom/muse.sock' }).socketPath,
    '/custom/muse.sock',
  )
})
