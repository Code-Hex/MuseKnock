import type { Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { identifier } from './identifiers.ts'
import { museDevice, type Inbox, type MuseBindings } from './inbox.ts'

export type WorkerEnv = {
  Bindings: MuseBindings & {
    INBOX: DurableObjectNamespace<Inbox>
    HOOK_TOKEN: string
    MCP_TOKEN: string
    MCP_ADMIN_TOKEN: string
  }
}

export function inbox(env: WorkerEnv['Bindings']) {
  return env.INBOX.getByName('personal')
}

async function decodeText(request: Request): Promise<string> {
  const media = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  const body = await request.text()
  if (media === 'application/json' || media?.endsWith('+json')) {
    try {
      JSON.parse(body)
      return body
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON' })
    }
  }
  if (media === 'application/x-www-form-urlencoded') {
    return JSON.stringify([...new URLSearchParams(body)])
  }
  if (!media || media === 'text/plain') return body
  throw new HTTPException(415, { message: 'Expected JSON, text/plain or URL-encoded form' })
}

export function registerWebhook(
  app: Hono<WorkerEnv>,
  source: string,
  middleware: [MiddlewareHandler<WorkerEnv>, ...MiddlewareHandler<WorkerEnv>[]],
  decode: (request: Request) => Promise<string> = decodeText,
) {
  if (!identifier.test(source)) throw new Error('Invalid webhook source name')
  app.post('/hooks/' + source, bodyLimit({ maxSize: 32 * 1024 }), ...middleware, async (c) => {
    if (!museDevice(c.env)) return c.text('Configure the Muse device first', 503)
    const type = c.req.header('X-Event-Type') ?? 'notification'
    const key = c.req.header('Idempotency-Key') ?? crypto.randomUUID()
    if (!identifier.test(type) || !/^[!-~]{1,128}$/.test(key)) {
      return c.text('Invalid X-Event-Type or Idempotency-Key', 400)
    }
    const text = await decode(c.req.raw)
    if (!text.trim()) return c.text('Empty event', 400)
    if (new TextEncoder().encode(text).length > 32 * 1024) return c.text('Event too large', 413)
    const receipt = await inbox(c.env).enqueue({ source, key, type, text })
    if ('noDestination' in receipt) return c.text('Register a destination side chat first', 503)
    if ('limited' in receipt) {
      c.header('Retry-After', '60')
      return c.text('Source rate limit reached', 429)
    }
    return c.json(receipt, receipt.duplicate ? 200 : 202)
  })
}
