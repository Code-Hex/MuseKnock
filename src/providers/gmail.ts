import { HTTPException } from 'hono/http-exception'
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const pushSettings = z.object({
  GMAIL_PUSH_AUDIENCE: z.url({ protocol: /^https$/ }),
  GMAIL_PUSH_SERVICE_ACCOUNT: z.email().endsWith('.gserviceaccount.com'),
  GMAIL_SUBSCRIPTION: z.string().regex(/^projects\/[^/\s]+\/subscriptions\/[^/\s]+$/),
  GMAIL_ACCOUNT: z.email(),
})
const wrappedMessage = z.object({
  subscription: z.string(),
  message: z.object({ data: z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/) }),
})
const notification = z.object({
  emailAddress: z.email(),
  historyId: z.union([z.string().regex(/^[0-9]{1,20}$/), z.number().int().nonnegative()]),
})

const getGoogleKey: JWTVerifyGetKey = async (header, jwt) => {
  if (typeof header.kid !== 'string' || !/^[\w-]{1,128}$/.test(header.kid))
    throw new HTTPException(401)
  try {
    return await googleKeys(header, jwt)
  } catch (error) {
    if (error instanceof errors.JWKSNoMatchingKey) throw new HTTPException(401)
    throw new HTTPException(503, { message: 'Google signing keys unavailable' })
  }
}

export type GmailPushBindings = Partial<z.infer<typeof pushSettings>>

export function gmailPushConfigured(env: GmailPushBindings) {
  return pushSettings.safeParse(env).success
}

export async function authenticateGmailPush(
  request: Request,
  env: GmailPushBindings,
): Promise<void> {
  const settings = pushSettings.safeParse(env)
  if (!settings.success) throw new HTTPException(503, { message: 'Configure Gmail push delivery' })
  const { GMAIL_PUSH_AUDIENCE, GMAIL_PUSH_SERVICE_ACCOUNT, GMAIL_SUBSCRIPTION, GMAIL_ACCOUNT } =
    settings.data
  const token = /^Bearer (\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1]
  if (!token) throw new HTTPException(401)

  try {
    const { payload } = await jwtVerify(token, getGoogleKey, {
      algorithms: ['RS256'],
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: GMAIL_PUSH_AUDIENCE,
      maxTokenAge: 3600,
      requiredClaims: ['exp'],
    })
    if (
      payload.aud !== GMAIL_PUSH_AUDIENCE ||
      payload.email !== GMAIL_PUSH_SERVICE_ACCOUNT ||
      payload.email_verified !== true
    ) {
      throw new HTTPException(401)
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error
    throw new HTTPException(401)
  }

  const envelope = wrappedMessage.safeParse(await request.json().catch(() => null))
  if (!envelope.success) throw new HTTPException(400, { message: 'Invalid Pub/Sub envelope' })
  if (envelope.data.subscription !== GMAIL_SUBSCRIPTION) throw new HTTPException(403)
  let data: z.infer<typeof notification>
  try {
    const encoded = envelope.data.message.data.replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    data = notification.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch {
    throw new HTTPException(400, { message: 'Invalid Gmail notification' })
  }
  if (data.emailAddress.toLowerCase() !== GMAIL_ACCOUNT.toLowerCase()) throw new HTTPException(403)
}
