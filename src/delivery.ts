export type BatchResult = 'accepted' | 'limited' | 'noDestination' | 'credentialStorageUnavailable'
export type Delivery = { id: string; source: string; type: string; text: string }
export type Claim = Delivery & { attempt: string; sessionId: string }
export type Outcome = 'sent' | 'unknown' | 'not_sent'
