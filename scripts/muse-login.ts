import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { museDeviceSchema } from '../src/muse-device.ts'

type Prompt = (label: string, hidden?: boolean) => Promise<string>
const loginOrigin = 'https://hatch-api.meta.ai/hatch/auth/'
const nonempty = z.string().min(1)
const passwordRequired = z.object({ registration_state: z.literal('password_required') })
const challenge = z.object({
  checkpoint_required: z.boolean().optional(),
  requires_birthday: z.boolean().optional(),
  requires_consent: z.boolean().optional(),
  requires_name: z.boolean().optional(),
  account_selection_required: z.boolean().optional(),
  selection_state: nonempty.optional(),
  accounts: z.array(z.object({
    account_ref: nonempty,
    profiles: z.array(z.object({ display_name: z.string().optional() })).optional(),
  })).optional(),
  two_factor_required: z.boolean().optional(),
  two_factor_state: nonempty.optional(),
  two_factor_methods: z.array(z.object({
    method_id: nonempty, method_type: z.string().optional(), label: z.string().optional(),
  })).optional(),
  abra_access_token: nonempty.optional(),
  abra_user_id: nonempty.optional(),
})

function otpRejectionHint(status: number, body: Awaited<ReturnType<Response['json']>>) {
  if (status === 429) return ' Muse reported a rate limit.'
  const error = body?.error
  // Provider messages can contain the contact, a token or a verification code.
  const text = [error?.message, error?.error_user_msg, error?.error_user_title, error?.type,
    error, body?.message, body?.detail, body?.error_message, body?.error_type, body?.error_title, body?.error_description]
    .filter((value): value is string => typeof value === 'string')
    .join(' ').replace(/_/g, ' ')
  if (/too many (requests|attempts)|rate limit|throttl/i.test(text)) return ' Muse reported a rate limit.'
  if (/unsupported (region|country)|not (available|supported) in (your|this) (region|country)/i.test(text))
    return ' Muse reported a region restriction.'
  if (/checkpoint|additional verification required/i.test(text)) return ' Complete the account check in Muse.'
  if (/invalid (phone|email|contact)|not a valid (phone|email)/i.test(text))
    return ' Muse rejected the contact information.'
  if (/missing (required )?(field|parameter)|required (field|parameter)|invalid parameter/i.test(text))
    return ' Muse reported a request parameter error.'
  return body === null ? ' No JSON error detail was available.' : ' No recognized reason in the JSON response.'
}

async function pick<T>(choices: T[], label: (choice: T) => string, prompt: Prompt) {
  if (!choices.length) throw new Error('Muse returned no sign-in options.')
  const menu = choices.map((choice, i) => (i + 1) + '. ' + label(choice).replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, '')).join('\n')
  const number = Number(await prompt(menu + '\nChoose a number: '))
  if (!Number.isInteger(number) || number < 1 || number > choices.length) throw new Error('Invalid selection.')
  return choices[number - 1]
}

export async function signIn(
  nodeId: string,
  prompt: Prompt,
  signal: AbortSignal,
  { transport = fetch, region }: { transport?: typeof fetch; region?: string } = {},
) {
  if (region !== undefined && !/^[A-Za-z]{2}$/.test(region))
    throw new Error('Use the two-letter country code for your phone number with --region.')
  const sdkToken = await prompt('Muse Gadget SDK token: ', true)
  if (!museDeviceSchema.shape.sdkToken.safeParse(sdkToken).success) throw new Error('Invalid SDK token format.')
  const contact = await prompt(region ? 'Muse phone number (national or international format): ' : 'Muse account email or international phone number: ')
  if (region !== undefined && !/^(?:[0-9]{6,15}|\+[1-9][0-9]{5,14})$/.test(contact))
    throw new Error('Enter your phone number in digits, optionally starting with + for international format.')
  const flow = { device_id: randomUUID(), waterfall_id: randomUUID() }

  async function post(url: string, fields: Record<string, unknown>, bearer?: string) {
    signal.throwIfAborted()
    const headers = new Headers({ 'Content-Type': 'application/json', 'X-API-Version': '1.0.0' })
    if (bearer) headers.set('Authorization', 'Bearer ' + bearer)
    const res = await transport(url, {
      method: 'POST', headers, body: JSON.stringify(fields), redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    const body = await res.json().catch(() => {
      if (res.ok) throw new Error('Muse returned an unreadable authentication response.')
      return null
    })
    if ((res.ok || res.status === 400) && passwordRequired.safeParse(body).success)
      throw new Error('Muse requires password sign-in. This command cannot complete pairing with that sign-in method. On a Mac, run npm run authorize -- --bluetooth and authorize it in the Muse phone app.')
    if (!res.ok) {
      const hint = url === loginOrigin + 'send_otp' ? otpRejectionHint(res.status, body) : ''
      throw new Error('Muse rejected ' + new URL(url).pathname + ' (HTTP ' + res.status + ').' + hint)
    }
    return body as unknown
  }
  const { access_token: temporary } = z.object({ access_token: nonempty }).parse(await post(loginOrigin + 'start', flow))
  const next = (action: string, fields: Record<string, unknown> = {}) => post(loginOrigin + action, { ...flow, ...fields }, temporary)
  await next('login_options')
  const { auth_state } = z.object({ auth_state: nonempty }).parse(await next('send_otp', {
    contact_point: contact, region: region?.toUpperCase(),
  }))
  let response = await next('confirm_otp', {
    auth_state, otp_code: await prompt('Verification code: ', true), supports_account_selection: true,
  })
  while (true) {
    const state = challenge.parse(response)
    if (state.checkpoint_required || state.requires_birthday || state.requires_consent || state.requires_name)
      throw new Error('Complete the account check in the Muse app, then run authorization again.')
    if (state.account_selection_required && state.selection_state) {
      const account = await pick(state.accounts ?? [], a => a.profiles?.map(p => p.display_name).join(', ') || 'Account', prompt)
      response = await next('select_account', { selection_state: state.selection_state, account_ref: account.account_ref })
    } else if (state.two_factor_required && state.two_factor_state) {
      const method = await pick(state.two_factor_methods ?? [], m => m.label || m.method_type || 'Method', prompt)
      const fields = { two_factor_state: state.two_factor_state, method_id: method.method_id }
      if (method.method_type === 'SMS') await next('two_factor/send_code', fields)
      response = await next('two_factor', { ...fields, code: await prompt('Two-factor code: ', true) })
    } else if (!state.account_selection_required && !state.two_factor_required && state.abra_access_token && state.abra_user_id) {
      const raw = await post('https://api.muse.ai/device_token/mint', {
        device_id: nodeId, sdk_token: sdkToken,
      }, state.abra_access_token)
      const pair = z.object({ refresh_token: museDeviceSchema.shape.refreshToken, access_token: nonempty })
      const result = z.union([z.object({ payload: pair }).transform(r => r.payload), pair]).parse(raw)
      return { nodeId, refreshToken: result.refresh_token, sdkToken }
    } else {
      throw new Error('Muse requires an additional sign-in step. Check your account in the Muse app.')
    }
  }
}
