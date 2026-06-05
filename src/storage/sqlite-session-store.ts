import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type SessionRecord = {
  id: number
  title: string
  active_provider: string
  model_hint: string | null
  created_at: string
  updated_at: string
}

export type MessageRecord = {
  id: number
  session_id: number
  role: string
  provider: string | null
  model: string | null
  content: string
  metadata: unknown | null
  token_count: number
  parent_message_id: number | null
  created_at: string
}

export type SummaryRecord = {
  session_id: number
  summary_text: string
  summary_version: number
  updated_at: string
}

export type RoutingEventInput = {
  sessionId: number
  fromProvider?: string | null
  toProvider: string
  reason?: string | null
}

export type CreateSessionInput = {
  title: string
  activeProvider: string
  modelHint?: string | null
}

export type UpdateSessionInput = {
  activeProvider?: string
  modelHint?: string | null
}

export type AppendMessageInput = {
  role: string
  provider?: string | null
  model?: string | null
  content: string
  metadata?: unknown | null
  tokenCount?: number
  parentMessageId?: number | null
}

export class SqliteSessionStore {
  private readonly dbPath: string
  private readonly db: Database

  constructor(dbPath: string) {
    this.dbPath = dbPath
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.init()
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        active_provider TEXT NOT NULL,
        model_hint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        content TEXT NOT NULL,
        metadata TEXT,
        token_count INTEGER NOT NULL DEFAULT 0,
        parent_message_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS summaries (
        session_id INTEGER PRIMARY KEY,
        summary_text TEXT NOT NULL,
        summary_version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS routing_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        from_provider TEXT,
        to_provider TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `)
    this.ensureMessageMetadataColumn()
  }

  createSession({ title, activeProvider, modelHint = null }: CreateSessionInput): SessionRecord {
    const now = isoNow()
    const stmt = this.db.prepare(`
      INSERT INTO sessions (title, active_provider, model_hint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    const info = stmt.run(title, activeProvider, modelHint, now, now)
    return this.getSession(Number(info.lastInsertRowid))!
  }

  updateSessionProvider(sessionId: number, activeProvider: string): SessionRecord | null {
    return this.updateSession(sessionId, { activeProvider })
  }

  updateSession(sessionId: number, patch: UpdateSessionInput): SessionRecord | null {
    const current = this.getSession(sessionId)
    if (!current) {
      return null
    }

    const now = isoNow()
    this.db
      .prepare('UPDATE sessions SET active_provider = ?, model_hint = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.activeProvider ?? current.active_provider,
        patch.modelHint ?? current.model_hint,
        now,
        sessionId,
      )
    return this.getSession(sessionId)
  }

  listSessions(): SessionRecord[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC, id DESC')
      .all() as SessionRecord[]
  }

  getSession(sessionId: number): SessionRecord | null {
    return (
      (this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRecord | null) ??
      null
    )
  }

  appendMessage(sessionId: number, message: AppendMessageInput): number {
    const now = isoNow()
    const tokenCount = message.tokenCount ?? estimateTokenCount(message.content)
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        session_id, role, provider, model, content, metadata, token_count, parent_message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const info = stmt.run(
      sessionId,
      message.role,
      message.provider ?? null,
      message.model ?? null,
      message.content,
      message.metadata == null ? null : JSON.stringify(message.metadata),
      tokenCount,
      message.parentMessageId ?? null,
      now,
    )
    this.touchSession(sessionId)
    return Number(info.lastInsertRowid)
  }

  listRecentMessages(sessionId: number, limit = 10): MessageRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(sessionId, limit) as MessageRecord[]
    return rows.reverse().map(decodeMessageRecord)
  }

  setSummary(sessionId: number, summaryText: string, summaryVersion = 1): void {
    const now = isoNow()
    this.db
      .prepare(`
        INSERT INTO summaries (session_id, summary_text, summary_version, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          summary_text = excluded.summary_text,
          summary_version = excluded.summary_version,
          updated_at = excluded.updated_at
      `)
      .run(sessionId, summaryText, summaryVersion, now)
    this.touchSession(sessionId)
  }

  getSummary(sessionId: number): SummaryRecord | null {
    return (
      (this.db.prepare('SELECT * FROM summaries WHERE session_id = ?').get(sessionId) as SummaryRecord | null) ??
      null
    )
  }

  recordRoutingEvent({ sessionId, fromProvider = null, toProvider, reason = null }: RoutingEventInput): void {
    const now = isoNow()
    this.db
      .prepare(`
        INSERT INTO routing_events (session_id, from_provider, to_provider, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(sessionId, fromProvider, toProvider, reason, now)
    this.touchSession(sessionId)
  }

  getSessionBundle(sessionId: number, limit = 10) {
    return {
      session: this.getSession(sessionId),
      summary: this.getSummary(sessionId),
      messages: this.listRecentMessages(sessionId, limit),
    }
  }

  close(): void {
    this.db.close()
  }

  private touchSession(sessionId: number): void {
    const now = isoNow()
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
  }

  private ensureMessageMetadataColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'metadata')) {
      this.db.prepare('ALTER TABLE messages ADD COLUMN metadata TEXT').run()
    }
  }
}

function isoNow(): string {
  return new Date().toISOString()
}

function estimateTokenCount(text: string): number {
  if (typeof text !== 'string' || text.length === 0) {
    return 0
  }

  return Math.max(1, Math.ceil(text.length / 4))
}

function decodeMessageRecord(message: MessageRecord): MessageRecord {
  if (typeof message.metadata !== 'string') {
    return message
  }

  try {
    return {
      ...message,
      metadata: JSON.parse(message.metadata),
    }
  } catch {
    return {
      ...message,
      metadata: null,
    }
  }
}
