import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { bodyLimit } from 'hono/body-limit'
import { timingSafeEqual } from 'hono/utils/buffer'
import { completion } from './delivery.ts'
import { handleMcp } from './mcp.ts'
import { inbox, registerWebhook, type WorkerEnv } from './webhook.ts'

export { Inbox } from './store.ts'

const app = new Hono<WorkerEnv>()
const matches = (token: string, secret: string | undefined) =>
  secret ? timingSafeEqual(token, secret) : false

registerWebhook(app, 'default', [
  bearerAuth({ verifyToken: (token, c) => matches(token, c.env.HOOK_TOKEN) }),
])

app.use(
  '/bridge/*',
  bearerAuth<WorkerEnv>({ verifyToken: (token, c) => matches(token, c.env.BRIDGE_TOKEN) }),
)

app.post('/bridge/claim', async (c) => {
  const event = await inbox(c.env).claim()
  return event ? c.json(event) : c.body(null, 204)
})

app.post('/bridge/finish', bodyLimit({ maxSize: 1024 }), async (c) => {
  const parsed = completion.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.text('Invalid delivery result', 400)
  const { id, attempt, outcome } = parsed.data
  const accepted = await inbox(c.env).finish(id, attempt, outcome)
  return accepted ? c.body(null, 204) : c.text('No matching delivery', 409)
})

type McpEnv = WorkerEnv & { Variables: { canWrite: boolean } }
const mcp = new Hono<McpEnv>()
mcp.use(
  '*',
  bearerAuth<McpEnv>({
    verifyToken: async (token, c) => {
      const canWrite = await matches(token, c.env.MCP_ADMIN_TOKEN)
      c.set('canWrite', canWrite)
      return canWrite || (await matches(token, c.env.MCP_TOKEN))
    },
  }),
)
mcp.all('/', (c) => handleMcp(c.req.raw, inbox(c.env), c.get('canWrite')))
app.route('/mcp', mcp)

export default app
