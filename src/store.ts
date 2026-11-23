import type { Claim, Delivery, Outcome } from './delivery.ts'

export type HookEvent = Omit<Delivery, 'id'> & { key: string }
type State = 'queued' | 'sending' | 'sent' | 'unknown' | 'suppressed' | 'expired'
type Receipt =
  | { id: string; state: State; duplicate: boolean }
  | { limited: true }
  | { noDestination: true }
type Status = Omit<Delivery, 'text'> & { state: State; createdAt: number }
type Rule = { source: string; paused: boolean; types: string[] }
type SideChat = { name: string; sessionId: string }
type SideChats = { active: string | null; chats: SideChat[] }
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

export class DeliveryQueue {
  private readonly sql: SqlStorage

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly legacySession: string | null,
  ) {
    this.sql = storage.sql
    storage.transactionSync(() => this.initialize())
  }

  private initialize() {
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
        sessionId TEXT,
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
      CREATE TABLE IF NOT EXISTS side_chats (
        name TEXT NOT NULL PRIMARY KEY,
        sessionId TEXT,
        active INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_side_chat ON side_chats(active) WHERE active = 1;
    `)

    // A null session ID in the registry follows the deployment's MUSE_SESSION_ID.
    if (this.legacySession) {
      this.sql.exec(
        "INSERT INTO side_chats VALUES ('default', NULL, NOT EXISTS (SELECT 1 FROM side_chats WHERE active = 1)) ON CONFLICT(name) DO NOTHING",
      )
    } else {
      this.sql.exec('DELETE FROM side_chats WHERE sessionId IS NULL')
    }

    if (
      !this.sql
        .exec<{ name: string }>('PRAGMA table_info(events)')
        .toArray()
        .some((col) => col.name === 'sessionId')
    ) {
      this.sql.exec('ALTER TABLE events ADD COLUMN sessionId TEXT')
      if (this.legacySession) {
        this.sql.exec(
          "UPDATE events SET sessionId = ? WHERE state IN ('queued', 'sending')",
          this.legacySession,
        )
      } else {
        // A new registration must never inherit a backlog whose original destination is unknown.
        this.sql.exec("UPDATE events SET state = 'suppressed', text = '' WHERE state = 'queued'")
        this.sql.exec(
          "UPDATE events SET state = 'unknown', outcome = 'unknown', text = '' WHERE state = 'sending'",
        )
      }
    }
  }

  listSideChats(): SideChats {
    const rows = this.sql
      .exec<
        SideChat & { active: number }
      >('SELECT name, COALESCE(sessionId, ?) AS sessionId, active FROM side_chats ORDER BY name', this.legacySession)
      .toArray()
    return {
      active: rows.find((row) => row.active)?.name ?? null,
      chats: rows.map(({ name, sessionId }) => ({ name, sessionId })),
    }
  }

  registerSideChat(name: string, sessionId: string): SideChats {
    return this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO side_chats (name, sessionId, active)
          VALUES (?, ?, NOT EXISTS (SELECT 1 FROM side_chats WHERE active = 1))
          ON CONFLICT(name) DO UPDATE SET sessionId = excluded.sessionId, active = MAX(side_chats.active, excluded.active)`,
        name,
        sessionId,
      )
      return this.listSideChats()
    })
  }

  setActiveSideChat(name: string): SideChats | null {
    return this.storage.transactionSync(() => {
      if (!this.sql.exec('SELECT 1 FROM side_chats WHERE name = ?', name).toArray().length)
        return null
      this.sql.exec('UPDATE side_chats SET active = 0 WHERE active = 1')
      this.sql.exec('UPDATE side_chats SET active = 1 WHERE name = ?', name)
      return this.listSideChats()
    })
  }

  enqueue(event: HookEvent): Receipt {
    return this.storage.transactionSync(() => {
      const now = Date.now()
      this.prune(now)
      const existing = this.sql
        .exec<{
          id: string
          state: State
        }>('SELECT id, state FROM events WHERE source = ? AND key = ?', event.source, event.key)
        .toArray()[0]
      if (existing) return { ...existing, duplicate: true }

      const target = this.sql
        .exec<{
          sessionId: string
        }>('SELECT COALESCE(sessionId, ?) AS sessionId FROM side_chats WHERE active = 1', this.legacySession)
        .toArray()[0]
      if (!target) return { noDestination: true }

      const { count } = this.sql
        .exec<{
          count: number
        }>(
          'SELECT COUNT(*) AS count FROM events WHERE source = ? AND createdAt > ?',
          event.source,
          now - minute,
        )
        .one()
      if (count >= ingressPerMinute) return { limited: true }

      const id = crypto.randomUUID()
      this.sql.exec(
        "INSERT INTO events(id, source, key, type, text, state, createdAt, sessionId) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)",
        id,
        event.source,
        event.key,
        event.type,
        event.text,
        now,
        target.sessionId,
      )
      this.suppressBlocked(event.source)
      const { state } = this.sql
        .exec<{ state: State }>('SELECT state FROM events WHERE id = ?', id)
        .one()
      return { id, state, duplicate: false }
    })
  }

  nextWakeAt(): number | null {
    const now = Date.now()
    this.prune(now)
    const active = this.sql
      .exec<{ startedAt: number }>("SELECT startedAt FROM events WHERE state = 'sending' LIMIT 1")
      .toArray()[0]
    if (active) return active.startedAt + deliveryTimeout
    if (!this.sql.exec("SELECT 1 FROM events WHERE state = 'queued' LIMIT 1").toArray().length) {
      return null
    }
    const { count, oldest } = this.sql
      .exec<{
        count: number
        oldest: number | null
      }>(
        'SELECT COUNT(*) AS count, MIN(startedAt) AS oldest FROM authorizations WHERE startedAt > ?',
        now - minute,
      )
      .one()
    return count >= deliveriesPerMinute && oldest !== null ? oldest + minute : now
  }

  claim(): Claim | null {
    return this.storage.transactionSync(() => {
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
        .exec<Delivery & { sessionId: string }>(
          `
        SELECT id, source, type, text, sessionId FROM events
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
    return this.storage.transactionSync(() => {
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
    return this.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO rules(source, paused) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET paused = excluded.paused',
        source,
        Number(paused),
      )
      return this.applyRule(source)
    })
  }

  setFilter(source: string, types: string[]): Rule {
    return this.storage.transactionSync(() => {
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
