import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'

test('local setup prepares the device settings and independent access tokens and preserves existing values', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'museknock-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const run = () =>
    execFileSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('../scripts/setup.ts', import.meta.url)),
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  const vars = join(cwd, '.dev.vars')
  const output = run()
  const contents = await readFile(vars, 'utf8')
  const config = parseEnv(contents)
  const secretNames = ['HOOK_TOKEN', 'MCP_TOKEN', 'MCP_ADMIN_TOKEN', 'CREDENTIAL_ENCRYPTION_KEY']
  for (const name of secretNames) {
    assert.match(config[name]!, /^[a-f0-9]{64}$/)
    assert.ok(!output.includes(config[name]!))
  }
  assert.equal(new Set(secretNames.map((name) => config[name])).size, 4)
  assert.equal(config.MUSE_REFRESH_TOKEN, '')
  assert.deepEqual(Object.keys(config).sort(), [
    ...secretNames, 'MUSE_NODE_ID', 'MUSE_SDK_TOKEN', 'MUSE_REFRESH_TOKEN',
  ].sort())
  assert.equal((await stat(vars)).mode & 0o777, 0o600)
  run()
  assert.equal(await readFile(vars, 'utf8'), contents)

  const cleaned = contents.replace(/^MUSE_(?:NODE_ID|SDK_TOKEN|REFRESH_TOKEN)=.*\n/gm, '')
  await writeFile(vars, cleaned)
  run()
  assert.equal(await readFile(vars, 'utf8'), cleaned)

  await writeFile(vars, 'HOOK_TOKEN=existing\nMCP_TOKEN=reader\nMCP_ADMIN_TOKEN=admin\n')
  run()
  const existing = parseEnv(await readFile(vars, 'utf8'))
  assert.equal(existing.HOOK_TOKEN, 'existing')
  assert.equal(existing.MUSE_NODE_ID, '')
  assert.match(existing.CREDENTIAL_ENCRYPTION_KEY!, /^[a-f0-9]{64}$/)

  for (const recovery of ['reader', 'two words']) {
    const invalid = 'MCP_TOKEN=reader\nMCP_RECOVERY_TOKEN=' + recovery + '\n'
    await writeFile(vars, invalid)
    assert.throws(run, /token/i)
    assert.equal(await readFile(vars, 'utf8'), invalid)
  }
  const publicToken = 'A'.repeat(64)
  for (const key of ['not-hex', '1'.repeat(63), publicToken.toLowerCase()]) {
    const invalid = 'HOOK_TOKEN=' + publicToken + '\nCREDENTIAL_ENCRYPTION_KEY=' + key + '\n'
    await writeFile(vars, invalid)
    assert.throws(run, /CREDENTIAL_ENCRYPTION_KEY/)
    assert.equal(await readFile(vars, 'utf8'), invalid)
  }
  await writeFile(vars, 'CREDENTIAL_ENCRYPTION_KEY=\n')
  run()
  assert.match(parseEnv(await readFile(vars, 'utf8')).CREDENTIAL_ENCRYPTION_KEY!, /^[a-f0-9]{64}$/)
})

test('explicit imports take only device fields and leave unrelated configuration intact', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'museknock-import-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const run = (...args: string[]) =>
    execFileSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('../scripts/setup.ts', import.meta.url)),
        ...args,
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  const vars = join(cwd, '.dev.vars')
  await writeFile(vars, '# custom source\nSOURCE_TOKEN="two words"\n')
  const state = join(cwd, 'state.json')
  const sdk = 'mgst_' + 'A'.repeat(43)
  await writeFile(
    state,
    JSON.stringify({
      sdk_token: sdk,
      session: { access_token: 'private-account-access', refresh_token: 'private-account-refresh' },
      device: {
        device_id: 'homelink-abc123',
        access_token: 'device-access-only',
        refresh_token: 'hatch_refresh:one',
      },
    }),
  )
  const output = run('--device-state', state)
  const contents = await readFile(vars, 'utf8')
  for (const secret of [
    'private-account-access',
    'private-account-refresh',
    'device-access-only',
  ]) {
    assert.ok(!contents.includes(secret) && !output.includes(secret))
  }
  for (const secret of [sdk, 'hatch_refresh:one']) assert.ok(!output.includes(secret))
  assert.ok(contents.includes('# custom source\nSOURCE_TOKEN="two words"'))
  const config = parseEnv(contents)
  assert.equal(config.MUSE_NODE_ID, 'homelink-abc123')
  assert.equal(config.MUSE_REFRESH_TOKEN, 'hatch_refresh:one')
  assert.equal(config.MUSE_SDK_TOKEN, sdk)

  const record = {
    token_type: 'device',
    node_id: 'gadget-654321',
    refresh_token: 'next-device-refresh',
    api_url_v2: 'https://api.muse.ai/',
  }
  const pairing = join(cwd, 'pairing.json')
  for (const invalid of [
    { ...record, node_id: 'not an id' },
    { ...record, api_url_v2: 'https://other.invalid' },
    { ...record, noise_host: 'other.invalid' },
    { ...record, token_type: 'user' },
  ]) {
    await writeFile(pairing, JSON.stringify(invalid))
    assert.throws(() => run('--pairing', pairing))
    assert.equal(await readFile(vars, 'utf8'), contents)
  }
  await writeFile(pairing, JSON.stringify(record))
  run('--pairing', pairing)
  assert.deepEqual(parseEnv(await readFile(vars, 'utf8')), {
    ...config,
    MUSE_NODE_ID: record.node_id,
    MUSE_REFRESH_TOKEN: record.refresh_token,
  })
  assert.equal((await stat(vars)).mode & 0o777, 0o600)
})

test('the deploy button and all quick starts agree on the five initial secrets', async () => {
  const initial = ['MCP_ADMIN_TOKEN', 'CREDENTIAL_ENCRYPTION_KEY', 'MUSE_NODE_ID', 'MUSE_REFRESH_TOKEN', 'MUSE_SDK_TOKEN'].sort()
  const root = new URL('../', import.meta.url)
  const template = parseEnv(await readFile(new URL('.dev.vars.example', root), 'utf8'))
  assert.deepEqual(Object.keys(template).sort(), initial)
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.deepEqual(Object.keys(pkg.cloudflare.bindings).sort(), initial)
  for (const name of ['README.md', 'README.ja.md', 'README.zh-CN.md']) {
    const readme = await readFile(new URL(name, root), 'utf8')
    const quickStart = readme.split('\n## ')[1]
    const rows = [...quickStart.matchAll(/^\| `([A-Z_]+)` \|[^\n|]+\|[^\n|]+\|$/gm)]
    assert.deepEqual(rows.map(row => row[1]).sort(), initial, name)
  }
})
