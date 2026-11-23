import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { beginPairing, uploadPairing } from './worker-pairing.ts'
import { pairMac } from './mac-pairing.ts'
import { signIn } from './muse-login.ts'

async function authorize() {
  const { values: { replace, region, bluetooth } } = parseArgs({
    options: { replace: { type: 'boolean', default: false }, region: { type: 'string' }, bluetooth: { type: 'boolean' } },
  })
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Open a private interactive terminal to authorize MuseKnock.')
  let hidden = false
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!hidden) process.stdout.write(chunk)
      done()
    },
  })
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 })
  const cancelled = new AbortController()
  terminal.on('SIGINT', () => terminal.close())
  terminal.on('close', () => cancelled.abort())

  async function prompt(label: string, secret = false) {
    const signal = cancelled.signal
    signal.throwIfAborted()
    hidden = secret
    if (secret) process.stdout.write(label)
    try {
      const input = (await terminal.question(secret ? '' : label, { signal })).trim()
      if (!input) throw new Error('A response is required.')
      return input
    } finally {
      if (hidden) process.stdout.write('\n')
      hidden = false
    }
  }

  try {
    const worker = new URL(await prompt('Your deployed MuseKnock Worker URL: '))
    if (worker.protocol !== 'https:' || worker.username || worker.password || worker.pathname !== '/' || worker.search || worker.hash)
      throw new Error('Enter the HTTPS origin of your own Worker.')
    const admin = await prompt('MCP_ADMIN_TOKEN for ' + worker.host + ': ', true)
    const connection = { worker, admin, signal: cancelled.signal }
    const pairing = await beginPairing(connection, replace)
    if (pairing.state === 'configured') {
      if (pairing.verification === 'rejected')
        throw new Error('Muse rejected the saved credentials. Correct the dashboard secrets or run npm run authorize -- --replace for a stored pairing.')
      console.log(pairing.verification === 'verified'
        ? 'The Worker has previously refreshed this pairing. Continue with side chat registration in Muse.'
        : 'The Worker has saved credentials. Register an existing side chat in Muse to verify them.')
      return
    }

    if (bluetooth) {
      await pairMac(pairing.nodeId, prompt, (device, lifetime) =>
        uploadPairing(connection, device, pairing.replaces, lifetime), cancelled.signal)
    } else {
      const device = await signIn(pairing.nodeId, prompt, cancelled.signal, { region })
      await uploadPairing(connection, device, pairing.replaces)
    }
    console.log('Pairing saved in your Worker. Register your existing side chat through the Muse MCP connector.')
  } finally {
    terminal.close()
  }
}
authorize().catch(error => {
  console.error(error instanceof z.ZodError ? 'The server returned an unexpected authentication response.' :
    error instanceof Error ? error.message : 'Authorization failed.')
  process.exitCode = 1
})
