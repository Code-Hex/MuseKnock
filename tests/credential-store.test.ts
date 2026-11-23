import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CredentialStore } from '../src/credential-store.ts'

const key = 'ab'.repeat(32)
const device = {
  fingerprint: '1'.repeat(64),
  credentials: {
    accessToken: 'example-muse-access',
    refreshToken: 'example-muse-refresh',
    savedAt: 10,
  },
}
const sessionName = 'bluesky-notifications.session'
const session = {
  fingerprint: '2'.repeat(64),
  session: {
    did: 'did:plc:example',
    accessJwt: 'example-bsky-access',
    refreshJwt: 'example-bsky-refresh',
  },
}

function storage() {
  const records = new Map<string, unknown>()
  return {
    records,
    async get<T>(name: string) {
      return structuredClone(records.get(name)) as T | undefined
    },
    async put<T>(name: string, value: T) {
      records.set(name, structuredClone(value))
    },
  }
}

test('writes authenticated ciphertext under a fresh nonce, including the credential fingerprint', async () => {
  const raw = storage()
  const store = new CredentialStore(raw, key)
  await store.put('device', device)
  const first = await raw.get<{ version: number; iv: ArrayBuffer; ciphertext: ArrayBuffer }>(
    'device',
  )
  assert.ok(first)
  assert.deepEqual(Object.keys(first).sort(), ['ciphertext', 'iv', 'version'])
  assert.equal(first.iv.byteLength, 12)
  assert.equal(first.ciphertext.byteLength, Buffer.byteLength(JSON.stringify(device)) + 16)
  for (const value of [
    device.fingerprint,
    device.credentials.accessToken,
    device.credentials.refreshToken,
  ]) {
    assert.equal(Buffer.from(first.ciphertext).includes(Buffer.from(value)), false)
  }
  await store.put('device', device)
  assert.notDeepEqual(first.iv, (await raw.get<typeof first>('device'))!.iv)
  assert.deepEqual(await new CredentialStore(raw, key).get('device'), device)
})

test('missing or invalid keys prevent any migration or credential write', async () => {
  for (const invalid of [undefined, '', 'A'.repeat(63), key + '\n', 'z'.repeat(64)]) {
    const raw = storage()
    await raw.put('device', device)
    const store = new CredentialStore(raw, invalid)
    for (const call of [
      () => store.migrate(),
      () => store.put(sessionName, session),
      () => store.get('device'),
    ]) {
      await assert.rejects(call, /CREDENTIAL_ENCRYPTION_KEY/)
    }
    assert.deepEqual([...raw.records], [['device', device]])
  }
})

test('migrates both legacy records once and keeps unrelated storage intact', async () => {
  const raw = storage()
  await raw.put('device', device)
  await raw.put(sessionName, session)
  await raw.put('checkpoint', { head: 'x' })
  const store = new CredentialStore(raw, key)
  await assert.rejects(store.get('device'))
  await store.migrate()
  const encrypted = structuredClone(raw.records)
  assert.notDeepEqual(encrypted.get('device'), device)
  assert.notDeepEqual(encrypted.get(sessionName), session)
  assert.deepEqual(encrypted.get('checkpoint'), { head: 'x' })
  await store.migrate()
  assert.deepEqual(raw.records, encrypted)
  assert.deepEqual(await store.get('device'), device)
  assert.deepEqual(await store.get(sessionName), session)
})

test('rejects a wrong key, swapped records, corrupt ciphertext and malformed legacy data without overwriting records', async () => {
  const raw = storage()
  const store = new CredentialStore(raw, key)
  await store.put(sessionName, session)
  const encrypted = (await raw.get<{ version: number; iv: ArrayBuffer; ciphertext: ArrayBuffer }>(
    sessionName,
  ))!
  const corrupt = structuredClone(encrypted)
  new Uint8Array(corrupt.ciphertext)[0] ^= 1
  const wrongKey = new CredentialStore(raw, 'cd'.repeat(32))
  await raw.put('device', device)
  await assert.rejects(wrongKey.migrate())
  assert.deepEqual(raw.records.get('device'), device)
  await assert.rejects(wrongKey.get(sessionName))
  await raw.put('device', encrypted)
  await assert.rejects(store.get('device'))
  for (const broken of [
    corrupt,
    { ...encrypted, version: 2 },
    { ...session, version: 2 },
    session.session,
    null,
  ]) {
    await raw.put('device', device)
    await raw.put(sessionName, broken)
    const before = structuredClone(raw.records)
    await assert.rejects(
      store.migrate(),
      (error: Error) =>
        !error.message.includes(session.session.accessJwt) &&
        !error.message.includes(session.fingerprint),
    )
    assert.deepEqual(raw.records, before)
  }
})

test('resumes a migration interrupted between records without replacing the first ciphertext', async () => {
  const raw = storage()
  await raw.put('device', device)
  await raw.put(sessionName, session)
  const io = new Error('storage unavailable')
  const interrupted = new CredentialStore(
    {
      get: raw.get,
      async put(name, value) {
        if (name === sessionName) throw io
        await raw.put(name, value)
      },
    },
    key,
  )
  await assert.rejects(interrupted.migrate(), (error) => error === io)
  const done = structuredClone(raw.records.get('device'))
  assert.notDeepEqual(done, device)
  assert.deepEqual(raw.records.get(sessionName), session)
  const restarted = new CredentialStore(raw, key)
  await restarted.migrate()
  assert.deepEqual(raw.records.get('device'), done)
  assert.deepEqual(await restarted.get(sessionName), session)
})
