import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { identifier } from '../identifiers.ts'
import { parseJson, verifyHmac, type ProviderDelivery } from '../provider.ts'
import type { WorkerEnv } from '../webhook.ts'

const envelope = z.object({ type: z.string().min(1) })
const verification = z.object({ challenge: z.string().min(1) })
const entity = z.union([z.string(), z.object({ id: z.string(), name: z.string().optional() })])
const eventCallback = z.object({
  event_id: z.string().regex(/^[!-~]{1,128}$/),
  team_id: z.string().optional(),
  event: z.object({
    type: z.string().regex(identifier),
    subtype: z.string().optional(),
    channel: entity.optional().catch(undefined),
    user: entity.optional().catch(undefined),
    text: z.string().optional(),
    reaction: z.string().optional(),
    message: z.object({ text: z.string().optional() }).optional().catch(undefined),
  }),
})

export async function slack(
  request: Request,
  env: WorkerEnv['Bindings'],
): Promise<ProviderDelivery> {
  const secret = env.SLACK_SIGNING_SECRET
  if (!secret) throw new HTTPException(503, { message: 'Configure SLACK_SIGNING_SECRET first' })
  const timestamp = request.headers.get('X-Slack-Request-Timestamp') ?? ''
  const signature = /^v0=([0-9a-f]{64})$/.exec(request.headers.get('X-Slack-Signature') ?? '')
  if (
    !signature ||
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300
  ) {
    throw new HTTPException(401, { message: 'Invalid Slack signature or timestamp' })
  }

  const body = await request.arrayBuffer()
  const prefix = new TextEncoder().encode('v0:' + timestamp + ':')
  const signed = new Uint8Array(prefix.length + body.byteLength)
  signed.set(prefix)
  signed.set(new Uint8Array(body), prefix.length)
  const digest = Uint8Array.from({ length: 32 }, (_, i) =>
    Number.parseInt(signature[1].slice(2 * i, 2 * i + 2), 16),
  )
  if (!(await verifyHmac('SHA-256', secret, signed, digest))) {
    throw new HTTPException(401, { message: 'Invalid Slack signature' })
  }

  const json = parseJson(body)
  const outer = envelope.safeParse(json)
  if (!outer.success) throw new HTTPException(400, { message: 'Invalid Slack envelope' })
  if (outer.data.type === 'url_verification') {
    const check = verification.safeParse(json)
    if (!check.success) throw new HTTPException(400, { message: 'Missing Slack challenge' })
    return { response: new Response(check.data.challenge) }
  }
  const response = new Response(null)
  if (outer.data.type !== 'event_callback') return { response }
  const parsed = eventCallback.safeParse(json)
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid Slack event callback' })
  const { event_id, team_id, event } = parsed.data
  return {
    events: [{ key: event_id, type: event.type, text: JSON.stringify({ team_id, ...event }) }],
    response,
  }
}
