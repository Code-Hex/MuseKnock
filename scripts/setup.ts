import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'

async function createPrivate(path: string, contents: string) {
  try {
    await writeFile(path, contents, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

const names = ['HOOK_TOKEN', 'BRIDGE_TOKEN', 'MCP_TOKEN', 'MCP_ADMIN_TOKEN']
const secrets = names.map((name) => name + '=' + randomBytes(32).toString('hex'))
await createPrivate('.dev.vars', secrets.join('\n') + '\n')
const existing = parseEnv(await readFile('.dev.vars', 'utf8'))
if (
  names.some((name) => !/^[A-Za-z0-9._~-]+$/.test(existing[name] ?? '')) ||
  new Set(names.map((name) => existing[name])).size !== names.length
) {
  throw new Error('.dev.vars の4つのトークンには異なる英数字の値を設定してください。')
}
await createPrivate(
  '.env.bridge',
  [
    'WORKER_URL=http://127.0.0.1:8787',
    'BRIDGE_TOKEN=' + existing.BRIDGE_TOKEN,
    'MUSE_SESSION_ID=' + randomUUID(),
    '',
  ].join('\n'),
)
console.log(
  '設定ファイルを確認しました。Worker は .dev.vars、配信ブリッジは .env.bridge を使います。',
)
