import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { bearerAuth } from 'hono/bearer-auth'
import { timingSafeEqual } from 'hono/utils/buffer'
import { handleMcp } from './mcp.ts'
import { registerProvider } from './provider.ts'
import { authenticateGmailPush } from './providers/gmail.ts'
import { github } from './providers/github.ts'
import { line } from './providers/line.ts'
import { slack } from './providers/slack.ts'
import { telegram } from './providers/telegram.ts'
import { twilio } from './providers/twilio.ts'
import { wecom } from './providers/wecom.ts'
import { x } from './providers/x.ts'
import { inbox, registerWebhook, type WorkerEnv } from './webhook.ts'

export { Inbox } from './inbox.ts'

const app = new Hono<WorkerEnv>()

const matches = (token: string, secret: string | undefined) =>
  secret ? timingSafeEqual(token, secret) : false

const checkTokenRoles: MiddlewareHandler<WorkerEnv> = async (c, next) => {
  const tokens = [c.env.HOOK_TOKEN, c.env.MCP_TOKEN, c.env.MCP_ADMIN_TOKEN].filter(Boolean)
  if (new Set(tokens).size !== tokens.length) {
    return c.text('Configure distinct webhook, read-only MCP, and admin MCP tokens.', 503)
  }
  return next()
}

registerProvider(app, 'github', github)
registerProvider(app, 'line', line)
registerProvider(app, 'slack', slack)
registerProvider(app, 'telegram', telegram)
registerProvider(app, 'twilio', twilio)
registerProvider(app, 'wecom', wecom, ['GET', 'POST'])
registerProvider(app, 'x', x, ['GET', 'POST'])

app.post('/hooks/gmail', bodyLimit({ maxSize: 32 * 1024 }), async (c) => {
  await authenticateGmailPush(c.req.raw, c.env)
  const sync = await inbox(c.env).syncGmail()
  if (!sync.ok) return c.text('Gmail synchronization unavailable', 503)
  return c.body(null, 204)
})

registerWebhook(app, { slug: 'custom', source: 'default' }, [
  checkTokenRoles,
  bearerAuth({ verifyToken: (token, c) => matches(token, c.env.HOOK_TOKEN) }),
])

type McpEnv = WorkerEnv & { Variables: { canWrite: boolean } }
const mcp = new Hono<McpEnv>()
mcp.use('*', checkTokenRoles)
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

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: WorkerEnv['Bindings']) {
    if (
      env.GMAIL_ACCOUNT ||
      env.BLUESKY_DID ||
      env.BLUESKY_IDENTIFIER ||
      env.BLUESKY_APP_PASSWORD ||
      env.DISCORD_CHANNEL_ID ||
      env.DISCORD_BOT_TOKEN
    ) {
      await inbox(env).pollSources()
    }
  },
} satisfies ExportedHandler<WorkerEnv['Bindings']>
