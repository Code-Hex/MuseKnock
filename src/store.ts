import { DurableObject } from 'cloudflare:workers'

import type { Claim, Delivery, Outcome } from './delivery.ts'

type HookEvent = Omit<Delivery, 'id'> & { key: string }
type State = 'queued' | 'sending' | 'sent' | 'unknown' | 'suppressed' | 'expired'
type Receipt = { id: string; state: State; duplicate: boolean } | { limited: true }
type Status = Omit<Delivery, 'text'> & { state: State; createdAt: number }
type Rule = { source: string; paused: boolean; types: string[] }
type RuleRow = { source: string; paused: number; types: string }

const minute = 60_000
const ingressPerMinute = 10
const deliveriesPerMinute = 3
const pendingLifetime = 60 * minute
const deliveryTimeout = 2 * minute
const historyLifetime = 7 * 24 * 60 * minute

const blockedByRule = `EXISTS (
  SELECT 1 FROM rules WHERE rules.source = events.source AND (
    paused = 1 OR (json_array_length(types) > 0 AND
      NOT EXISTS (SELECT 1 FROM json_each(types) WHERE value = events.type))
  )
)`

function decodeRule(row: RuleRow): Rule {
  return { source: row.source, paused: row.paused === 1, types: JSON.parse(row.types) }
}

export class Inbox extends DurableObject<unknown> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT NOT NULL PRIMARY KEY,
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        state TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        startedAt INTEGER,
        attempt TEXT,
        outcome TEXT,
        UNIQUE (source, key)
      );
      CREATE INDEX IF NOT EXISTS arrivals ON events(source, createdAt);
      CREATE INDEX IF NOT EXISTS history ON events(createdAt);
      CREATE INDEX IF NOT EXISTS pending ON events(state, createdAt);
      CREATE TABLE IF NOT EXISTS authorizations (startedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rules (
        source TEXT NOT NULL PRIMARY KEY,
        paused INTEGER NOT NULL DEFAULT 0,
        types TEXT NOT NULL DEFAULT '[]'
      );
    `)
  }

  enqueue(event: HookEvent): Receipt {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      this.prune(now)
      const existing = this.sql
        .exec<{
          id: string
          state: State
        }>('SELECT id, state FROM events WHERE source = ? AND key = ?', event.source, event.key)
        .toArray()[0]
      if (existing) return { ...existing, duplicate: true }

      const { count } = this.sql
        .exec<{
          count: number
        }>('SELECT COUNT(*) AS count FROM events WHERE source = ? AND createdAt > ?', event.source, now - minute)
        .one()
      if (count >= ingressPerMinute) return { limited: true }

      const id = crypto.randomUUID()
      this.sql.exec(
        "INSERT INTO events(id, source, key, type, text, state, createdAt) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
        id,
        event.source,
        event.key,
        event.type,
        event.text,
        now,
      )
      this.suppressBlocked(event.source)
      const { state } = this.sql
        .exec<{ state: State }>('SELECT state FROM events WHERE id = ?', id)
        .one()
      return { id, state, duplicate: false }
    })
  }

  claim(): Claim | null {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      this.prune(now)
      this.sql.exec('DELETE FROM authorizations WHERE startedAt <= ?', now - minute)
      const { busy, recent } = this.sql
        .exec<{ busy: number; recent: number }>(
          `
        SELECT EXISTS (SELECT 1 FROM events WHERE state = 'sending') AS busy,
          (SELECT COUNT(*) FROM authorizations) AS recent
      `,
        )
        .one()
      if (busy || recent >= deliveriesPerMinute) return null

      const event = this.sql
        .exec<Delivery>(
          `
        SELECT id, source, type, text FROM events
        WHERE state = 'queued' AND NOT ${blockedByRule}
        ORDER BY createdAt, rowid LIMIT 1
      `,
        )
        .toArray()[0]
      if (!event) return null

      const attempt = crypto.randomUUID()
      this.sql.exec('INSERT INTO authorizations(startedAt) VALUES (?)', now)
      this.sql.exec(
        "UPDATE events SET state = 'sending', startedAt = ?, attempt = ?, outcome = NULL WHERE id = ?",
        now,
        attempt,
        event.id,
      )
      return { ...event, attempt }
    })
  }

  finish(id: string, attempt: string, outcome: Outcome): boolean {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      this.prune(now)
      const current = this.sql
        .exec<{ outcome: Outcome | null; retryState: State }>(
          `
        SELECT outcome, CASE
          WHEN createdAt <= ? THEN 'expired'
          WHEN ${blockedByRule} THEN 'suppressed'
          ELSE 'queued' END AS retryState
        FROM events WHERE id = ? AND attempt = ?
      `,
          now - pendingLifetime,
          id,
          attempt,
        )
        .toArray()[0]
      if (!current) return false
      if (current.outcome !== null) return current.outcome === outcome

      const state = outcome === 'not_sent' ? current.retryState : outcome
      this.sql.exec(
        `
        UPDATE events SET state = ?, outcome = ?, text = CASE WHEN ? = 'queued' THEN text ELSE '' END
        WHERE id = ?
      `,
        state,
        outcome,
        state,
        id,
      )
      return true
    })
  }

  status(id: string): Status | null {
    this.prune(Date.now())
    return (
      this.sql
        .exec<Status>('SELECT id, source, type, state, createdAt FROM events WHERE id = ?', id)
        .toArray()[0] ?? null
    )
  }

  sources(): Rule[] {
    this.prune(Date.now())
    const rows = this.sql.exec<RuleRow>(`
      SELECT source, COALESCE(paused, 0) AS paused, COALESCE(types, '[]') AS types
      FROM (SELECT source FROM events UNION SELECT source FROM rules)
      LEFT JOIN rules USING (source) ORDER BY source
    `)
    return rows.toArray().map(decodeRule)
  }

  setPaused(source: string, paused: boolean): Rule {
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO rules(source, paused) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET paused = excluded.paused',
        source,
        Number(paused),
      )
      return this.applyRule(source)
    })
  }

  setFilter(source: string, types: string[]): Rule {
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO rules(source, types) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET types = excluded.types',
        source,
        JSON.stringify([...new Set(types)]),
      )
      return this.applyRule(source)
    })
  }

  private applyRule(source: string): Rule {
    this.prune(Date.now())
    this.suppressBlocked(source)
    return decodeRule(
      this.sql
        .exec<RuleRow>('SELECT source, paused, types FROM rules WHERE source = ?', source)
        .one(),
    )
  }

  private suppressBlocked(source: string): void {
    this.sql.exec(
      `
      UPDATE events SET state = 'suppressed', text = ''
      WHERE source = ? AND state = 'queued' AND ${blockedByRule}
    `,
      source,
    )
  }

  private prune(now: number): void {
    this.sql.exec('DELETE FROM events WHERE createdAt <= ?', now - historyLifetime)
    this.sql.exec(
      "UPDATE events SET state = 'expired', text = '' WHERE state = 'queued' AND createdAt <= ?",
      now - pendingLifetime,
    )
    this.sql.exec(
      "UPDATE events SET state = 'unknown', outcome = 'unknown', text = '' WHERE state = 'sending' AND startedAt <= ?",
      now - deliveryTimeout,
    )
  }
}
