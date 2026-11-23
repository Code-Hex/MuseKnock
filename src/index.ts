import { Hono, type MiddlewareHandler } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { timingSafeEqual } from 'hono/utils/buffer'
import { distinctBearerTokens } from './bearer-tokens.ts'
import { handleMcp, type McpRole } from './mcp.ts'
import { registerProvider } from './provider.ts'
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
  if (!distinctBearerTokens(c.env)) {
    return c.text('Configure distinct tokens for the webhook and each MCP role.', 503)
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

registerWebhook(app, 'custom', [
  checkTokenRoles,
  bearerAuth({ verifyToken: (token, c) => matches(token, c.env.HOOK_TOKEN) }),
])

type McpEnv = WorkerEnv & { Variables: { role: McpRole } }
const mcp = new Hono<McpEnv>()
mcp.use('*', checkTokenRoles)
mcp.use(
  '*',
  bearerAuth<McpEnv>({
    verifyToken: async (token, c) => {
      if (await matches(token, c.env.MCP_ADMIN_TOKEN)) c.set('role', 'admin')
      else if (await matches(token, c.env.MCP_RECOVERY_TOKEN)) c.set('role', 'recovery')
      else if (await matches(token, c.env.MCP_TOKEN)) c.set('role', 'read')
      else return false
      return true
    },
  }),
)
mcp.all('/', (c) => handleMcp(c.req.raw, inbox(c.env), c.get('role')))
app.route('/mcp', mcp)

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: WorkerEnv['Bindings']) {
    // Waking the inbox also resumes a held backlog after a configuration-only deployment.
    await inbox(env).pollSources()
  },
} satisfies ExportedHandler<WorkerEnv['Bindings']>
