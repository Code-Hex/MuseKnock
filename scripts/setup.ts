import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { parseArgs, parseEnv } from 'node:util'
import { z } from 'zod'
import { museDeviceSchema } from '../src/muse-device.ts'
import { distinctBearerTokens, localBearerTokens } from '../src/bearer-tokens.ts'

const { nodeId, sdkToken, refreshToken } = museDeviceSchema.shape
const pairing = z.object({
  token_type: z.literal('device'),
  node_id: nodeId,
  refresh_token: refreshToken,
  noise_host: z.enum(['', 'hatch.metaaivm.com']).optional(),
  api_url_v2: z.enum(['', 'https://api.muse.ai', 'https://api.muse.ai/']).optional(),
})
const desktopState = z.object({
  sdk_token: sdkToken,
  device: z.object({ device_id: nodeId, refresh_token: refreshToken }),
})

async function readOptional(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function importDevice(): Promise<Record<string, string>> {
  const { values } = parseArgs({
    options: { 'device-state': { type: 'string' }, pairing: { type: 'string' } },
  })
  const path = values['device-state'] ?? values.pairing
  if (path === undefined) return {}
  if (!path || (values['device-state'] !== undefined && values.pairing !== undefined))
    throw new Error('Specify one device state file: --device-state PATH or --pairing PATH.')
  const raw = await readFile(path, 'utf8')
  let record: unknown
  try {
    record = JSON.parse(raw)
  } catch {
    throw new Error('The supplied device state file is not valid JSON.')
  }
  if (values['device-state'] !== undefined) {
    const state = desktopState.safeParse(record)
    if (!state.success)
      throw new Error(
        'Expected a Muse Desktop Bridge device ID, device refresh token, and SDK token.',
      )
    return {
      MUSE_NODE_ID: state.data.device.device_id,
      MUSE_REFRESH_TOKEN: state.data.device.refresh_token,
      MUSE_SDK_TOKEN: state.data.sdk_token,
    }
  }
  const state = pairing.safeParse(record)
  if (!state.success)
    throw new Error('Expected a production Muse device pairing with node_id and refresh_token.')
  return { MUSE_NODE_ID: state.data.node_id, MUSE_REFRESH_TOKEN: state.data.refresh_token }
}

// Only rewrite managed assignments. Verify the parsed result before replacing a file with custom content.
function updateEnv(raw: string, changes: Record<string, string>) {
  let updated = raw
  const expected = parseEnv(raw)
  for (const [key, value] of Object.entries(changes)) {
    if (expected[key] === value) continue
    const line = new RegExp(
      '^[ \\t]*(?:export[ \\t]+)?' + key + '[ \\t]*=[^\\r\\n]*(?:\\r?\\n|$)',
      'gm',
    )
    updated = updated.replace(line, '')
    expected[key] = value
    if (updated && !updated.endsWith('\n')) updated += '\n'
    updated += key + '=' + value + '\n'
  }
  const parsed = parseEnv(updated)
  if (
    Object.keys(expected).length !== Object.keys(parsed).length ||
    Object.keys(expected).some((key) => expected[key] !== parsed[key])
  )
    throw new Error(
      'Cannot safely update this .dev.vars file. Check the quoting of its managed assignments.',
    )
  return updated
}

async function setup() {
  const imported = await importDevice()
  const filename = '.dev.vars'
  const lock = filename + '.setup.lock'
  const fd = await open(lock, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST')
      throw new Error(
        'Setup is locked. If no setup process is running, remove .dev.vars.setup.lock and retry.',
      )
    throw error
  })
  const temp = filename + '.' + randomUUID()
  try {
    const raw = await readOptional(filename)
    const current = parseEnv(raw)
    const tokens: Record<string, string> = {}
    for (const name of localBearerTokens) {
      const value = current[name] || randomBytes(32).toString('hex')
      if (!/^[A-Za-z0-9._~-]+$/.test(value)) throw new Error('Invalid token in ' + name)
      tokens[name] = value
    }
    if (current.MCP_RECOVERY_TOKEN && !/^[A-Za-z0-9._~-]+$/.test(current.MCP_RECOVERY_TOKEN))
      throw new Error('Invalid token in MCP_RECOVERY_TOKEN')
    if (!distinctBearerTokens({ ...current, ...tokens }))
      throw new Error('Use distinct webhook and MCP tokens.')
    const changes: Record<string, string> = { ...tokens, ...imported }
    if (!current.CREDENTIAL_ENCRYPTION_KEY) {
      for (const name of ['MUSE_NODE_ID', 'MUSE_SDK_TOKEN', 'MUSE_REFRESH_TOKEN']) {
        changes[name] ??= current[name] ?? ''
      }
    }
    const key = current.CREDENTIAL_ENCRYPTION_KEY || randomBytes(32).toString('hex')
    if (key.length !== 64 || !/^[0-9a-f]{64}$/i.test(key))
      throw new Error('CREDENTIAL_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters.')
    const reused = Object.entries({ ...current, ...changes }).some(
      ([name, value]) =>
        name !== 'CREDENTIAL_ENCRYPTION_KEY' && value?.toLowerCase() === key.toLowerCase(),
    )
    if (reused) throw new Error('Generate a separate key for CREDENTIAL_ENCRYPTION_KEY.')
    const contents = updateEnv(raw, { ...changes, CREDENTIAL_ENCRYPTION_KEY: key })
    if (raw !== contents) {
      await writeFile(temp, contents, { flag: 'wx', mode: 0o600 })
      await rename(temp, filename)
    } else await chmod(filename, 0o600)
  } finally {
    await rm(temp, { force: true })
    await fd.close()
    await rm(lock, { force: true })
  }
  console.log(
    'Worker settings saved to .dev.vars. For a new pairing, supply the node ID, SDK token and refresh token together.',
  )
}

setup().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Setup failed.')
  process.exitCode = 1
})
