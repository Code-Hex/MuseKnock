import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { museDeviceSchema } from './muse-device.ts'
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
    return c.text('Use distinct tokens for Telegram, the custom webhook and each MCP role.', 503)
  }
  return next()
}

registerProvider(app, 'github', github)
registerProvider(app, 'line', line)
registerProvider(app, 'slack', slack)
app.use('/v1/hooks/telegram', checkTokenRoles)
registerProvider(app, 'telegram', telegram)
registerProvider(app, 'twilio', twilio)
registerProvider(app, 'wecom', wecom, ['GET', 'POST'])
registerProvider(app, 'x', x, ['GET', 'POST'])

registerWebhook(app, 'custom', [
  checkTokenRoles,
  bearerAuth({ verifyToken: (token, c) => matches(token, c.env.HOOK_TOKEN) }),
])

const pairingInput = museDeviceSchema.omit({ access: true }).extend({
  replaces: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict()
const setup = new Hono<WorkerEnv>()
setup.use('*', checkTokenRoles, bearerAuth<WorkerEnv>({ verifyToken: (token, c) => matches(token, c.env.MCP_ADMIN_TOKEN) }))
setup.post('/', bodyLimit({ maxSize: 32 * 1024 }), async (c) => {
  const data = pairingInput.safeParse(await c.req.json().catch(() => null))
  if (!data.success) return c.text('Invalid pairing.', 400)
  const { replaces, ...device } = data.data
  const result = await inbox(c.env).importPairing(device, replaces)
  if (result === 'rejected') return c.text('Muse rejected the device credentials. Authorize again.', 422)
  if (result === 'upstream_unavailable') return c.text('Muse credential verification is unavailable. Retry.', 503)
  if (result === 'wrong_node') return c.text('Use the node ID provided by this Worker.', 409)
  if (result === 'already_paired') return c.text('This Worker already has a pairing.', 409)
  if (result === 'unavailable') return c.text('Credential storage unavailable. Retry and check the Worker encryption key if the problem persists.', 503)
  return c.body(null, 204)
})
app.route('/v1/setup/pairing', setup)

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
