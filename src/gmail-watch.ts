import { z } from 'zod'
import type { BatchResult } from './delivery.ts'

const settings = z.object({
  GMAIL_ACCOUNT: z.email().toLowerCase(),
  GMAIL_TOPIC: z.string().regex(/^projects\/[\w.-]+\/topics\/[\w.~+%-]+$/),
  GMAIL_CLIENT_ID: z.string().min(1),
  GMAIL_CLIENT_SECRET: z.string().min(1),
  GMAIL_REFRESH_TOKEN: z.string().min(1),
  GMAIL_LABEL_ID: z.string().trim().min(1).max(256).default('INBOX'),
  GMAIL_INCLUDE_BODY: z.enum(['true', 'false']).default('false'),
  GMAIL_MAX_BYTES: z
    .string()
    .regex(/^\d+$/)
    .default('20000')
    .transform(Number)
    .pipe(z.number().int().min(1).max(20_000)),
})

export type GmailBindings = Partial<Record<keyof z.input<typeof settings>, string>>
type Config = z.output<typeof settings>
export type GmailWatchState = {
  account: string
  topic: string
  labelId: string
  historyId: string
  watchRenewedAt: number
  watchExpiresAt: number
  lastSyncAt: number
  lastGapAt?: number
  page?: { start: string; token: string }
  partial?: { recordId: string; offset: number }
}
export class GmailSyncError extends Error {}
type Event = { key: string; type: string; text: string }
type Transport = (url: URL, init: RequestInit) => Promise<Response>
type RequestGmail = (resource: string, query?: URLSearchParams, body?: object) => Promise<Response>
const historyId = z.string().regex(/^\d{1,20}$/)
const messageId = z.string().regex(/^[\w-]{1,256}$/)
const historyPage = z.object({
  historyId,
  nextPageToken: z.string().min(1).max(8192).optional(),
  history: z
    .array(
      z.object({
        id: historyId,
        messagesAdded: z.array(z.object({ message: z.object({ id: messageId }) })).optional(),
      }),
    )
    .default([]),
})
const headers = z.array(z.object({ name: z.string(), value: z.string() })).optional()
const message = z.object({
  id: messageId,
  threadId: messageId.optional(),
  internalDate: z.string().optional(),
  labelIds: z.array(z.string()).default([]),
  payload: z.object({ headers }).passthrough().optional(),
})
const utf8 = new TextEncoder()
const decoder = new TextDecoder()
const maxResponseBytes = 1024 * 1024
class ResponseTooLarge extends GmailSyncError {}

export function gmailConfigured(env: GmailBindings): boolean {
  return settings.safeParse(env).success
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new GmailSyncError('Gmail returned HTTP ' + response.status)
  const reader = response.body?.getReader()
  if (!reader) throw new GmailSyncError('Gmail returned an empty response')
  const chunks = []
  let length = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maxResponseBytes) {
      await reader.cancel()
      throw new ResponseTooLarge('Gmail response exceeds the size limit')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(decoder.decode(bytes))
}

async function connect(config: Config, transport: Transport): Promise<RequestGmail> {
  const token = await transport(new URL('https://oauth2.googleapis.com/token'), {
    redirect: 'manual',
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.GMAIL_CLIENT_ID,
      client_secret: config.GMAIL_CLIENT_SECRET,
      refresh_token: config.GMAIL_REFRESH_TOKEN,
    }),
  })
  const { access_token } = z
    .object({ access_token: z.string().min(1) })
    .parse(await readJson(token))
  const request: RequestGmail = (resource, query, body) => {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/' + resource)
    if (query) url.search = query.toString()
    return transport(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + access_token,
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    })
  }
  const profile = await request('profile', new URLSearchParams({ fields: 'emailAddress' }))
  const { emailAddress } = z.object({ emailAddress: z.email() }).parse(await readJson(profile))
  if (emailAddress.toLowerCase() !== config.GMAIL_ACCOUNT)
    throw new GmailSyncError('Gmail account does not match the authorized mailbox')
  return request
}

async function register(config: Config, request: RequestGmail): Promise<GmailWatchState> {
  const response = await request('watch', undefined, {
    topicName: config.GMAIL_TOPIC,
    labelIds: [config.GMAIL_LABEL_ID],
    labelFilterBehavior: 'include',
  })
  const watch = z
    .object({ historyId, expiration: z.string().regex(/^\d{1,16}$/) })
    .parse(await readJson(response))
  const now = Date.now()
  const expires = Number(watch.expiration)
  if (!Number.isSafeInteger(expires) || expires <= now)
    throw new GmailSyncError('Gmail returned an expired watch')
  return {
    account: config.GMAIL_ACCOUNT,
    topic: config.GMAIL_TOPIC,
    labelId: config.GMAIL_LABEL_ID,
    historyId: watch.historyId,
    watchExpiresAt: expires,
    watchRenewedAt: now,
    lastSyncAt: now,
  }
}

const partSchema = z.object({
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  headers,
  body: z.object({ data: z.string().optional(), attachmentId: z.string().optional() }).optional(),
  parts: z.array(z.unknown()).optional(),
})

function plainBody(
  value: unknown,
  maxBytes: number,
  depth = 0,
): { body: string; bodyTruncated: boolean } | undefined {
  if (depth > 16) return
  const part = partSchema.parse(value)
  if (
    part.filename ||
    part.body?.attachmentId ||
    part.headers?.some(
      (h) =>
        h.name.toLowerCase() === 'content-disposition' && /^attachment\b/i.test(h.value.trim()),
    )
  )
    return
  if (part.mimeType === 'text/plain' && part.body?.data) {
    const base64 = part.body.data.replace(/-/g, '+').replace(/_/g, '/')
    // Bound decoding even when a single MIME part occupies the entire response.
    const prefix = base64.slice(0, 4 * Math.ceil((maxBytes + 1) / 3))
    const bytes = Uint8Array.from(atob(prefix), (c) => c.charCodeAt(0))
    const contentType = part.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value
    const charset = /charset=["']?([^"'\s;]+)/i.exec(contentType ?? '')?.[1]
    let textDecoder: TextDecoder
    try {
      textDecoder = new TextDecoder(charset)
    } catch {
      textDecoder = new TextDecoder()
    }
    const truncated = bytes.length > maxBytes || prefix.length < base64.length
    const decoded = textDecoder.decode(bytes.subarray(0, maxBytes), { stream: truncated })
    return {
      body: clipText(decoded, maxBytes),
      bodyTruncated: truncated || utf8.encode(decoded).length > maxBytes,
    }
  }
  if (!part.mimeType?.startsWith('multipart/')) return
  for (const child of part.parts ?? []) {
    const found = plainBody(child, maxBytes, depth + 1)
    if (found) return found
  }
}

function clipText(value: string, maxBytes: number) {
  const bytes = utf8.encode(value)
  return bytes.length <= maxBytes
    ? value
    : new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true })
}

async function mailEvent(
  request: RequestGmail,
  config: Config,
  id: string,
): Promise<Event | undefined> {
  const metadata = new URLSearchParams({
    format: 'metadata',
    fields: 'id,threadId,internalDate,labelIds,payload/headers',
  })
  for (const header of ['Subject', 'From', 'To', 'Date']) metadata.append('metadataHeaders', header)
  const includeBody = config.GMAIL_INCLUDE_BODY === 'true'
  const resource = 'messages/' + encodeURIComponent(id)
  const query = includeBody
    ? new URLSearchParams({ format: 'full', fields: 'id,threadId,internalDate,labelIds,payload' })
    : metadata
  const fetchMessage = async (params: URLSearchParams) => {
    const response = await request(resource, params)
    return response.status === 404 ? undefined : message.parse(await readJson(response))
  }
  let skippedBody = false
  let mail
  try {
    mail = await fetchMessage(query)
  } catch (error) {
    if (!includeBody || !(error instanceof ResponseTooLarge)) throw error
    mail = await fetchMessage(metadata)
    skippedBody = true
  }
  if (!mail || !mail.labelIds.includes(config.GMAIL_LABEL_ID)) return
  if (mail.id !== id) throw new GmailSyncError('Gmail returned an unexpected message ID')
  const summary: Record<string, string | boolean | undefined> = {
    account: config.GMAIL_ACCOUNT,
    id: mail.id,
    threadId: mail.threadId,
    internalDate: mail.internalDate,
  }
  for (const h of mail.payload?.headers ?? []) {
    const name = h.name.toLowerCase()
    if (['subject', 'from', 'to', 'date'].includes(name) && !(name in summary))
      summary[name] = clipText(h.value, 512)
  }
  if (skippedBody) summary.bodyTruncated = true
  else if (includeBody && mail.payload)
    Object.assign(summary, plainBody(mail.payload, config.GMAIL_MAX_BYTES))
  // Control characters and quotes expand when JSON-encoded. Keep the inbox event within its limit.
  while (
    typeof summary.body === 'string' &&
    utf8.encode(JSON.stringify(summary)).length > 32 * 1024
  ) {
    summary.body = clipText(summary.body, Math.floor(utf8.encode(summary.body).length * 0.75))
    summary.bodyTruncated = true
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    utf8.encode(config.GMAIL_ACCOUNT + '\0' + mail.id),
  )
  const key = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return { key, type: 'message', text: JSON.stringify(summary) }
}

type Persist = (state: GmailWatchState) => Promise<void>
type Enqueue = (events: Event[]) => Promise<BatchResult>

async function advance(
  config: Config,
  state: GmailWatchState,
  request: RequestGmail,
  persist: Persist,
  enqueue: Enqueue,
) {
  const start = state.page?.start ?? state.historyId
  const query = new URLSearchParams({
    startHistoryId: start,
    labelId: state.labelId,
    historyTypes: 'messageAdded',
    maxResults: '10',
    fields: 'historyId,nextPageToken,history(id,messagesAdded/message/id)',
  })
  if (state.page) query.set('pageToken', state.page.token)
  const response = await request('history', query)
  if (state.page && [400, 404].includes(response.status)) {
    const { page: _, ...resume } = state
    await persist(resume)
    return
  }
  if (response.status === 404) {
    const baseline = await register(config, request)
    await persist({ ...baseline, lastGapAt: baseline.watchRenewedAt })
    return
  }
  const page = historyPage.parse(await readJson(response))
  const events = new Map<string, Event>()
  const progress = { ...state }
  const save = async () => {
    if (events.size) {
      const result = await enqueue([...events.values()])
      if (result !== 'accepted') throw new GmailSyncError('Gmail delivery deferred: ' + result)
    }
    await persist({ ...progress, lastSyncAt: Date.now() })
  }
  let remaining = 10
  for (const record of page.history) {
    if (BigInt(record.id) <= BigInt(progress.historyId)) continue
    const additions = record.messagesAdded ?? []
    const offset = progress.partial?.recordId === record.id ? progress.partial.offset : 0
    for (let i = offset; i < additions.length; i++) {
      if (remaining === 0) {
        await save()
        return
      }
      let event
      try {
        event = await mailEvent(request, config, additions[i].message.id)
      } catch (error) {
        if (remaining < 10) await save()
        throw error
      }
      if (event) events.set(event.key, event)
      progress.partial = { recordId: record.id, offset: i + 1 }
      remaining--
    }
    progress.historyId = record.id
    delete progress.partial
  }
  if (page.nextPageToken) progress.page = { start, token: page.nextPageToken }
  else {
    delete progress.page
    if (BigInt(page.historyId) > BigInt(progress.historyId)) progress.historyId = page.historyId
  }
  await save()
}

export async function syncGmail(
  env: GmailBindings,
  saved: GmailWatchState | undefined,
  persist: Persist,
  enqueue: Enqueue,
  transport: Transport = fetch,
): Promise<void> {
  try {
    const result = settings.safeParse(env)
    if (!result.success) throw new GmailSyncError('Invalid Gmail watch configuration')
    const config = result.data
    const request = await connect(config, transport)
    if (
      !saved ||
      saved.account !== config.GMAIL_ACCOUNT ||
      saved.topic !== config.GMAIL_TOPIC ||
      saved.labelId !== config.GMAIL_LABEL_ID
    ) {
      await persist(await register(config, request))
      return
    }
    let state = saved
    const now = Date.now()
    if (now - state.watchRenewedAt >= 86_400_000 || state.watchExpiresAt - now <= 3_600_000) {
      const { watchExpiresAt, watchRenewedAt } = await register(config, request)
      state = { ...state, watchExpiresAt, watchRenewedAt }
      await persist(state)
    }
    await advance(config, state, request, persist, enqueue)
  } catch (error) {
    if (error instanceof GmailSyncError) throw error
    throw new GmailSyncError('Gmail sync failed while reading or saving mailbox changes')
  }
}
