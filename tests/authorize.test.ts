import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Response as WorkerResponse } from 'miniflare'
import { signIn } from '../scripts/muse-login.ts'
import { beginPairing, uploadPairing } from '../scripts/worker-pairing.ts'
import { startWorker } from './worker.ts'
import { connect } from './mcp-client.ts'

const sdkToken = 'mgst_' + 'A'.repeat(43)
const blank = { MUSE_NODE_ID: undefined, MUSE_SDK_TOKEN: undefined, MUSE_REFRESH_TOKEN: undefined }

test('a malformed successful authentication response cannot appear in terminal errors', async () => {
  await assert.rejects(signIn('homelink-abcdef', async () => sdkToken, new AbortController().signal, {
    transport: async () => new Response('private-fixture-credential: invalid json'),
  }), { message: 'Muse returned an unreadable authentication response.' })
})

test('a lost upload acknowledgement is resolved against the exact pairing after Bluetooth exits', async t => {
  const worker = await startWorker(() => WorkerResponse.json({ access_token: 'access', refresh_token: 'rotated' }), blank)
  t.after(() => worker.close())
  const options = { worker: worker.url, admin: 'MCP_ADMIN_TOKEN-test', signal: new AbortController().signal }
  const pending = await beginPairing(options)
  assert.equal(pending.state, 'awaiting_authorization')
  const device = { nodeId: pending.nodeId, sdkToken, refreshToken: 'first-pair' }
  let posts = 0
  const lifetime = new AbortController()
  const lostResponse: typeof fetch = async (url, init) => {
    if (new URL(String(url)).pathname === '/v1/setup/pairing') {
      posts++
      const response = await fetch(url, init)
      assert.equal(response.status, 204)
      lifetime.abort()
      throw new Error('Lost acknowledgement')
    }
    return fetch(url, init)
  }
  await uploadPairing({ ...options, transport: lostResponse }, device, undefined, lifetime.signal)
  assert.equal(posts, 1)

  const interrupted = new AbortController()
  const neverUploaded: typeof fetch = async (url, init) => {
    if (new URL(String(url)).pathname === '/v1/setup/pairing') {
      posts++
      interrupted.abort()
      throw new Error('Connection closed')
    }
    return fetch(url, init)
  }
  await assert.rejects(uploadPairing({ ...options, transport: neverUploaded }, {
    ...device, refreshToken: 'different-proposal',
  }, undefined, interrupted.signal), /could not confirm this pairing/i)
  assert.equal(posts, 2)
})

test('sign-in handles server-selected accounts and 2FA and only returns device credentials', async () => {
  const answers = [sdkToken, 'fixture@example.invalid', 'otp', '1', '1', 'code']
  const calls: string[] = []
  let flow: unknown
  const transport: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, 'error')
    const target = new URL(String(url))
    const body = JSON.parse(String(init?.body))
    const bearer = new Headers(init?.headers).get('authorization')
    calls.push(target.pathname.split('/').at(-1)!)
    if (target.hostname === 'api.muse.ai') {
      assert.equal(target.pathname, '/device_token/mint')
      assert.equal(bearer, 'Bearer account-access')
      assert.equal(body.device_id, 'homelink-abcdef')
      assert.equal(body.sdk_token, sdkToken)
      return Response.json({ payload: { access_token: 'device-access', refresh_token: 'device-refresh' } })
    }
    assert.equal(target.hostname, 'hatch-api.meta.ai')
    if (target.pathname.endsWith('/start')) {
      assert.equal(bearer, null)
      flow = body
      return Response.json({ access_token: 'temporary' })
    }
    assert.deepEqual({ device_id: body.device_id, waterfall_id: body.waterfall_id }, flow)
    assert.equal(bearer, 'Bearer temporary')
    switch (calls.at(-1)) {
      case 'login_options': return Response.json({ password_login_available: true })
      case 'send_otp':
        assert.equal(body.contact_point, 'fixture@example.invalid')
        assert.equal(body.region, undefined)
        return Response.json({ auth_state: 'state' })
      case 'confirm_otp':
        assert.equal(body.otp_code, 'otp')
        assert.equal(body.auth_state, 'state')
        return Response.json({ account_selection_required: true, selection_state: 'select', accounts: [{ account_ref: 'owner' }] })
      case 'select_account':
        assert.equal(body.account_ref, 'owner')
        return Response.json({ two_factor_required: true, two_factor_state: 'challenge', two_factor_methods: [{ method_id: 'm1', method_type: 'SMS' }] })
      case 'send_code': return Response.json({})
      case 'two_factor':
        assert.deepEqual([body.two_factor_state, body.method_id, body.code], ['challenge', 'm1', 'code'])
        return Response.json({ abra_user_id: 'owner', abra_access_token: 'account-access' })
      default: assert.fail('Unexpected request')
    }
  }
  const pair = await signIn('homelink-abcdef', async () => answers.shift()!, new AbortController().signal, { transport })
  assert.deepEqual(calls, ['start', 'login_options', 'send_otp', 'confirm_otp', 'select_account', 'send_code', 'two_factor', 'mint'])
  assert.deepEqual(pair, { nodeId: 'homelink-abcdef', sdkToken, refreshToken: 'device-refresh' })
})

for (const phone of ['09000000000', '+819000000000']) {
  test('SMS sign-in preserves ' + (phone.startsWith('+') ? 'international' : 'national') + ' digits with a region', async () => {
    const requests: string[] = []
    const exchange: typeof fetch = async (url, init) => {
      const action = new URL(String(url)).pathname.split('/').at(-1)!
      requests.push(action)
      const payload = JSON.parse(String(init?.body))
      if (action === 'send_otp') {
        assert.equal(payload.region, 'JP')
        assert.equal(payload.contact_point, phone)
        return Response.json({}, { status: 400 })
      }
      assert.equal(payload.region, undefined)
      return Response.json(action === 'start' ? { access_token: 'temporary' } : {})
    }
    const prompt = async (label: string) => label.includes('SDK') ? sdkToken : phone
    await assert.rejects(signIn('homelink-abcdef', prompt, new AbortController().signal, { transport: exchange, region: 'jp' }), /HTTP 400/)
    assert.deepEqual(requests, ['start', 'login_options', 'send_otp'])
  })
}

for (const [action, status] of [['login_options', 200], ['send_otp', 200], ['send_otp', 400]] as const) {
  test(`password_required at ${action} (HTTP ${status}) stops pairing before the code prompt`, async () => {
    const calls: string[] = []
    const inputs = [sdkToken, 'fixture@example.invalid']
    const transport: typeof fetch = async url => {
      const step = new URL(String(url)).pathname.split('/').at(-1)!
      calls.push(step)
      if (step === action) return Response.json({
        registration_state: 'password_required', password_login_available: true, flow: null,
      }, { status })
      if (step === 'start') return Response.json({ access_token: 'temporary' })
      assert.equal(step, 'login_options')
      return Response.json({})
    }
    await assert.rejects(signIn('homelink-abcdef', async () => {
      assert.ok(inputs.length, 'unexpected credential prompt')
      return inputs.shift()!
    }, new AbortController().signal, { transport }), /password sign-in.*cannot complete pairing/i)
    assert.deepEqual(calls, action === 'login_options' ? ['start', action] : ['start', 'login_options', action])
  })
}

test('OTP rejection reports a known reason without echoing private server fields or retrying', async () => {
  for (const [errorBody, hint] of [
    [{ error: { message: 'Too many requests for fixture@example.invalid', code: 999999 } }, ' Muse reported a rate limit.'],
    [{ detail: 'fixture@example.invalid 123456' }, ' No recognized reason in the JSON response.'],
  ] as const) {
    const responses = [{ access_token: 'temporary' }, {}, errorBody]
    await assert.rejects(signIn('homelink-abcdef', async label => label.includes('SDK') ? sdkToken : 'fixture@example.invalid',
      new AbortController().signal, { transport: async () => {
        assert.ok(responses.length)
        const status = responses.length === 1 ? 400 : 200
        return Response.json(responses.shift(), { status })
      } }), { message: 'Muse rejected /hatch/auth/send_otp (HTTP 400).' + hint })
    assert.equal(responses.length, 0)
  }
})

test('an account checkpoint stops authorization before minting a device', async () => {
  const responses = [{ access_token: 'temporary' }, {}, { auth_state: 'state' }, { checkpoint_required: true, abra_access_token: 'unaccepted', abra_user_id: 'x' }]
  await assert.rejects(signIn('homelink-abcdef', async label => label.includes('SDK') ? sdkToken : 'value', new AbortController().signal, { transport: async () => {
    assert.ok(responses.length)
    return Response.json(responses.shift())
  } }), /account check/)
})

test('cancelling while Muse confirms the code aborts the request and prevents minting', async () => {
  const controller = new AbortController()
  let confirming: AbortSignal | null | undefined
  const requests: string[] = []
  const transport: typeof fetch = async (url, init) => {
    const action = new URL(String(url)).pathname.split('/').at(-1)!
    requests.push(action)
    switch (action) {
      case 'start': return Response.json({ access_token: 'temporary' })
      case 'login_options': return Response.json({})
      case 'send_otp': return Response.json({ auth_state: 'pending' })
      case 'confirm_otp':
        confirming = init?.signal
        controller.abort()
        // The response may already have arrived when the user cancels.
        return Response.json({ abra_access_token: 'account-access', abra_user_id: 'owner' })
      default: throw new Error('Unexpected request after cancellation')
    }
  }
  const prompt = async (label: string) => label.includes('SDK') ? sdkToken : 'fixture'
  await assert.rejects(signIn('homelink-abcdef', prompt, controller.signal, { transport }), { name: 'AbortError' })
  assert.equal(confirming?.aborted, true)
  assert.deepEqual(requests, ['start', 'login_options', 'send_otp', 'confirm_otp'])
})

test('only the admin can provision a fresh Worker and an existing pairing survives retries and restarts', async t => {
  const path = await mkdtemp(join(tmpdir(), 'museknock-import-'))
  t.after(() => rm(path, { force: true, recursive: true }))
  const pair = { nodeId: 'homelink-123abc', sdkToken, refreshToken: 'device-refresh' }
  const begin = { name: 'begin_muse_pairing' }
  const refreshes: string[] = []
  const outbound: Parameters<typeof startWorker>[0] = req => {
    if (new URL(req.url).pathname === '/fetch_vms') return WorkerResponse.json({ vm_list: [] })
    assert.equal(new URL(req.url).pathname, '/device_token/refresh')
    const bearer = req.headers.get('Authorization') ?? ''
    refreshes.push(bearer)
    if (bearer.endsWith(':bad')) return new WorkerResponse(null, { status: 401 })
    if (bearer.endsWith(':down')) return new WorkerResponse(null, { status: 503 })
    return WorkerResponse.json({ access_token: 'verified-access', refresh_token: 'verified-' + refreshes.length })
  }
  for (const stage of ['begin', 'finish', 'restart']) {
    const worker = await startWorker(outbound, { ...blank, MCP_RECOVERY_TOKEN: 'MCP_RECOVERY_TOKEN-test' }, path)
    const endpoint = new URL('/v1/setup/pairing', worker.url)
    const post = (token: string, body: unknown) => fetch(endpoint, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const admin = 'MCP_ADMIN_TOKEN-test'
    const client = await connect(new URL('/mcp', worker.url), admin)
    try {
      const result = await client.callTool(begin)
      const details = result.structuredContent as Record<string, unknown>
      assert.ok(details)
      if (stage === 'begin') {
        const node = details.nodeId
        assert.equal(details.state, 'awaiting_authorization')
        assert.equal(typeof node, 'string')
        assert.match(String(node), /^homelink-[a-f0-9]{6}$/)
        pair.nodeId = String(node)
        for (const token of ['MCP_TOKEN-test', 'MCP_RECOVERY_TOKEN-test']) {
          const limited = await connect(new URL('/mcp', worker.url), token)
          try { assert.equal((await limited.callTool(begin)).isError, true) } finally { await limited.close() }
        }
        continue
      }
      if (stage === 'finish') {
        assert.equal(details.nodeId, pair.nodeId)
        assert.equal((await post(admin, { ...pair, refreshToken: 'bad' })).status, 422)
        assert.equal((await post(admin, { ...pair, refreshToken: 'down' })).status, 503)
        assert.equal(((await client.callTool(begin)).structuredContent as Record<string, unknown>).state, 'awaiting_authorization')
        const wrong = pair.nodeId.endsWith('0') ? '1' : '0'
        assert.equal((await post(admin, { ...pair, nodeId: pair.nodeId.slice(0, -1) + wrong })).status, 409)
      } else {
        assert.deepEqual(result.structuredContent, { state: 'configured', verification: 'verified' })
      }
      for (const other of ['MCP_TOKEN-test', 'HOOK_TOKEN-test']) assert.equal((await post(other, pair)).status, 401)
      assert.equal((await post(admin, { ...pair, session: 'must-never-save-account-session' })).status, 400)
      assert.equal((await post(admin, pair)).status, 204)
      assert.equal((await post(admin, { ...pair, refreshToken: 'another-refresh' })).status, 409)
      if (stage === 'restart') {
        await worker.setFixtureChat('old-account-VM')
        const repair = (await client.callTool({ ...begin, arguments: { replace: true } })).structuredContent as Record<string, unknown>
        assert.equal(repair.nodeId, pair.nodeId)
        assert.equal(typeof repair.replaces, 'string')
        const candidate = { ...pair, refreshToken: 'replacement', replaces: repair.replaces }
        assert.equal((await post(admin, { ...candidate, refreshToken: 'bad' })).status, 422)
        const oldChat = (await client.callTool({ name: 'list_side_chats' })).structuredContent as Record<string, unknown>
        assert.equal(oldChat.active, 'Notifications')
        const queued = await fetch(new URL('/v1/hooks/custom', worker.url), {
          method: 'POST', headers: { Authorization: 'Bearer HOOK_TOKEN-test' }, body: 'For the old chat only',
        })
        assert.equal(queued.status, 202)
        const receipt = await queued.json() as { id: string }
        const concurrent = await Promise.all([post(admin, candidate), post(admin, candidate)])
        assert.deepEqual(concurrent.map(response => response.status), [204, 204])
        const previous = await client.callTool({ name: 'get_delivery_status', arguments: { id: receipt.id } })
        assert.equal((previous.structuredContent as Record<string, unknown>).reason, 'destination_changed')
        assert.equal((await post(admin, { ...candidate, refreshToken: 'late' })).status, 409)
      }
      const status = await client.callTool({ name: 'get_setup_status' })
      assert.deepEqual(status.structuredContent, { deviceConfigured: true, active: null, ready: false, credentialStorageReady: true })
    } finally {
      await client.close()
      await worker.close()
    }
  }
  assert.deepEqual(refreshes, ['bad', 'down', 'device-refresh', 'bad', 'replacement'].map(v => 'Bearer hatch_refresh:' + v))
})
