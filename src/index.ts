import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { museDeviceSchema } from './muse-device.ts'
import { bearerAuth } from 'hono/bearer-auth'
import { timingSafeEqual } from 'hono/utils/buffer'
import { distinctBearerTokens } from './bearer-tokens.ts'
import { browserSetupHeaders, browserSetupPage } from './browser-setup-page.ts'
import { handleMcp, type McpRole } from './mcp.ts'
import { registerProvider } from './provider.ts'
import { github } from './providers/github.ts'
import { line } from './providers/line.ts'
import { slack } from './providers/slack.ts'
import { telegram } from './providers/telegram.ts'
import { twilio } from './providers/twilio.ts'
import { wecom } from './providers/wecom.ts'
import { x } from './providers/x.ts'
import { customWebhook, inbox, type WorkerEnv } from './webhook.ts'

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

app.post(
  '/v1/hooks/custom',
  bodyLimit({ maxSize: 32 * 1024 }),
  checkTokenRoles,
  bearerAuth<WorkerEnv>({ verifyToken: (token, c) => matches(token, c.env.HOOK_TOKEN) }),
  customWebhook,
)

const pairingInput = museDeviceSchema.omit({ access: true }).extend({
  replaces: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict()
const adminAuth = bearerAuth<WorkerEnv>({ verifyToken: (token, c) => matches(token, c.env.MCP_ADMIN_TOKEN) })
const setup = new Hono<WorkerEnv>()
setup.use('*', checkTokenRoles, adminAuth)
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

app.post('/v1/setup/reset', checkTokenRoles, adminAuth, async c => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  if (c.req.header('Origin') && c.req.header('Origin') !== new URL(c.req.url).origin)
    return c.text('Forbidden origin', 403)
  const result = await inbox(c.env).resetSetup()
  if (result === 'managed_by_secrets') return c.text('Remove MUSE_NODE_ID and MUSE_REFRESH_TOKEN secrets before resetting.', 409)
  if (result === 'unavailable') return c.text('Credential storage unavailable.', 503)
  return c.body(null, 204)
})

const browser = new Hono<WorkerEnv>()
browser.use('*', async (c, next) => {
  for (const [name, value] of Object.entries(browserSetupHeaders)) c.header(name, value)
  if (c.req.method === 'POST' && c.req.header('Origin') !== new URL(c.req.url).origin)
    return c.text('Forbidden origin', 403)
  return next()
})
browser.get('/:ticket', async c => {
  const view = await inbox(c.env).browserSetupTicket(c.req.param('ticket'))
  return view ? c.html(browserSetupPage(view, true)) : c.text('Setup link expired or used.', 410)
})
browser.post('/:ticket', bodyLimit({ maxSize: 4 * 1024 }), async c => {
  if (!c.req.header('Content-Type')?.startsWith('application/x-www-form-urlencoded'))
    return c.text('Expected a form submission.', 415)
  const form = await c.req.parseBody()
  const contact = typeof form.contact === 'string' ? form.contact.trim() : ''
  const region = typeof form.region === 'string' ? form.region.trim().toUpperCase() : ''
  if (!contact || contact.length > 256 || (region && !/^[A-Z]{2}$/.test(region)))
    return c.text('Invalid contact or region.', 400)
  const sessionToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
  const view = await inbox(c.env).beginBrowserSetup(c.req.param('ticket'), sessionToken, contact, region)
  if (!view) return c.text('Setup link expired or used.', 410)
  c.header('Set-Cookie', `__Host-museknock-setup=${sessionToken}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`)
  return c.redirect('/v1/setup/browser', 303)
})
const setupCookie = (request: Request) => request.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-museknock-setup=([0-9a-f]{64})(?:;|$)/)?.[1]
browser.get('/', async c => {
  const token = setupCookie(c.req.raw)
  const view = token ? await inbox(c.env).browserSetupSession(token) : null
  return view ? c.html(browserSetupPage(view)) : c.text('Setup session expired.', 410)
})
browser.post('/', bodyLimit({ maxSize: 4 * 1024 }), async c => {
  if (!c.req.header('Content-Type')?.startsWith('application/x-www-form-urlencoded'))
    return c.text('Expected a form submission.', 415)
  const token = setupCookie(c.req.raw)
  if (!token) return c.text('Setup session expired.', 410)
  const form = await c.req.parseBody()
  const action = typeof form.action === 'string' ? form.action : ''
  const value = action === 'password' ? form.password : action === 'send_code' ? '' : form.code
  if (!['password', 'otp', 'two_factor', 'send_code'].includes(action) ||
      typeof value !== 'string' || (action !== 'send_code' && !value) || value.length > 1024)
    return c.text('Invalid login step.', 400)
  const view = await inbox(c.env).advanceBrowserSetup(token, action, value)
  return view ? c.redirect('/v1/setup/browser', 303) : c.text('Setup session expired.', 410)
})
app.route('/v1/setup/browser', browser)

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
