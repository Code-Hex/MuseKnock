import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/setup-gmail.sh', import.meta.url))
const args = ['mail-project', 'https://worker.example/']
const topic = 'projects/mail-project/topics/museknock-gmail'

function setup(t, state = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'museknock-gmail-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = join(dir, 'calls')
  writeFileSync(log, '')
  writeFileSync(
    join(dir, 'gcloud'),
    `#!/bin/sh
echo "$*" >> "$CALL_LOG"
case "$*" in
  "projects describe "*) echo 123456;;
  "iam service-accounts list "*) echo "$EXISTING_ACCOUNT";;
  "pubsub topics list "*) echo "$EXISTING_TOPIC";;
  "pubsub subscriptions list "*) echo "$SUB_TOPIC";;
esac
`,
    { mode: 0o755 },
  )
  return {
    run: (...args) =>
      spawnSync('bash', [script, ...args], {
        encoding: 'utf8',
        env: { PATH: dir + ':/usr/bin:/bin', CALL_LOG: log, ...state },
      }),
    calls: () => readFileSync(log, 'utf8'),
  }
}

test('preview prints complete settings without executing gcloud', (t) => {
  const { run, calls } = setup(t)
  const result = run('--dry-run', ...args)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /GMAIL_PUSH_AUDIENCE=https:\/\/worker.example\/hooks\/gmail/)
  assert.equal(calls(), '')
  assert.notEqual(run('mail-project', 'http://worker.example').status, 0)
  assert.equal(calls(), '')
})

test('provisions scoped identities and an OIDC subscription on a fresh project', (t) => {
  const { run, calls } = setup(t)
  const result = run(...args)
  assert.equal(result.status, 0, result.stderr)
  assert.match(calls(), /service-accounts create /)
  assert.match(calls(), /topics create /)
  assert.match(calls(), /topics add-iam-policy-binding .*gmail-api-push@system.gserviceaccount.com/)
  assert.match(
    calls(),
    /service-accounts add-iam-policy-binding .*service-123456@gcp-sa-pubsub.iam.gserviceaccount.com/,
  )
  assert.match(
    calls(),
    /subscriptions create .*--push-auth-token-audience=https:\/\/worker.example\/hooks\/gmail/,
  )
})

test('reconciles push settings on a rerun and rejects a different subscription topic', (t) => {
  const state = {
    EXISTING_ACCOUNT: 'museknock-gmail-push@mail-project.iam.gserviceaccount.com',
    EXISTING_TOPIC: topic,
    SUB_TOPIC: topic,
  }
  const ready = setup(t, state)
  assert.equal(ready.run(...args).status, 0)
  assert.doesNotMatch(ready.calls(), /(?:service-accounts|topics|subscriptions) create /)
  assert.match(ready.calls(), /subscriptions modify-push-config /)
  const conflict = setup(t, { ...state, SUB_TOPIC: 'projects/mail-project/topics/unrelated' })
  assert.notEqual(conflict.run(...args).status, 0)
  assert.doesNotMatch(conflict.calls(), /subscriptions modify-push-config /)
})
