export type Delivery = { id: string; source: string; type: string; text: string }
export type Claim = Delivery & { attempt: string }
export type Outcome = 'sent' | 'unknown' | 'not_sent'
