import { z } from 'zod'
import { museDeviceSchema, type MuseDevice } from './muse-device.ts'

const api = 'https://api.muse.ai'
const noiseHost = 'hatch.metaaivm.com'
const refreshAfterMs = 3 * 60 * 60 * 1000

const token = z.string().regex(/^[\x21-\x7e]+$/)
const { refreshToken } = museDeviceSchema.shape
const credentials = z.object({ accessToken: token, refreshToken, savedAt: z.number().finite() })
const rotated = z.object({ access_token: token, refresh_token: refreshToken })
const listing = z.object({
  vm_list: z.array(z.unknown()),
  error_title: z.unknown().optional(),
  backend_error_code: z.unknown().optional(),
})
const lease = z.object({
  vm_id: z.string().nullish(),
  vm_name: z.string().nullish(),
  vm_auth_token: token,
  vm_ws_url: z.string().nullish(),
  vm_url: z.string().nullish(),
  default: z.boolean().optional(),
})

export type DeviceCredentials = z.infer<typeof credentials>
type AccountRequest = (url: string, options: RequestInit) => Promise<Response>

function accountRequest(request: AccountRequest, path: string, options: RequestInit) {
  return request(api + path, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
}

async function rotate(
  config: MuseDevice,
  previousRefresh: string,
  persist: (next: DeviceCredentials) => Promise<void>,
  request: AccountRequest,
) {
  const raw = previousRefresh.replace(/^hatch_refresh:/, '')
  const response = await accountRequest(request, '/device_token/refresh', {
    method: 'POST',
    headers: { Authorization: 'Bearer hatch_refresh:' + raw, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: config.nodeId, sdk_token: config.sdkToken }),
  })
  if (!response.ok) throw new Error('Muse device refresh failed (HTTP ' + response.status + ')')

  const data: unknown = await response.json().catch(() => null)
  const tokens = rotated.safeParse(
    data && typeof data === 'object' && 'payload' in data ? data.payload : data,
  )
  if (!tokens.success) throw new Error('Invalid Muse device refresh response')
  const next = {
    accessToken: tokens.data.access_token,
    refreshToken: tokens.data.refresh_token,
    savedAt: Date.now(),
  }
  await persist(next)
  return next
}

function fetchLeases(accessToken: string, request: AccountRequest) {
  return accountRequest(request, '/fetch_vms', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + accessToken, 'X-API-Version': '1.0.0' },
  })
}

export async function getMuseVm(
  config: MuseDevice,
  saved: DeviceCredentials | undefined,
  persist: (next: DeviceCredentials) => Promise<void>,
  request: AccountRequest = fetch,
): Promise<{ noiseHost: string; vmId: string; vmToken: string }> {
  if (!museDeviceSchema.safeParse(config).success) throw new Error('Invalid Muse device configuration')
  if (saved && !credentials.safeParse(saved).success)
    throw new Error('Invalid saved Muse device credentials')
  const age = saved ? Date.now() - saved.savedAt : 0
  const cached = saved && age >= 0 && age < refreshAfterMs ? saved : undefined
  let pair =
    cached ?? (await rotate(config, saved?.refreshToken ?? config.refreshToken, persist, request))
  let response = await fetchLeases(pair.accessToken, request)
  if (response.status === 401 && cached) {
    await response.body?.cancel()
    pair = await rotate(config, pair.refreshToken, persist, request)
    response = await fetchLeases(pair.accessToken, request)
  }
  if (!response.ok) throw new Error('Muse VM lookup failed (HTTP ' + response.status + ')')
  const result = listing.safeParse(await response.json().catch(() => null))
  if (!result.success || result.data.error_title || result.data.backend_error_code) {
    throw new Error('Invalid Muse VM lookup response')
  }

  const available = result.data.vm_list.flatMap((entry) => {
    const item = lease.safeParse(entry)
    if (!item.success || !(item.data.vm_ws_url || item.data.vm_url)) return []
    const vmId = item.data.vm_id || item.data.vm_name
    return vmId ? [{ vmId, vmToken: item.data.vm_auth_token, isDefault: item.data.default }] : []
  })
  const selected = config.vmId
    ? available.find((vm) => vm.vmId === config.vmId)
    : (available.find((vm) => vm.isDefault) ?? available[0])
  if (!selected)
    throw new Error(config.vmId ? 'No lease for the requested VM' : 'No leased Muse VM')
  return { noiseHost, vmId: selected.vmId, vmToken: selected.vmToken }
}
