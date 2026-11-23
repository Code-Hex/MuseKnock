import { z } from 'zod'

export const sideChatId = /^[a-zA-Z0-9-]{1,64}$/
export const museDeviceSchema = z.object({
  nodeId: z.string().regex(/^[a-z]+-[0-9a-f]{6}$/),
  sdkToken: z.string().regex(/^mgst_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  refreshToken: z.string().regex(/^(?:hatch_refresh:)?[A-Za-z0-9._~+/=-]+$/),
  vmId: z.string().min(1).optional(),
})
export type MuseDevice = z.infer<typeof museDeviceSchema>
