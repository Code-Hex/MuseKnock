import { z } from 'zod'
import { museDeviceSchema } from './muse-device.ts'

const { nodeId, sdkToken, refreshToken } = museDeviceSchema.shape
const pairing = z.object({
  token_type: z.literal('device'),
  node_id: nodeId,
  refresh_token: refreshToken,
  noise_host: z.enum(['', 'hatch.metaaivm.com']).optional(),
  api_url_v2: z.enum(['', 'https://api.muse.ai', 'https://api.muse.ai/']).optional(),
})
const desktopState = z.object({
  sdk_token: sdkToken,
  device: z.object({ device_id: nodeId, refresh_token: refreshToken }),
})

export function importDeviceRecord(record: unknown, kind?: 'desktop' | 'pairing') {
  if (
    kind === 'desktop' ||
    (kind === undefined && typeof record === 'object' && record !== null && 'device' in record)
  ) {
    const state = desktopState.safeParse(record)
    if (!state.success)
      throw new Error(
        'Expected a Muse Desktop Bridge device ID, device refresh token, and SDK token.',
      )
    return {
      MUSE_NODE_ID: state.data.device.device_id,
      MUSE_REFRESH_TOKEN: state.data.device.refresh_token,
      MUSE_SDK_TOKEN: state.data.sdk_token,
    }
  }
  const state = pairing.safeParse(record)
  if (!state.success)
    throw new Error('Expected a production Muse device pairing with node_id and refresh_token.')
  return { MUSE_NODE_ID: state.data.node_id, MUSE_REFRESH_TOKEN: state.data.refresh_token }
}
