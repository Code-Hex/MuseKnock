import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pollDiscord, type DiscordCheckpoint } from '../src/discord.ts'

const channel = '111000000000000011'
const token = 'test-discord-bot-token'
const ids = Array.from({ length: 26 }, (_, n) => (111000000000000020n + BigInt(n)).toString())
function message(id: string, content = id) {
  return {
    id,
    channel_id: channel,
    author: { id: '111000000000000017', username: 'Muse' },
    type: 0,
    content,
    attachments: [],
  }
}
const noEvents = async () => {
  throw new Error('Unexpected delivery')
}
function history(rows: ReturnType<typeof message>[], urls: URL[] = []) {
  return async (url: URL, init: RequestInit) => {
    urls.push(url)
    assert.equal(url.origin, 'https://discord.com')
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bot ' + token)
    assert.equal(init.redirect, 'manual')
    if (url.pathname.endsWith('/' + channel)) return Response.json({ id: channel, type: 0 })
    assert.equal(url.pathname, '/api/v10/channels/' + channel + '/messages')
    const after = url.searchParams.get('after')
    const limit = Number(url.searchParams.get('limit'))
    const chunk = after
      ? rows.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit)
      : rows.slice(-limit)
    return Response.json(chunk.toReversed())
  }
}

test('Discord starts at the latest message and advances through the oldest ten new snowflakes at a time', async () => {
  const urls: URL[] = []
  const rows = ids.map((id) => message(id))
  const base = await pollDiscord(
    channel,
    token,
    undefined,
    noEvents,
    history(rows.slice(0, 2), urls),
  )
  assert.equal(base.lastId, ids[1])
  assert.equal(urls.at(-1)?.searchParams.get('limit'), '1')
  const seen: string[] = []
  const accept: Parameters<typeof pollDiscord>[3] = async (events) => {
    seen.push(...events.map((event) => event.key))
    return 'accepted'
  }
  let state: DiscordCheckpoint = base
  for (let page = 0; page < 3; page++)
    state = await pollDiscord(channel, token, state, accept, history(rows, urls))
  assert.equal(state.lastId, ids.at(-1))
  assert.deepEqual(seen, ids.slice(2))
  assert.equal(urls.at(-1)?.searchParams.get('after'), ids[21])
  assert.deepEqual(
    await pollDiscord(channel, token, base, async () => 'limited', history(rows)),
    base,
  )
  const empty = await pollDiscord(channel, token, undefined, noEvents, history([]))
  assert.ok(BigInt(empty.lastId!) > 0n)
})

test('Discord retains attachment metadata, excludes URLs and system messages, and validates the channel', async () => {
  const state = { channelId: channel, lastId: ids[0] }
  const attach = {
    id: '22',
    filename: 'report.png',
    size: 42,
    content_type: 'image/png',
    url: 'https://example.test/temporary',
  }
  const saved = await pollDiscord(
    channel,
    token,
    state,
    async (events) => {
      assert.equal(events.length, 1)
      const [event] = events
      assert.equal(event.type, 'message')
      const text = JSON.parse(event.text)
      assert.equal(text.content, 'file')
      assert.deepEqual(text.attachments, [
        { filename: 'report.png', size: 42, content_type: 'image/png' },
      ])
      return 'accepted'
    },
    async () =>
      Response.json([
        { ...message(ids[2]), type: 6 },
        { ...message(ids[1], 'file'), attachments: [attach] },
      ]),
  )
  assert.equal(saved.lastId, ids[2])
  await assert.rejects(
    pollDiscord(channel, token, undefined, noEvents, async () =>
      Response.json({ id: channel, type: 1 }),
    ),
  )
  await assert.rejects(
    pollDiscord(channel, token, state, noEvents, async () =>
      Response.json([{ ...message(ids[1]), channel_id: '222' }]),
    ),
  )
  await assert.rejects(
    pollDiscord(channel, token, state, noEvents, async () => new Response(null, { status: 403 })),
  )
})

test('Discord respects retry_after without moving the message cursor or sending another request', async () => {
  const previous = { channelId: channel, lastId: ids[0] }
  const limited = await pollDiscord(channel, token, previous, noEvents, async () =>
    Response.json({ retry_after: 610.5 }, { status: 429 }),
  )
  assert.equal(limited.lastId, previous.lastId)
  assert.ok(limited.retryAt! > Date.now() + 600000)
  const delayed = await pollDiscord(channel, token, limited, noEvents, () =>
    assert.fail('Retry-After still applies'),
  )
  assert.deepEqual(delayed, limited)
})
