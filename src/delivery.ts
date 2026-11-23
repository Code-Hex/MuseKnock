import { z } from 'zod'
import { identifier } from './identifiers.ts'

const event = z.object({
  id: z.uuid(),
  source: z.string().regex(identifier),
  type: z.string().regex(identifier),
  text: z.string().min(1),
})

export const claimSchema = event.extend({ attempt: z.uuid() })
export const completion = z.strictObject({
  id: z.uuid(),
  attempt: z.uuid(),
  outcome: z.enum(['sent', 'unknown', 'not_sent']),
})

export type Delivery = z.infer<typeof event>
export type Claim = z.infer<typeof claimSchema>
export type Outcome = z.infer<typeof completion>['outcome']
