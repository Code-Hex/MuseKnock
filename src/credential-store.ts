import { z } from 'zod'
import { museDeviceSchema } from './muse-device.ts'

type Storage = {
  get<T>(name: string): Promise<T | undefined>
  put<T>(name: string, value: T): Promise<void>
}

const records = ['device', 'bluesky-notifications.session'] as const
type RecordName = (typeof records)[number]
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/)
const token = z.string().regex(/^[!-~]+$/)
const schemas = {
  device: z.strictObject({
    fingerprint,
    credentials: z.strictObject({
      accessToken: token,
      refreshToken: museDeviceSchema.shape.refreshToken,
      savedAt: z.number().finite(),
    }),
  }),
  'bluesky-notifications.session': z.strictObject({
    fingerprint,
    session: z.strictObject({
      did: z.string().startsWith('did:'),
      accessJwt: token,
      refreshJwt: token,
    }),
  }),
}
const envelope = z.strictObject({
  version: z.literal(1),
  iv: z.instanceof(ArrayBuffer).refine((value) => value.byteLength === 12),
  ciphertext: z.instanceof(ArrayBuffer).refine((value) => value.byteLength >= 16),
})
const encoder = new TextEncoder()

export class CredentialStoreError extends Error {}

function algorithm(name: RecordName, iv: ArrayBuffer) {
  return { name: 'AES-GCM', iv, additionalData: encoder.encode('MuseKnock:credentials:v1:' + name) }
}

export class CredentialStore {
  private key?: Promise<CryptoKey>
  constructor(
    private readonly storage: Storage,
    private readonly secret: string | undefined,
  ) {}

  private encryptionKey() {
    if (!this.secret || this.secret.length !== 64 || !/^[0-9a-f]{64}$/i.test(this.secret)) {
      throw new CredentialStoreError('Set CREDENTIAL_ENCRYPTION_KEY to 64 hexadecimal characters')
    }
    this.key ??= crypto.subtle.importKey(
      'raw',
      Uint8Array.from(this.secret.match(/../g)!, (pair) => parseInt(pair, 16)),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    )
    return this.key
  }

  private async decrypt(name: RecordName, raw: unknown, key: CryptoKey) {
    const sealed = envelope.safeParse(raw)
    if (!sealed.success)
      throw new CredentialStoreError('Invalid encrypted credential record: ' + name)
    const { iv, ciphertext } = sealed.data
    try {
      const bytes = await crypto.subtle.decrypt(algorithm(name, iv), key, ciphertext)
      return schemas[name].parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      )
    } catch {
      throw new CredentialStoreError(
        'Cannot open credential record ' +
          name +
          '. Check CREDENTIAL_ENCRYPTION_KEY and storage integrity.',
      )
    }
  }

  async get<K extends RecordName>(name: K): Promise<z.infer<(typeof schemas)[K]> | undefined> {
    const key = await this.encryptionKey()
    const value = await this.storage.get<unknown>(name)
    if (value === undefined) return undefined
    return (await this.decrypt(name, value, key)) as z.infer<(typeof schemas)[K]>
  }

  async put(name: RecordName, value: unknown) {
    const key = await this.encryptionKey()
    const parsed = schemas[name].safeParse(value)
    if (!parsed.success) throw new CredentialStoreError('Invalid credential record: ' + name)
    const iv = crypto.getRandomValues(new Uint8Array(12)).buffer
    const ciphertext = await crypto.subtle.encrypt(
      algorithm(name, iv),
      key,
      encoder.encode(JSON.stringify(parsed.data)),
    )
    await this.storage.put(name, { version: 1, iv, ciphertext })
  }

  async migrate() {
    const key = await this.encryptionKey()
    const legacy: { name: RecordName; value: unknown }[] = []
    for (const name of records) {
      const raw = await this.storage.get<unknown>(name)
      if (raw === undefined) continue
      const record = schemas[name].safeParse(raw)
      if (record.success) legacy.push({ name, value: record.data })
      else await this.decrypt(name, raw, key)
    }
    // Verify existing ciphertext with the configured key before migrating any remaining plaintext.
    for (const { name, value } of legacy) await this.put(name, value)
  }
}
