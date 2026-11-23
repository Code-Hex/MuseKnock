import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'

test('setup creates private files and keeps the same credentials on rerun', async (t) => {
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
      { cwd, encoding: 'utf8' },
    )
  const output = run()
  const vars = join(cwd, '.dev.vars')
  const secrets = parseEnv(await readFile(vars, 'utf8'))
  assert.equal(new Set(Object.values(secrets)).size, 4)
  for (const value of Object.values(secrets)) {
    assert.match(value!, /^[a-f0-9]{64}$/)
    assert.ok(!output.includes(value!))
  }
  const bridge = join(cwd, '.env.bridge')
  const config = await readFile(bridge, 'utf8')
  assert.equal(parseEnv(config).BRIDGE_TOKEN, secrets.BRIDGE_TOKEN)
  for (const file of [vars, bridge]) assert.equal((await stat(file)).mode & 0o777, 0o600)
  run()
  assert.deepEqual(parseEnv(await readFile(vars, 'utf8')), secrets)
  assert.equal(await readFile(bridge, 'utf8'), config)
})
