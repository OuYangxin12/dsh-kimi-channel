/** Durable conversation map and in-memory replay buffer for the Kimi channel. */
import fs from 'node:fs'
import path from 'node:path'
import { eventFrame } from './protocol.mjs'

/**
 * `conversationKey -> {sessionId, cwd, createdAt}` persisted as JSON 0600.
 * Writes are atomic (temp file + rename) so a crash never leaves a torn map.
 */
export class SessionMap {
  /**
   * @param {string} file absolute path.
   */
  constructor(file) {
    this.file = file
    /** @type {Map<string, {sessionId: string, cwd: string, createdAt: number}>} */
    this.entries = new Map()
    this.loaded = false
  }

  /** Read the file when it exists; a corrupt file starts empty and is reported. */
  load() {
    this.loaded = true
    let raw
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return this
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.corrupt = true
      return this
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.corrupt = true
      return this
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue
      const { sessionId, cwd, createdAt } = /** @type {Record<string, unknown>} */ (value)
      if (typeof sessionId !== 'string' || typeof cwd !== 'string') continue
      this.entries.set(key, { sessionId, cwd, createdAt: Number(createdAt) || Date.now() })
    }
    return this
  }

  /**
   * @param {string} key
   * @returns {{sessionId: string, cwd: string, createdAt: number} | undefined}
   */
  get(key) {
    if (!this.loaded) this.load()
    const value = this.entries.get(key)
    return value ? { ...value } : undefined
  }

  /**
   * Record one conversation mapping and persist the whole map.
   * @param {string} key
   * @param {{sessionId: string, cwd: string, createdAt?: number}} value
   */
  set(key, value) {
    if (!this.loaded) this.load()
    this.entries.set(key, { ...value, createdAt: value.createdAt ?? Date.now() })
    this.save()
  }

  /** @param {string} key */
  delete(key) {
    if (!this.loaded) this.load()
    if (!this.entries.delete(key)) return false
    this.save()
    return true
  }

  /** Persist the current map atomically with 0600 permissions. */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const payload = JSON.stringify(Object.fromEntries(this.entries), null, 2)
    const temporary = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${payload}\n`, { mode: 0o600 })
    fs.renameSync(temporary, this.file)
    fs.chmodSync(this.file, 0o600)
  }

  /** @returns {Record<string, {sessionId: string, cwd: string, createdAt: number}>} */
  toJSON() {
    return Object.fromEntries(this.entries)
  }
}

/**
 * Fixed-size ring of emitted event frames, addressed by a monotonic `seq`.
 * `events.resume` replays from here after a reconnect.
 */
export class EventBuffer {
  /** @param {number} capacity */
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new TypeError('capacity must be a positive integer')
    /** @type {Array<object>} */
    this.frames = []
    this.capacity = capacity
    this.seq = 0
  }

  /**
   * Assign the next sequence number and keep the frame.
   * @param {string} event
   * @param {unknown} data
   * @param {string} [conversationKey]
   * @returns {object} the frame with its assigned seq.
   */
  push(event, data, conversationKey) {
    this.seq += 1
    const frame = eventFrame(this.seq, event, data, conversationKey)
    this.frames.push(frame)
    if (this.frames.length > this.capacity) this.frames.splice(0, this.frames.length - this.capacity)
    return frame
  }

  /**
   * Frames strictly after `since`, oldest first.
   * @param {number} since
   * @param {{limit?: number, conversationKey?: string}} [options]
   */
  since(since, options = {}) {
    const limit = options.limit ?? 500
    const key = options.conversationKey
    const selected = []
    for (const frame of this.frames) {
      if (frame.seq <= since) continue
      if (key !== undefined && frame.conversationKey !== undefined && frame.conversationKey !== key) continue
      selected.push(frame)
      if (selected.length >= limit) break
    }
    return selected
  }

  /** @returns {number} the newest assigned seq (0 before the first event). */
  get lastSeq() {
    return this.seq
  }

  /** Drop every buffered frame while keeping the seq high-water mark. */
  clear() {
    this.frames.length = 0
  }
}

/**
 * Bounded idempotency table: request id + scope -> stored result.
 * A duplicate submission replays the recorded outcome instead of acting again.
 */
export class IdempotencyTable {
  /** @param {number} [capacity] */
  constructor(capacity = 1000) {
    this.capacity = capacity
    /** @type {Map<string, {result?: unknown, error?: unknown, pending?: Promise<unknown>}>} */
    this.entries = new Map()
  }

  /**
   * @param {string} key
   * @returns {{result?: unknown, error?: unknown, pending?: Promise<unknown>} | undefined}
   */
  get(key) {
    return this.entries.get(key)
  }

  /**
   * @param {string} key
   * @param {{result?: unknown, error?: unknown, pending?: Promise<unknown>}} value
   */
  set(key, value) {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      this.entries.delete(oldest)
    }
  }

  /** @param {string} key */
  delete(key) {
    this.entries.delete(key)
  }
}
