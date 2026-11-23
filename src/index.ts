import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { timingSafeEqual } from 'hono/utils/buffer'
import { handleMcp } from './mcp.ts'
import { inbox, registerWebhook, type WorkerEnv } from './webhook.ts'

export { Inbox } from './inbox.ts'

const app = new Hono<WorkerEnv>()
const matches = (token: string, secret: string | undefined) =>
  secret ? timingSafeEqual(token, secret) : false

registerWebhook(app, 'default', [
  bearerAuth({ verifyToken: (token, c) => matches(token, c.env.HOOK_TOKEN) }),
])

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
