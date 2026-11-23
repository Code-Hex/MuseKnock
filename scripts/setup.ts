import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { parseArgs, parseEnv } from 'node:util'
import { z } from 'zod'
import { museDeviceSchema, sideChatId } from '../src/muse-device.ts'

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
function updateEnv(raw: string, changes: Record<string, string | undefined>) {
  let updated = raw
  const expected = parseEnv(raw)
  for (const [key, value] of Object.entries(changes)) {
    if (expected[key] === value) continue
    const line = new RegExp(
      '^[ \\t]*(?:export[ \\t]+)?' + key + '[ \\t]*=[^\\r\\n]*(?:\\r?\\n|$)',
      'gm',
    )
    updated = updated.replace(line, '')
    if (value === undefined) delete expected[key]
    else {
      expected[key] = value
      if (updated && !updated.endsWith('\n')) updated += '\n'
      updated += key + '=' + value + '\n'
    }
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
    for (const name of ['HOOK_TOKEN', 'MCP_TOKEN', 'MCP_ADMIN_TOKEN']) {
      const value = current[name] || randomBytes(32).toString('hex')
      if (!/^[A-Za-z0-9._~-]+$/.test(value)) throw new Error('Invalid token in ' + name)
      tokens[name] = value
    }
    if (new Set(Object.values(tokens)).size !== 3)
      throw new Error('Use distinct webhook and MCP tokens.')
    const legacy = current.MUSE_SESSION_ID
      ? undefined
      : parseEnv(await readOptional('.env.bridge')).MUSE_SESSION_ID
    const room = current.MUSE_SESSION_ID || legacy || undefined
    if (room && !sideChatId.test(room))
      throw new Error('Invalid MUSE_SESSION_ID. Use 1 to 64 letters, digits or hyphens.')
    const changes = {
      ...tokens,
      BRIDGE_TOKEN: undefined,
      MUSE_SESSION_ID: room,
      MUSE_NODE_ID: current.MUSE_NODE_ID ?? '',
      MUSE_SDK_TOKEN: current.MUSE_SDK_TOKEN ?? '',
      MUSE_REFRESH_TOKEN: current.MUSE_REFRESH_TOKEN ?? '',
      ...imported,
    }
    const contents = updateEnv(raw, changes)
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
    'Worker settings saved to .dev.vars. Complete any empty Muse device settings before deployment.',
  )
}

setup().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Setup failed.')
  process.exitCode = 1
})
